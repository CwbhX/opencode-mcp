import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../client.js";
import {
  toolResult,
  toolError,
  formatMessageResponse,
  formatMessageList,
  directoryParam,
} from "../helpers.js";
import {
  buildCommandBody,
  buildPromptBody,
  buildShellBody,
  resolveConfiguredModel,
} from "../model-selection.js";
import {
  assertSessionDirectory,
  createDeadline,
  validateDirectory,
} from "../request-context.js";
import { fireToolIsError, formatTaskResult } from "../task-result-format.js";
import { getSharedTaskManager } from "../task-manager.js";
import { analyzeTypedMessage } from "../typed-outcome.js";

const ASYNC_SUBMIT_BUDGET_MS = 60_000;

function resolveToolModel(providerID?: string, modelID?: string) {
  return resolveConfiguredModel({ providerID, modelID });
}

function sessionDirectoryOf(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const directory = (payload as { directory?: unknown }).directory;
  return typeof directory === "string" ? directory : undefined;
}

async function assertExistingSessionDirectory(
  client: OpenCodeClient,
  sessionId: string,
  directory: string | undefined,
): Promise<string | undefined> {
  const requested = validateDirectory(directory);
  if (!requested) return undefined;
  const session = await client.get(`/session/${sessionId}`, undefined, requested);
  assertSessionDirectory({
    requestedDirectory: requested,
    sessionDirectory: sessionDirectoryOf(session),
  });
  return requested;
}

function formatAsyncHandle(result: import("../bridge-types.js").TaskResult): string {
  const line =
    result.state === "failed" || result.state === "aborted"
      ? `Async send ended in ${result.state} (submissionState=${result.submissionState}).`
      : result.submissionState === "accepted"
        ? "Message accepted asynchronously. Use opencode_wait or opencode_check to monitor this job."
        : result.submissionState === "unknown"
          ? "Message acceptance is unknown, not a known rejection. Inspect the handle; do not resend automatically."
          : `Message was not accepted (submissionState=${result.submissionState}). Inspect the handle before retrying.`;
  return formatTaskResult(line, result);
}

