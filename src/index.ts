#!/usr/bin/env node

/**
 * OpenCode MCP Server
 *
 * An MCP (Model Context Protocol) server that wraps the OpenCode AI headless
 * server HTTP API. This allows any MCP client to interact with a running
 * OpenCode instance — manage sessions, send prompts, search files, configure
 * providers, and more.
 *
 * Features:
 *  - 83 tools covering the OpenCode API surface
 *  - High-level workflow tools (opencode_ask, opencode_reply, etc.)
 *  - Smart response formatting for LLM-friendly output
 *  - MCP Resources for browseable project data
 *  - MCP Prompts for guided workflows
 *  - SSE event polling
 *  - TUI control tools
 *  - Retry logic with exponential backoff
 *  - Auto-detection and auto-start of the OpenCode server
 *
 * Environment variables:
 *   OPENCODE_BASE_URL        - Base URL of the OpenCode server (default: http://127.0.0.1:4096)
 *   OPENCODE_SERVER_USERNAME  - Username for HTTP basic auth (default: opencode)
 *   OPENCODE_SERVER_PASSWORD  - Password for HTTP basic auth (optional)
 *   OPENCODE_AUTO_SERVE       - Set to "false" to disable auto-start (default: true)
 *   OPENCODE_DEFAULT_PROVIDER - Default provider ID when not specified per-tool (optional)
 *   OPENCODE_DEFAULT_MODEL    - Default model ID when not specified per-tool (optional)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OpenCodeClient } from "./client.js";
import { ensureServer } from "./server-manager.js";
import { setModelDefaults } from "./helpers.js";

// Tool groups
import { registerGlobalTools } from "./tools/global.js";
import { registerConfigTools } from "./tools/config.js";
import { registerProjectTools } from "./tools/project.js";
import { registerSessionTools } from "./tools/session.js";
import { registerMessageTools } from "./tools/message.js";
import { registerQuestionTools } from "./tools/question.js";
import { registerFileTools } from "./tools/file.js";
import { registerProviderTools } from "./tools/provider.js";
import { registerMiscTools } from "./tools/misc.js";
import { registerWorkflowTools } from "./tools/workflow.js";
import { registerTuiTools } from "./tools/tui.js";
import { registerEventTools } from "./tools/events.js";

// Resources and prompts
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";

const baseUrl =
  process.env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4096";
const username = process.env.OPENCODE_SERVER_USERNAME;
const password = process.env.OPENCODE_SERVER_PASSWORD;
const autoServe = process.env.OPENCODE_AUTO_SERVE !== "false";
const defaultProvider = process.env.OPENCODE_DEFAULT_PROVIDER;
const defaultModel = process.env.OPENCODE_DEFAULT_MODEL;

// Set global model defaults from env vars (used by applyModelDefaults() in tools)
setModelDefaults(defaultProvider, defaultModel);

// Use env-var defaults in instruction examples; fall back to generic placeholders
const exProvider = defaultProvider || "<your-provider>";
const exModel = defaultModel || "<your-model>";

const client = new OpenCodeClient({ baseUrl, username, password, autoServe });

const server = new McpServer(
  {
    name: "opencode-mcp",
    version: "1.12.0",
    description:
      "MCP server wrapping the OpenCode AI coding agent. " +
      "Delegates complex coding tasks (build apps, refactor, debug) to an autonomous AI agent. " +
      "Start with opencode_setup, then use opencode_ask for simple tasks, opencode_run for complex tasks, or opencode_fire for long-running background work.",
  },
  {
    instructions: [
      "# OpenCode MCP — Guide for LLM Clients",
      "",
      "You are connected to OpenCode, an autonomous AI coding agent that can build, edit, and debug software projects.",
      "This server exposes 83 tools organized into tiers. Use high-level tools first; drop to low-level only when needed.",
      "",
      "## Getting Started (First Time)",
      "1. Call `opencode_setup` — checks server health, shows configured providers, and suggests next steps.",
      "2. Pick a provider from the **Ready to use** list returned by `opencode_setup`, then call `opencode_provider_models` to see its models.",
      "3. IMPORTANT: Always pass `providerID` and `modelID` from the discovered providers when sending prompts, or you may get empty responses. Do NOT assume any specific provider is available — always discover first.",
      "",
      "## Tool Tiers (prefer higher tiers)",
      "",
      "### Tier 1 — Essential (use these first)",
      "- `opencode_setup` — first-time onboarding, health check (read-only)",
      "- `opencode_ask` — one-shot question/task, creates session + gets response in one call. Simplest way to use OpenCode.",
      "- `opencode_reply` — continue a conversation in an existing session",
      "- `opencode_context` — get project info (path, git branch, config, agents) (read-only)",
      "",
      "### Tier 2 — Async Tasks (for complex/long work)",
      "- `opencode_run` — send a task and wait for a correlated result or a block/timeout. Uses `/prompt_async` plus a job handle. Best for tasks under 10 minutes.",
      "- `opencode_fire` — accepted dispatch only: returns jobId + sessionId + requestMessageID + directory immediately. The model may still be running.",
      "- `opencode_check` — observe that handle (prefer jobId, or sessionId + requestMessageID + directory). Idle/absent status is not success. (read-only)",
      "- `opencode_wait` — wait on the same handle until terminal, blocked, timed out, or cancelled. Timeout does not abort server-side work.",
      "- `opencode_session_todo` — see the agent's internal task list for a session (read-only)",
      "",
      "### Tier 3 — Monitoring & Review",
      "- `opencode_review_changes` — see all file diffs from a session (read-only)",
      "- `opencode_conversation` — get full message history (read-only)",
      "- `opencode_sessions_overview` — list all sessions with status (read-only)",
      "- `opencode_provider_models` — list models for a specific provider (read-only)",
      "- `opencode_status` — quick server health dashboard (read-only)",
      "",
      "### Tier 4 — Fine-Grained Control",
      "- `opencode_session_*` — create, delete, fork, abort, share sessions",
      "- `opencode_message_*` — send messages, list history, execute commands",
      "- `opencode_permission_list` / `opencode_session_permission` — check and respond to permission requests",
      "- `opencode_question_*` — list, reply, or reject pending user questions",
      "- `opencode_file_*` / `opencode_find_*` — search files, read content, check VCS status",
      "- `opencode_provider_*` — manage providers, auth, OAuth flows",
      "",
      "### Tier 5 — Specialist (rarely needed)",
      "- `opencode_tui_*` — control the terminal UI (only if a TUI is running)",
      "- `opencode_events_poll` — poll raw SSE events",
      "- `opencode_mcp_*` — manage MCP servers inside OpenCode",
      "- `opencode_instance_dispose` — shut down the server (DESTRUCTIVE!)",
      "",
      "## Recommended Workflows",
      "",
      "### Quick question or small task:",
      "```",
      `opencode_ask({prompt: "How does auth work in this project?", providerID: "${exProvider}", modelID: "${exModel}"})`,
      "```",
      "",
      "### Complex multi-step task (build an app, refactor code, etc.):",
      "```",
      "// Option A: One-call (recommended for tasks under 10 min)",
      `opencode_run({prompt: "Build a React login form with validation...", providerID: "${exProvider}", modelID: "${exModel}", maxDurationSeconds: 600})`,
      "",
      "// Option B: Fire-and-forget (for longer tasks)",
      `opencode_fire({prompt: "Build a full React app with auth, dashboard...", providerID: "${exProvider}", modelID: "${exModel}"})`,
      "// ... do other work ...",
      'opencode_check({jobId: "job_xxx"})  // or sessionId + requestMessageID + directory',
      'opencode_review_changes({sessionId: "ses_xxx"})  // see changes after a correlated completion',
      "```",
      "",
      "### Continue working on an existing session:",
      "```",
      `opencode_reply({sessionId: "ses_xxx", prompt: "Now add form validation", providerID: "${exProvider}", modelID: "${exModel}"})`,
      "```",
      "",
      "## Permissions and questions",
      "OpenCode may pause a session to ask for permission or a user question.",
      "- Do **not** set global `permission: \"allow\"` as the default workaround. Prefer scoped rules and explicit replies.",
      "- `run`/`wait` return a blocked result with the request id. Then call `opencode_permission_list` / `opencode_session_permission` or `opencode_question_list` / `opencode_question_reply`.",
      "- Never auto-approve, choose \"always\", or invent answers just to finish a wait.",
      "",
      "## Important Notes",
      "- ALWAYS pass both `providerID` and `modelID`, or configure both `OPENCODE_DEFAULT_PROVIDER` and `OPENCODE_DEFAULT_MODEL`. A single identifier is rejected and is not merged with defaults. Do not substitute a different model when the selected one is unavailable.",
      "- The `directory` parameter must be an absolute existing directory. Relative paths, `~`, files, and literal `%` path segments are rejected. The OpenCode server's default context is used when it is omitted — not this MCP process's cwd.",
      "- `readOnlyHint` is not a sandbox. A `plan` agent is not guaranteed write-incapable unless OpenCode permissions actually block writes.",
      "- Tools marked with `destructiveHint: true` (`opencode_instance_dispose`, `opencode_session_delete`) permanently delete data — confirm with the user before calling.",
      "- `opencode_fire` returns an accepted handle, not a completed answer. Recover a timed-out job with `opencode_check`/`opencode_wait` using jobId or sessionId + requestMessageID + directory. Do not resubmit after an unknown acceptance.",
      "- Auto-started OpenCode is an SDK child process on loopback, not an in-process engine. `fire` jobs do not survive this MCP process exiting. Use a separately managed `opencode serve` for shared or long-lived work.",
      "- For tasks under 10 minutes, prefer `opencode_run`. For longer tasks, use `opencode_fire` + `opencode_check`/`opencode_wait` on the returned handle.",
    ].join("\n"),
  },
);

// ── Low-level API tools ─────────────────────────────────────────────
registerGlobalTools(server, client);
registerConfigTools(server, client);
registerProjectTools(server, client);
registerSessionTools(server, client);
registerMessageTools(server, client);
registerQuestionTools(server, client);
registerFileTools(server, client);
registerProviderTools(server, client);
registerMiscTools(server, client);

// ── High-level workflow tools ───────────────────────────────────────
registerWorkflowTools(server, client);

// ── TUI control ─────────────────────────────────────────────────────
registerTuiTools(server, client);

// ── Event streaming ─────────────────────────────────────────────────
registerEventTools(server, client);

// ── Resources ───────────────────────────────────────────────────────
registerResources(server, client);

// ── Prompts ─────────────────────────────────────────────────────────
registerPrompts(server);

// ── Start ───────────────────────────────────────────────────────────
async function main() {
  // Step 1: Ensure OpenCode server is available (auto-start if needed).
  try {
    await ensureServer({ baseUrl, autoServe, username, password });
  } catch (err) {
    // Log the error but don't prevent MCP from starting — tools will
    // report connection errors individually, and the server may come
    // up later.
    console.error(
      `Warning: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Step 2: Connect the MCP transport.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const defaultsInfo = defaultProvider && defaultModel
    ? ` | defaults: ${defaultProvider}/${defaultModel}`
    : "";
  console.error(
    `opencode-mcp v1.12.0 started (OpenCode server at ${baseUrl}${defaultsInfo})`,
  );
}

main().catch((err) => {
  console.error("Fatal error starting opencode-mcp:", err);
  process.exit(1);
});
