/**
 * High-level workflow tools — composite operations that make it easy
 * for an LLM to accomplish common tasks in a single call.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AmbiguousAcceptanceError, type TaskResult } from "../bridge-types.js";
import { OpenCodeClient, OpenCodeError } from "../client.js";
import {
  formatMessageResponse,
  formatMessageList,
  isProviderConfigured,
  redactSecrets,
  toolResult,
  toolError,
  directoryParam,
  readOnly,
} from "../helpers.js";
import {
  buildPromptBody,
  assertModelPolicy,
  resolveConfiguredModel,
} from "../model-selection.js";
import {
  assertSessionDirectory,
  createDeadline,
  remainingBudgetMs,
  validateDirectory,
  validateDurationSeconds,
  validateIntervalMs,
} from "../request-context.js";
import {
  checkToolIsError,
  fireToolIsError,
  formatTaskResult,
  runToolIsError,
  waitToolIsError,
} from "../task-result-format.js";
import { getSharedTaskManager, type TaskSelector } from "../task-manager.js";
import { normalizeRawSessionState } from "../task-status.js";
import { analyzeTypedMessage } from "../typed-outcome.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resolveWorkflowModel(providerID?: string, modelID?: string) {
  return resolveConfiguredModel({ providerID, modelID });
}

function sessionDirectoryOf(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  return typeof payload.directory === "string" ? payload.directory : undefined;
}

function taskSelector(input: {
  jobId?: string;
  sessionId?: string;
  requestMessageID?: string;
  directory?: string;
}): TaskSelector {
  if (!input.jobId && !input.sessionId) {
    throw new Error("Provide jobId or sessionId.");
  }
  if (input.jobId) {
    const selector: { jobId: string; sessionId?: string; requestMessageID?: string; directory?: string } = {
      jobId: input.jobId,
    };
    if (input.sessionId) selector.sessionId = input.sessionId;
    if (input.requestMessageID) selector.requestMessageID = input.requestMessageID;
    if (input.directory) selector.directory = input.directory;
    return selector;
  }
  if (input.requestMessageID) {
    return {
      sessionId: input.sessionId!,
      requestMessageID: input.requestMessageID,
      ...(input.directory ? { directory: input.directory } : {}),
    };
  }
  return {
    sessionId: input.sessionId!,
    ...(input.directory ? { directory: input.directory } : {}),
  };
}

function providerEntries(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
  if (isRecord(raw) && Array.isArray(raw.all)) {
    return raw.all as Array<Record<string, unknown>>;
  }
  if (isRecord(raw) && Array.isArray(raw.providers)) {
    return raw.providers as Array<Record<string, unknown>>;
  }
  return [];
}

function defaultModelForProvider(
  raw: unknown,
  providerId: string,
): string | undefined {
  if (isRecord(raw) && isRecord(raw.default)) {
    const mapped = raw.default[providerId];
    if (typeof mapped === "string" && mapped.length > 0) return mapped;
  }
  const provider = providerEntries(raw).find(
    (entry) => entry.id === providerId || entry.name === providerId,
  );
  if (!provider) return undefined;
  for (const key of ["default", "defaultModel", "defaultModelID"] as const) {
    const value = provider[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  const models = provider.models;
  if (isRecord(models) && !Array.isArray(models)) {
    for (const [id, spec] of Object.entries(models)) {
      if (isRecord(spec) && spec.default === true && id) return id;
    }
  }
  if (Array.isArray(models)) {
    for (const spec of models) {
      if (isRecord(spec) && spec.default === true && typeof spec.id === "string") {
        return spec.id;
      }
    }
  }
  return undefined;
}

function observedModelFromMessage(
  response: unknown,
): { providerID: string; modelID: string } | null {
  if (!isRecord(response)) return null;
  const info = isRecord(response.info) ? response.info : response;
  const providerID = info.providerID;
  const modelID = info.modelID;
  if (typeof providerID === "string" && typeof modelID === "string") {
    return { providerID, modelID };
  }
  return null;
}

function isAmbiguousOrTimeout(error: unknown): boolean {
  if (error instanceof AmbiguousAcceptanceError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|aborted/i.test(message);
}

function isKnownClientReject(error: unknown): boolean {
  return error instanceof OpenCodeError && error.status >= 400 && error.status < 500;
}

function summarizeTask(result: TaskResult, kind: "fire" | "run" | "wait"): string {
  const session = result.sessionId ?? "(unknown session)";
  const lines: string[] = [];
  if (kind === "fire") {
    if (result.state === "failed" || result.state === "aborted") {
      lines.push(`Task ${result.state} for session: ${session}`);
      lines.push(`Job: ${result.jobId}`);
      lines.push("This is not ongoing autonomous work.");
    } else if (result.submissionState === "accepted" && result.terminal !== true) {
      lines.push(`Task dispatched to session: ${session}`);
      lines.push(`Job: ${result.jobId}`);
      lines.push("");
      lines.push("OpenCode is now working autonomously. Use these tools to monitor:");
      lines.push(`- \`opencode_check({ jobId: "${result.jobId}" })\` — quick progress check`);
      lines.push(`- \`opencode_wait({ jobId: "${result.jobId}" })\` — block until done`);
      if (result.sessionId) {
        lines.push(`- \`opencode_session_todo({id: "${result.sessionId}"})\` — see the agent's task list`);
        lines.push(`- \`opencode_review_changes({sessionId: "${result.sessionId}"})\` — see file changes after completion`);
      }
    } else {
      lines.push(`Task submission ${result.submissionState} for session: ${session}`);
      lines.push(`Job: ${result.jobId}`);
      if (result.safeToResubmit === false) {
        lines.push("safeToResubmit: false — do not resend this prompt automatically.");
      }
    }
  } else {
    if (result.directory) lines.push(`Directory: ${result.directory}`);
    lines.push(`Session: ${session}`);
    if (result.jobId) lines.push(`Job: ${result.jobId}`);
    lines.push(
      `Status: ${result.state}${result.waitOutcome ? ` (${result.waitOutcome})` : ""}`,
    );
    if (result.tracking === "untracked") {
      lines.push("Tracking: untracked. Do not claim this particular task succeeded.");
    }
    if (result.content) {
      lines.push("", result.content);
    }
    if (result.pendingRequests.length > 0) {
      lines.push("", "Pending requests:");
      for (const pending of result.pendingRequests) {
        lines.push(`- ${pending.kind} ${pending.requestId}: ${pending.summary}`);
      }
    }
    if (result.waitOutcome === "timed_out") {
      lines.push("Timed out. Check this job; do not submit it again.");
    }
  }
  if (result.nextAction) {
    lines.push("", result.nextAction);
  }
  return lines.join("\n");
}

function toolFromTask(summary: string, result: TaskResult, isError: boolean) {
  return toolResult(formatTaskResult(summary, result), isError);
}

export function registerWorkflowTools(
  server: McpServer,
  client: OpenCodeClient,
) {
  // ─── Setup / onboarding ───────────────────────────────────────────
  server.tool(
    "opencode_setup",
    "Check OpenCode status, provider configuration, and optionally initialize a project directory. Use this as the first step when starting work — it tells you what is ready and what still needs configuration.",
    {
      directory: directoryParam,
    },
    readOnly,
    async ({ directory }) => {
      try {
        const sections: string[] = [];

        // 1. Health check
        let healthy = false;
        try {
          const health = (await client.get("/global/health", undefined, directory)) as Record<string, unknown>;
          healthy = true;
          sections.push(
            `## Server\nStatus: healthy\nVersion: ${health.version ?? "unknown"}`,
          );
        } catch (e) {
          sections.push(
            `## Server\nStatus: UNREACHABLE — is \`opencode serve\` running?\nError: ${e instanceof Error ? e.message : String(e)}`,
          );
        }

        if (!healthy) {
          return toolResult(sections.join("\n\n"));
        }

        // 2. Providers — categorize by readiness
        try {
          const raw = await client.get("/provider", undefined, directory);
          const providers = (
            raw && typeof raw === "object" && "all" in (raw as Record<string, unknown>)
              ? (raw as Record<string, unknown>).all
              : raw
          ) as Array<Record<string, unknown>>;

          if (Array.isArray(providers) && providers.length > 0) {
            // Fetch auth methods for richer guidance
            let authMethods: Record<string, unknown> | null = null;
            try {
              authMethods = (await client.get("/provider/auth", undefined, directory)) as Record<string, unknown>;
            } catch { /* non-critical */ }

            // Helper to count models
            const countModels = (p: Record<string, unknown>) => {
              const m = p.models;
              return Array.isArray(m) ? m.length : m && typeof m === "object" ? Object.keys(m).length : 0;
            };

            const ready = providers.filter(isProviderConfigured);
            const withOAuth = providers.filter(
              (p) => !ready.includes(p) && authMethods && Array.isArray(authMethods[p.id as string]),
            );

            // Popular providers worth highlighting (have free tiers or are well-known)
            const popularIds = new Set([
              "anthropic", "openai", "google", "firmware", "openrouter",
              "groq", "deepseek", "huggingface", "github-copilot", "mistral",
            ]);
            const popular = providers.filter(
              (p) => !ready.includes(p) && popularIds.has(p.id as string),
            );
            const otherCount = providers.length - ready.length - popular.length;

            const providerLines: string[] = [];

            // Section: Ready to use
            if (ready.length > 0) {
              providerLines.push("**Ready to use:**");
              for (const p of ready) {
                const id = p.id as string;
                const name = p.name as string;
                const mc = countModels(p);
                const envVars = (p.env as string[])?.join(", ") ?? "";
                providerLines.push(`- ${id} (${name}): detected via ${envVars} — ${mc} models`);
              }
            } else {
              providerLines.push("**No providers configured yet.** You need at least one to start using OpenCode.");
            }

            // Section: Quick setup options
            providerLines.push("");
            providerLines.push("**Quick setup options:**");
            for (const p of popular) {
              const id = p.id as string;
              const name = p.name as string;
              const mc = countModels(p);
              const envVars = (p.env as string[]) ?? [];
              const envHint = envVars.length > 0 ? `set ${envVars[0]}` : "";

              // Check for OAuth
              const oauthAvailable = authMethods && Array.isArray(authMethods[id]);
              const methods: string[] = [];
              if (oauthAvailable) {
                const labels = (authMethods![id] as Array<Record<string, unknown>>)
                  .filter((m) => m.type === "oauth")
                  .map((m) => m.label as string);
                if (labels.length > 0) methods.push(`OAuth (${labels[0]})`);
              }
              if (envHint) methods.push(`\`opencode_auth_set\` or env var \`${envVars[0]}\``);

              // Check for free models
              const rawModels = p.models;
              const modelValues = rawModels && typeof rawModels === "object" && !Array.isArray(rawModels)
                ? Object.values(rawModels as Record<string, unknown>)
                : Array.isArray(rawModels) ? rawModels : [];
              const hasFree = modelValues.some(
                (m) => {
                  const cost = (m as Record<string, unknown>).cost as Record<string, unknown> | undefined;
                  return cost && cost.input === 0 && cost.output === 0;
                },
              );
              const freeTag = hasFree ? " [has free models]" : "";

              providerLines.push(`- ${id} (${name}): ${mc} models${freeTag} — ${methods.join(" or ")}`);
            }

            // Mention OAuth-only providers not already listed
            const oauthOnly = withOAuth.filter((p) => !popular.includes(p) && !ready.includes(p));
            if (oauthOnly.length > 0) {
              const names = oauthOnly.map((p) => `${p.id}`).join(", ");
              providerLines.push(`- Also available via OAuth: ${names}`);
            }

            if (otherCount > 0) {
              providerLines.push(`\n+${otherCount} more providers available. Use \`opencode_provider_list\` to see all.`);
            }

            sections.push(`## Providers (${providers.length} available)\n${providerLines.join("\n")}`);
          } else {
            sections.push("## Providers\nNo providers found. Is the server running correctly?");
          }
        } catch {
          sections.push("## Providers\nCould not fetch provider list.");
        }

        // 3. Project info (if directory given or from default)
        try {
          const project = (await client.get("/project/current", undefined, directory)) as Record<string, unknown>;
          const worktree = (project.worktree ?? "unknown") as string;
          // Derive a readable name: prefer project.name, then last dir component from worktree, then id
          const name = project.name
            ?? (worktree !== "unknown" ? worktree.split("/").filter(Boolean).pop() : null)
            ?? project.id
            ?? "unknown";
          const vcs = project.vcs ?? "none";
          sections.push(
            `## Project\nName: ${name}\nPath: ${worktree}\nVCS: ${vcs}`,
          );
        } catch {
          if (directory) {
            sections.push(
              `## Project\nDirectory: ${directory}\nNote: Could not load project info. Make sure the directory exists and contains a git repository.`,
            );
          } else {
            sections.push(
              "## Project\nNo project context available (no directory specified and server has no default project).",
            );
          }
        }

        // 4. Context-dependent next steps
        const tips: string[] = [];
        const hasReady = sections.some((s) => s.includes("**Ready to use:**"));
        const hasProject = sections.some((s) => s.startsWith("## Project\nName:"));

        if (!hasReady) {
          // No providers configured — guide them to set one up
          tips.push("**You need to configure a provider first.** Options:");
          tips.push("1. Set an API key: `opencode_auth_set` with providerId (e.g. 'anthropic', 'openai', 'google')");
          tips.push("2. Set an env var (e.g. `OPENROUTER_API_KEY`, `HF_TOKEN`, `ANTHROPIC_API_KEY`) and restart opencode");
          tips.push("3. Try **firmware** — it has 23 free models, no API key needed. Use `opencode_ask` with `providerID: 'firmware'`");
        } else {
          // Providers ready — guide to first task
          tips.push("**You're ready to go!** Try:");
          tips.push("- `opencode_ask` — ask a question or give an instruction (easiest way to start)");
          if (!hasProject) {
            tips.push("- Pass a `directory` parameter to target a specific project");
          }
          tips.push("- `opencode_context` — get full project context (config, VCS, agents)");
          tips.push("- `opencode_provider_models` — explore available models for your configured providers");
        }
        sections.push(`## Next Steps\n${tips.join("\n")}`);

        return toolResult(sections.join("\n\n"));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── One-shot: create session + send prompt + return answer ─────────
  server.tool(
    "opencode_ask",
    "Ask OpenCode a question in one step. Creates a new session, sends your prompt, and returns the AI response. This is the easiest way to interact with OpenCode.",
    {
      prompt: z.string().describe("The question or instruction to send"),
      title: z
        .string()
        .optional()
        .describe("Optional title for the session"),
      providerID: z
        .string()
        .optional()
        .describe("Provider ID (e.g. 'anthropic')"),
      modelID: z
        .string()
        .optional()
        .describe("Model ID (e.g. 'claude-3-5-sonnet-20241022')"),
      variant: z.string().optional().describe("Model variant (e.g. 'fast', 'smart')"),
      agent: z
        .string()
        .optional()
        .describe("Agent to use (e.g. 'build', 'plan')"),
      system: z
        .string()
        .optional()
        .describe("Optional system prompt override"),
      directory: directoryParam,
    },
    async ({ prompt, title, providerID, modelID, variant, agent, system, directory }, extra) => {
      try {
        const model = resolveWorkflowModel(providerID, modelID);

        // 1. Create session
        const session = (await client.post("/session", {
          title: title ?? prompt.slice(0, 80),
        }, { directory })) as Record<string, unknown>;
        const sessionId = session.id as string;

        const body = buildPromptBody({
          prompt,
          model,
          variant,
          agent,
          system,
        });

        const response = await getSharedTaskManager(client).withSessionTurn(
          { sessionId, directory },
          () =>
            client.post(`/session/${sessionId}/message`, body, {
              directory,
              signal: extra?.signal,
            }),
        );

        // 3. Analyze for auth / empty response issues
        const analysis = analyzeTypedMessage(response);

        // 4. Format and return
        const formatted = formatMessageResponse(response);
        const dirLabel = directory ? `Directory: ${directory}` : "Directory: (server default)";
        const parts = [`${dirLabel}\nSession: ${sessionId}`];
        if (formatted) parts.push(formatted);
        if (analysis.warning) {
          parts.push(`\n--- WARNING ---\n${analysis.warning}`);
        }
        return toolResult(parts.join("\n\n"), analysis.hasError);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Continue a conversation ────────────────────────────────────────
  server.tool(
    "opencode_reply",
    "Send a follow-up message to an existing session. Use this to continue a conversation started with opencode_ask or opencode_session_create.",
    {
      sessionId: z.string().describe("Session ID to reply in"),
      prompt: z.string().describe("The follow-up message"),
      providerID: z.string().optional().describe("Provider ID"),
      modelID: z.string().optional().describe("Model ID"),
      variant: z.string().optional().describe("Model variant"),
      agent: z.string().optional().describe("Agent to use"),
      directory: directoryParam,
    },
    async ({ sessionId, prompt, providerID, modelID, variant, agent, directory }, extra) => {
      try {
        const model = resolveWorkflowModel(providerID, modelID);
        if (directory) {
          const session = await client.get(
            `/session/${sessionId}`,
            undefined,
            directory,
          );
          assertSessionDirectory({
            requestedDirectory: directory,
            sessionDirectory: sessionDirectoryOf(session),
          });
        }

        const body = buildPromptBody({
          prompt,
          model,
          variant,
          agent,
        });

        const response = await getSharedTaskManager(client).withSessionTurn(
          { sessionId, directory },
          () =>
            client.post(`/session/${sessionId}/message`, body, {
              directory,
              signal: extra?.signal,
            }),
        );

        const analysis = analyzeTypedMessage(response);
        const formatted = formatMessageResponse(response);
        const parts: string[] = [];
        if (formatted) parts.push(formatted);
        if (analysis.warning) {
          parts.push(`\n--- WARNING ---\n${analysis.warning}`);
        }
        // Session-directory consistency note
        if (sessionId && directory) {
          parts.push(`\n_Note: Using session ${sessionId} in directory ${directory}. Ensure this session belongs to this project._`);
        }
        return toolResult(
          parts.join("\n\n") || "Empty response.",
          analysis.hasError,
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Get conversation history (formatted) ──────────────────────────
  server.tool(
    "opencode_conversation",
    "Get the full conversation history of a session, formatted for easy reading. Shows all messages with their roles and content.",
    {
      sessionId: z.string().describe("Session ID"),
      limit: z
        .number()
        .optional()
        .describe("Max messages to return (default: all)"),
      directory: directoryParam,
    },
    readOnly,
    async ({ sessionId, limit, directory }) => {
      try {
        const query: Record<string, string> = {};
        if (limit !== undefined) query.limit = String(limit);
        const messages = await client.get(
          `/session/${sessionId}/message`,
          query,
          directory,
        );
        const formatted = formatMessageList(
          messages as unknown[],
        );
        return toolResult(formatted);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Quick session overview ────────────────────────────────────────
  server.tool(
    "opencode_sessions_overview",
    "Get a quick overview of all sessions with their titles and status. Useful to find which session to continue working in.",
    {
      directory: directoryParam,
    },
    readOnly,
    async ({ directory }) => {
      try {
        const [sessions, statuses] = await Promise.all([
          client.get("/session", undefined, directory) as Promise<Array<Record<string, unknown>>>,
          client.get("/session/status", undefined, directory) as Promise<Record<string, unknown>>,
        ]);

        if (!sessions || sessions.length === 0) {
          return toolResult("No sessions found.");
        }

        // Merge status and show enriched overview
        const lines = sessions.map((s) => {
          const id = s.id ?? "?";
          const title = s.title ?? "(untitled)";
          const status = normalizeRawSessionState(statuses, String(id));
          const parentTag = s.parentID ? ` (child of ${s.parentID})` : "";
          return `- [${status}] ${title} [${id}]${parentTag}`;
        });

        return toolResult(
          `## Sessions (${sessions.length})\n${lines.join("\n")}`,
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Project context ──────────────────────────────────────────────
  server.tool(
    "opencode_context",
    "Get full project context in one call: current project, path, VCS info, config, and available agents. Useful to understand the current state before starting work.",
    {
      directory: directoryParam,
    },
    readOnly,
    async ({ directory }) => {
      try {
        // Validate directory early — before Promise.all with .catch(() => null)
        // swallows the validation error.
        directory = validateDirectory(directory) as typeof directory;

        const [project, path, vcs, config, agents] = await Promise.all([
          client.get("/project/current", undefined, directory).catch(() => null),
          client.get("/path", undefined, directory).catch(() => null),
          client.get("/vcs", undefined, directory).catch(() => null),
          client.get("/config", undefined, directory).catch(() => null),
          client.get("/agent", undefined, directory).catch(() => null),
        ]);

        const sections: string[] = [];

        if (project) {
          const p = project as Record<string, unknown>;
          const worktree = (p.worktree ?? "unknown") as string;
          const name = p.name
            ?? (worktree !== "unknown" ? worktree.split("/").filter(Boolean).pop() : null)
            ?? p.id ?? "unknown";
          const lines = [`Name: ${name}`, `Path: ${worktree}`];
          if (p.vcs) lines.push(`VCS: ${p.vcs}`);
          if (p.id) lines.push(`ID: ${p.id}`);
          sections.push(`## Project\n${lines.join("\n")}`);
        }
        if (path) {
          const pp = path as Record<string, unknown>;
          const workDir = pp.worktree ?? pp.directory ?? pp.cwd ?? pp.path;
          const pathLines: string[] = [];
          if (workDir) pathLines.push(`Working directory: ${workDir}`);
          if (pp.config && pp.config !== workDir) pathLines.push(`Config: ${pp.config}`);
          if (pp.state && pp.state !== workDir) pathLines.push(`State: ${pp.state}`);
          if (pp.home && pp.home !== workDir) pathLines.push(`Home: ${pp.home}`);
          if (pathLines.length === 0) pathLines.push(`Working directory: ${JSON.stringify(pp)}`);
          sections.push(`## Path\n${pathLines.join("\n")}`);
        }
        if (vcs) {
          const v = vcs as Record<string, unknown>;
          const lines: string[] = [];
          if (v.branch) lines.push(`Branch: ${v.branch}`);
          if (v.remote) lines.push(`Remote: ${v.remote}`);
          if (v.sha) lines.push(`HEAD: ${v.sha}`);
          if (v.dirty !== undefined) lines.push(`Dirty: ${v.dirty}`);
          sections.push(`## VCS (Git)\n${lines.length > 0 ? lines.join("\n") : "No VCS info available."}`);
        }
        if (config) {
          // Show config summary with secrets redacted — skip overwhelming nested objects
          const c = redactSecrets(config) as Record<string, unknown>;
          const topLevel: string[] = [];
          for (const [k, v] of Object.entries(c)) {
            if (v && typeof v === "object" && !Array.isArray(v)) {
              const keys = Object.keys(v as Record<string, unknown>);
              topLevel.push(`${k}: {${keys.length} entries}`);
            } else if (Array.isArray(v)) {
              topLevel.push(`${k}: [${v.length} items]`);
            } else {
              topLevel.push(`${k}: ${v}`);
            }
          }
          sections.push(`## Config\n${topLevel.join("\n")}`);
        }
        if (agents) {
          const agentList = agents as Array<Record<string, unknown>>;
          sections.push(
            `## Agents (${agentList.length})\n${agentList.map((a) => `- ${a.name ?? a.id}: ${a.description ?? "(no description)"} [${a.mode ?? "?"}]`).join("\n")}`,
          );
        }

        return toolResult(sections.join("\n\n"));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Wait for async session to complete ───────────────────────────
  server.tool(
    "opencode_wait",
    "Wait until a tracked job or session turn reaches a terminal, blocked, or timed-out state. Idle session status alone is not completion. Prefer jobId from opencode_fire / opencode_run.",
    {
      sessionId: z.string().optional().describe("Session ID to wait on"),
      jobId: z.string().optional().describe("Bridge job ID returned by opencode_fire or opencode_run"),
      requestMessageID: z
        .string()
        .optional()
        .describe("User message ID to correlate when jobId is not available"),
      timeoutSeconds: z
        .number()
        .optional()
        .describe("Max seconds to wait (default: 120, max: 3600)."),
      pollIntervalMs: z
        .number()
        .optional()
        .describe("Polling interval in ms (default: 250)"),
      directory: directoryParam,
    },
    async ({ sessionId, jobId, requestMessageID, timeoutSeconds, pollIntervalMs, directory }, extra) => {
      try {
        const deadlineAt = createDeadline(
          validateDurationSeconds(timeoutSeconds, 120, 3600) * 1000,
        );
        const selector = taskSelector({ jobId, sessionId, requestMessageID, directory });
        const interval =
          pollIntervalMs !== undefined
            ? validateIntervalMs(pollIntervalMs, 250, 60_000)
            : undefined;
        const manager = getSharedTaskManager(client);
        const result = await manager.wait(selector, {
          deadlineAt,
          signal: extra?.signal,
          ...(interval !== undefined ? { pollIntervalMs: interval } : {}),
        });
        return toolFromTask(summarizeTask(result, "wait"), result, waitToolIsError(result));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Review changes ────────────────────────────────────────────────
  server.tool(
    "opencode_review_changes",
    "Get a formatted summary of all file changes made in a session. Shows diffs in a readable format.",
    {
      sessionId: z.string().describe("Session ID"),
      messageID: z
        .string()
        .optional()
        .describe("Specific message ID to get diff for"),
      directory: directoryParam,
    },
    readOnly,
    async ({ sessionId, messageID, directory }) => {
      try {
        const query: Record<string, string> = {};
        if (messageID) query.messageID = messageID;
        const diffs = await client.get(`/session/${sessionId}/diff`, query, directory);
        const { formatDiffResponse } = await import("../helpers.js");
        return toolResult(formatDiffResponse(diffs as unknown[]));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Provider test ────────────────────────────────────────────────
  server.tool(
    "opencode_provider_test",
    "Quick-test whether a provider is working. Creates a temporary session, sends a trivial prompt, checks the response, and cleans up. Great for debugging auth issues.",
    {
      providerId: z.string().describe("Provider ID to test (e.g. 'anthropic', 'openrouter')"),
      modelID: z.string().optional().describe("Specific model ID to test. If omitted, uses provider default."),
      variant: z.string().optional().describe("Model variant"),
      directory: directoryParam,
    },
    async ({ providerId, modelID, variant, directory }) => {
      let sessionId: string | null = null;
      try {
        let model = modelID
          ? resolveWorkflowModel(providerId, modelID)
          : undefined;
        if (!model) {
          const providers = await client.get("/provider", undefined, directory);
          const resolvedModelID = defaultModelForProvider(providers, providerId);
          if (!resolvedModelID) {
            return toolError(
              new Error(
                `Could not resolve a default model for provider "${providerId}". ` +
                  "Pass modelID for that provider, or configure the provider's default. " +
                  "Another provider's default will not be used.",
              ),
            );
          }
          try {
            model = assertModelPolicy({
              providerID: providerId,
              modelID: resolvedModelID,
            });
          } catch (error) {
            return toolError(error);
          }
        }

        const session = (await client.post("/session", {
          title: `[probe] ${providerId}/${model.modelID}`,
        }, { directory })) as Record<string, unknown>;
        sessionId = session.id as string;

        const body = buildPromptBody({
          prompt: "Say hello in one word.",
          model,
          variant,
        });

        const response = await client.post(
          `/session/${sessionId}/message`,
          body,
          { directory },
        );

        const analysis = analyzeTypedMessage(response);
        const formatted = formatMessageResponse(response);
        const observed = observedModelFromMessage(response);
        const mismatch =
          !observed ||
          observed.providerID !== model.providerID ||
          observed.modelID !== model.modelID;

        const establishedTerminal =
          analysis.hasError || !analysis.isEmpty || analysis.hasNonTextContent;
        if (establishedTerminal) {
          try {
            await client.delete(`/session/${sessionId}`, undefined, directory);
          } catch { /* best-effort cleanup after a known terminal outcome */ }
        }

        if (analysis.hasError || (analysis.isEmpty && !analysis.hasNonTextContent) || mismatch) {
          const reason = mismatch
            ? `MODEL MISMATCH: expected ${model.providerID}/${model.modelID}` +
              (observed
                ? `, observed ${observed.providerID}/${observed.modelID}.`
                : ", but the response did not include providerID/modelID.")
            : (analysis.warning ?? "Unknown error — no response received.");
          return toolResult(
            `Provider "${providerId}" FAILED.\n\n${reason}` +
              (!establishedTerminal && sessionId
                ? `\n\nSession ${sessionId} was kept for diagnosis.`
                : ""),
            true,
          );
        }

        const preview = formatted.length > 200 ? formatted.slice(0, 200) + "..." : formatted;
        return toolResult(
          `Provider "${providerId}" is working.\n\nResponse: ${preview}`,
        );
      } catch (e) {
        if (sessionId && isKnownClientReject(e)) {
          try {
            await client.delete(`/session/${sessionId}`, undefined, directory);
          } catch { /* best-effort cleanup */ }
        }
        const err = toolError(e);
        if (sessionId && (isAmbiguousOrTimeout(e) || !isKnownClientReject(e))) {
          return toolResult(
            `${err.content[0].text}\n\nSession ${sessionId} was kept for diagnosis.`,
            true,
          );
        }
        return err;
      }
    },
  );

  // ─── Run: create session + async send + poll until done ──────────
  server.tool(
    "opencode_run",
    "Send a task to OpenCode and wait for completion. Combines session creation, async prompt, and polling into a single tool call. Use this instead of the manual opencode_message_send_async + opencode_wait pattern.",
    {
      prompt: z.string().describe("The task or instruction to send"),
      sessionId: z
        .string()
        .optional()
        .describe("Existing session ID to continue (omit to create a new session)"),
      title: z.string().optional().describe("Session title (only for new sessions)"),
      providerID: z.string().optional().describe("Provider ID (e.g. 'anthropic')"),
      modelID: z.string().optional().describe("Model ID (e.g. 'claude-opus-4-6')"),
      variant: z.string().optional().describe("Model variant"),
      agent: z.string().optional().describe("Agent to use"),
      maxDurationSeconds: z
        .number()
        .optional()
        .describe("Max seconds to wait for completion (default: 600 = 10 minutes)"),
      directory: directoryParam,
    },
    async ({ prompt, sessionId, title, providerID, modelID, variant, agent, maxDurationSeconds, directory }, extra) => {
      try {
        const deadlineAt = createDeadline(
          validateDurationSeconds(maxDurationSeconds, 600, 3600) * 1000,
        );
        const manager = getSharedTaskManager(client);
        const submitted = await manager.submitAsync({
          prompt,
          sessionId,
          title: title ?? (sessionId ? undefined : prompt.slice(0, 80)),
          providerID,
          modelID,
          variant,
          agent,
          directory,
          deadlineAt,
          signal: extra?.signal,
        });
        if (submitted.submissionState !== "accepted" || submitted.terminal === true) {
          const early =
            submitted.terminal === true && submitted.submissionState === "accepted"
              ? { ...submitted, waitOutcome: submitted.waitOutcome ?? "completed" }
              : submitted;
          return toolFromTask(
            summarizeTask(early, "run"),
            early,
            runToolIsError(early),
          );
        }
        const waited = await manager.wait({ jobId: submitted.jobId }, {
          deadlineAt,
          signal: extra?.signal,
        });
        return toolFromTask(summarizeTask(waited, "run"), waited, runToolIsError(waited));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Fire: send task and return immediately ────────────────────────
  server.tool(
    "opencode_fire",
    "Fire-and-forget: send a task to OpenCode and return immediately. OpenCode works autonomously in the background. Use `opencode_check` to check progress anytime. Best for long-running tasks when you want to do other work in parallel.",
    {
      prompt: z.string().describe("The task or instruction to send"),
      sessionId: z
        .string()
        .optional()
        .describe("Existing session ID to continue (omit to create a new session)"),
      title: z.string().optional().describe("Session title (only for new sessions)"),
      providerID: z.string().optional().describe("Provider ID (e.g. 'anthropic')"),
      modelID: z.string().optional().describe("Model ID (e.g. 'claude-opus-4-6')"),
      variant: z.string().optional().describe("Model variant"),
      agent: z.string().optional().describe("Agent to use"),
      directory: directoryParam,
    },
    async ({ prompt, sessionId, title, providerID, modelID, variant, agent, directory }, extra) => {
      try {
        const deadlineAt = createDeadline(
          validateDurationSeconds(undefined, 30, 120) * 1000,
        );
        const manager = getSharedTaskManager(client);
        const result = await manager.submitAsync({
          prompt,
          sessionId,
          title: title ?? (sessionId ? undefined : prompt.slice(0, 80)),
          providerID,
          modelID,
          variant,
          agent,
          directory,
          deadlineAt,
          signal: extra?.signal,
        });
        return toolFromTask(summarizeTask(result, "fire"), result, fireToolIsError(result));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Check: cheap progress report for a session ────────────────────
  server.tool(
    "opencode_check",
    "Get a compact progress report for a job or session. Prefer jobId from opencode_fire / opencode_run. Session-only checks are untracked — idle is not Done.",
    {
      sessionId: z.string().optional().describe("Session ID to check"),
      jobId: z.string().optional().describe("Bridge job ID returned by opencode_fire or opencode_run"),
      requestMessageID: z
        .string()
        .optional()
        .describe("User message ID to correlate when jobId is not available"),
      detailed: z
        .boolean()
        .optional()
        .describe("If true, include the last message text (default: false)"),
      directory: directoryParam,
    },
    readOnly,
    async ({ sessionId, jobId, requestMessageID, detailed, directory }, extra) => {
      try {
        const dir = validateDirectory(directory);
        const selector = taskSelector({
          jobId,
          sessionId,
          requestMessageID,
          directory: dir,
        });
        const manager = getSharedTaskManager(client);
        const deadlineAt = createDeadline(15_000);
        const result = await manager.check(selector, {
          deadlineAt,
          signal: extra?.signal,
        });
        const sid = result.sessionId ?? sessionId;
        const scopedDir = result.directory ?? dir;

        const lines: string[] = [];
        let title = "(untitled)";
        if (sid) {
          try {
            const sessionInfo = (await client.get(
              `/session/${sid}`,
              undefined,
              scopedDir,
            )) as Record<string, unknown> | null;
            if (sessionInfo && typeof sessionInfo.title === "string") {
              title = sessionInfo.title;
            }
          } catch { /* optional enrichment */ }
          lines.push(`## ${title} [${sid}]`);
        } else {
          lines.push(`## Job ${result.jobId}`);
        }
        lines.push(
          `Status: **${result.state}** (raw: ${result.rawSessionState ?? "n/a"}, tracking: ${result.tracking})`,
        );
        lines.push(`Job: ${result.jobId}`);
        if (result.tracking === "untracked") {
          lines.push("Tracking is untracked. Do not claim this particular task succeeded.");
        }

        if (sid && remainingBudgetMs(deadlineAt) > 50) {
          try {
            const todos = (await client.get(
              `/session/${sid}/todo`,
              undefined,
              scopedDir,
            )) as Array<Record<string, unknown>> | null;
            if (Array.isArray(todos) && todos.length > 0) {
              const completed = todos.filter((t) => t.status === "completed").length;
              const inProgress = todos.filter((t) => t.status === "in_progress").length;
              const pending = todos.length - completed - inProgress;
              lines.push(`Tasks: ${completed}/${todos.length} completed` +
                (inProgress > 0 ? `, ${inProgress} in progress` : "") +
                (pending > 0 ? `, ${pending} pending` : ""));
              const current = todos.find((t) => t.status === "in_progress");
              if (current) {
                lines.push(`Current: ${current.content ?? current.title ?? "(unknown)"}`);
              }
            }
          } catch { /* optional */ }

          try {
            const diffs = await client.get(`/session/${sid}/diff`, undefined, scopedDir) as unknown[];
            if (Array.isArray(diffs) && diffs.length > 0) {
              lines.push(`Files changed: ${diffs.length}`);
            }
          } catch { /* optional */ }

          if (detailed) {
            if (result.content) {
              const truncated = result.content.length > 500
                ? result.content.slice(0, 497) + "..."
                : result.content;
              lines.push(`\n### Last message\n${truncated}`);
            } else {
              try {
                const lastMessages = await client.get(
                  `/session/${sid}/message`,
                  { limit: "1" },
                  scopedDir,
                );
                if (Array.isArray(lastMessages) && lastMessages.length > 0) {
                  const lastMsg = formatMessageResponse(lastMessages[lastMessages.length - 1]);
                  if (lastMsg) {
                    const truncated = lastMsg.length > 500 ? lastMsg.slice(0, 497) + "..." : lastMsg;
                    lines.push(`\n### Last message\n${truncated}`);
                  }
                }
              } catch { /* optional */ }
            }
          }
        }

        if (result.nextAction) {
          lines.push("", result.nextAction);
        }

        return toolFromTask(lines.join("\n"), result, checkToolIsError(result));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Quick status dashboard ───────────────────────────────────────
  server.tool(
    "opencode_status",
    "Get a quick status dashboard: server health, provider count, session count, and VCS info. Lighter than opencode_setup — good for at-a-glance checks.",
    {
      directory: directoryParam,
    },
    readOnly,
    async ({ directory }) => {
      try {
        // Validate directory early — before Promise.all with .catch(() => null)
        // swallows the validation error.
        directory = validateDirectory(directory) as typeof directory;

        const [health, providerRaw, sessions, vcs] = await Promise.all([
          client.get("/global/health", undefined, directory).catch(() => null),
          client.get("/provider", undefined, directory).catch(() => null),
          client.get("/session", undefined, directory).catch(() => null),
          client.get("/vcs", undefined, directory).catch(() => null),
        ]);

        const lines: string[] = [];

        // Health
        if (health) {
          const h = health as Record<string, unknown>;
          lines.push(`Server: healthy (v${h.version ?? "?"})`);
        } else {
          lines.push("Server: UNREACHABLE");
        }

        // Providers
        if (providerRaw) {
          const providers = (
            providerRaw && typeof providerRaw === "object" && "all" in (providerRaw as Record<string, unknown>)
              ? (providerRaw as Record<string, unknown>).all
              : providerRaw
          ) as Array<Record<string, unknown>>;
          if (Array.isArray(providers)) {
            const configured = providers.filter(isProviderConfigured).length;
            lines.push(`Providers: ${configured} configured / ${providers.length} total`);
          }
        }

        // Sessions
        if (sessions && Array.isArray(sessions)) {
          lines.push(`Sessions: ${(sessions as unknown[]).length}`);
        }

        // VCS
        if (vcs) {
          const v = vcs as Record<string, unknown>;
          const branch = v.branch ?? "unknown";
          const dirty = v.dirty === true ? " (dirty)" : v.dirty === false ? " (clean)" : "";
          lines.push(`Branch: ${branch}${dirty}`);
        }

        return toolResult(`## Status\n${lines.join("\n")}`);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