export function registerMessageTools(
  server: McpServer,
  client: OpenCodeClient,
) {
  server.tool(
    "opencode_message_list",
    "List all messages in a session with formatted output showing roles and content",
    {
      sessionId: z.string().describe("Session ID"),
      limit: z
        .number()
        .optional()
        .describe("Maximum number of messages to return"),
      directory: directoryParam,
    },
    async ({ sessionId, limit, directory }) => {
      try {
        const query: Record<string, string> = {};
        if (limit !== undefined) query.limit = String(limit);
        const messages = await client.get(
          `/session/${sessionId}/message`,
          query,
          directory,
        );
        return toolResult(formatMessageList(messages as unknown[]));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_message_get",
    "Get details of a specific message in a session",
    {
      sessionId: z.string().describe("Session ID"),
      messageId: z.string().describe("Message ID"),
      directory: directoryParam,
    },
    async ({ sessionId, messageId, directory }) => {
      try {
        const msg = await client.get(
          `/session/${sessionId}/message/${messageId}`,
          undefined,
          directory,
        );
        return toolResult(formatMessageResponse(msg));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_message_send",
    "Send a prompt message to a session and wait for the AI response. Use parts to send text, and optionally specify a model.",
    {
      sessionId: z.string().describe("Session ID"),
      text: z.string().describe("The text message to send"),
      providerID: z
        .string()
        .optional()
        .describe("Provider ID (e.g. 'anthropic')"),
      modelID: z
        .string()
        .optional()
        .describe("Model ID (e.g. 'claude-3-5-sonnet-20241022')"),
      variant: z.string().optional().describe("Model variant (e.g. 'fast', 'smart')"),
      agent: z.string().optional().describe("Agent to use"),
      noReply: z
        .boolean()
        .optional()
        .describe(
          "If true, inject context without triggering AI response (useful for plugins)",
        ),
      system: z.string().optional().describe("System prompt override"),
      directory: directoryParam,
    },
    async ({
      sessionId,
      text,
      providerID,
      modelID,
      variant,
      agent,
      noReply,
      system,
      directory,
    }) => {
      try {
        const model = resolveToolModel(providerID, modelID);
        const scoped = await assertExistingSessionDirectory(
          client,
          sessionId,
          directory,
        );
        const manager = getSharedTaskManager(client);
        if (noReply === true) {
          manager.assertSessionTurnAvailable(sessionId, scoped);
        }
        const body = buildPromptBody({
          prompt: text,
          model,
          variant,
          agent,
          system,
          noReply,
        });
        const post = () =>
          client.post(`/session/${sessionId}/message`, body, { directory: scoped });
        const response = noReply === true
          ? await post()
          : await manager.withSessionTurn({ sessionId, directory: scoped }, post);

        if (noReply === true) {
          const analysis = analyzeTypedMessage(response);
          const formatted = formatMessageResponse(response);
          const ack =
            "noReply context injection acknowledged; this is not a generated-task result.";
          if (analysis.hasError) {
            return toolResult(
              `${ack}\n\n${analysis.warning ?? formatted}`,
              true,
            );
          }
          return toolResult(formatted ? `${ack}\n\n${formatted}` : ack);
        }

        const analysis = analyzeTypedMessage(response);
        const formatted = formatMessageResponse(response);
        const parts: string[] = [];
        if (formatted) parts.push(formatted);
        if (analysis.warning) {
          parts.push(`\n--- WARNING ---\n${analysis.warning}`);
        }
        return toolResult(
          parts.join("\n\n") ||
            (analysis.hasNonTextContent
              ? "Completed with non-text output; this is not an authentication failure."
              : "Empty response."),
          analysis.hasError,
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_message_send_async",
    "Send a prompt message asynchronously (fire-and-forget, does not wait for response). Use opencode_wait to poll for completion.",
    {
      sessionId: z.string().describe("Session ID"),
      text: z.string().describe("The text message to send"),
      providerID: z
        .string()
        .optional()
        .describe("Provider ID (e.g. 'anthropic')"),
      modelID: z
        .string()
        .optional()
        .describe("Model ID (e.g. 'claude-3-5-sonnet-20241022')"),
      variant: z.string().optional().describe("Model variant (e.g. 'fast', 'smart')"),
      agent: z.string().optional().describe("Agent to use"),
      directory: directoryParam,
    },
    async ({ sessionId, text, providerID, modelID, variant, agent, directory }, extra) => {
      try {
        resolveToolModel(providerID, modelID);
        const scoped = validateDirectory(directory);
        const handle = await getSharedTaskManager(client).submitAsync({
          prompt: text,
          sessionId,
          providerID,
          modelID,
          variant,
          agent,
          directory: scoped,
          deadlineAt: createDeadline(ASYNC_SUBMIT_BUDGET_MS),
          signal: extra?.signal,
        });
        return toolResult(formatAsyncHandle(handle), fireToolIsError(handle));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_command_execute",
    "Execute a slash command in a session (e.g. /init, /undo, /redo)",
    {
      sessionId: z.string().describe("Session ID"),
      command: z
        .string()
        .describe("The slash command to execute (e.g. 'init', 'undo')"),
      arguments: z
        .string()
        .optional()
        .describe("Arguments for the command"),
      agent: z.string().optional().describe("Agent to use"),
      providerID: z.string().optional().describe("Provider ID"),
      modelID: z.string().optional().describe("Model ID"),
      variant: z.string().optional().describe("Model variant"),
      directory: directoryParam,
    },
    async ({
      sessionId,
      command,
      arguments: args,
      agent,
      providerID,
      modelID,
      variant,
      directory,
    }) => {
      try {
        const model = resolveToolModel(providerID, modelID);
        const scoped = await assertExistingSessionDirectory(
          client,
          sessionId,
          directory,
        );
        const body = buildCommandBody({
          command,
          arguments: args,
          model,
          variant,
          agent,
        });
        const result = await getSharedTaskManager(client).withSessionTurn(
          { sessionId, directory: scoped },
          () =>
            client.post(`/session/${sessionId}/command`, body, { directory: scoped }),
        );
        return toolResult(formatMessageResponse(result));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_shell_execute",
    "Run a shell command through the opencode session",
    {
      sessionId: z.string().describe("Session ID"),
      command: z.string().describe("Shell command to execute"),
      agent: z.string().describe("Agent to use for the shell command"),
      providerID: z.string().optional().describe("Provider ID"),
      modelID: z.string().optional().describe("Model ID"),
      variant: z.string().optional().describe("Model variant"),
      directory: directoryParam,
    },
    async ({ sessionId, command, agent, providerID, modelID, variant, directory }) => {
      try {
        const model = resolveToolModel(providerID, modelID);
        const body = buildShellBody({ command, agent, model, variant });
        const scoped = await assertExistingSessionDirectory(
          client,
          sessionId,
          directory,
        );
        const result = await getSharedTaskManager(client).withSessionTurn(
          { sessionId, directory: scoped },
          () =>
            client.post(`/session/${sessionId}/shell`, body, { directory: scoped }),
        );
        return toolResult(formatMessageResponse(result));
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
