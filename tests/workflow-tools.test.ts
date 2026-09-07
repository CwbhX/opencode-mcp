import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../src/client.js";
import { AmbiguousAcceptanceError } from "../src/bridge-types.js";
import { resetEventMonitorsForTests } from "../src/event-monitor.js";
import { registerWorkflowTools } from "../src/tools/workflow.js";

function hangingConnectedSse() {
  return async function* subscribeSSE(
    _path: string,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<{ event: string; data: string }> {
    yield { event: "message", data: JSON.stringify({ type: "server.connected" }) };
    await new Promise<void>((resolve) => {
      if (!opts?.signal) {
        resolve();
        return;
      }
      if (opts.signal.aborted) {
        resolve();
        return;
      }
      opts.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  };
}

function createMockClient(overrides: Record<string, unknown> = {}) {
  return {
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(undefined),
    subscribeSSE: hangingConnectedSse(),
    getBaseUrl: vi.fn().mockReturnValue("http://127.0.0.1:4096"),
    ...overrides,
  } as unknown as OpenCodeClient;
}

function register(client: OpenCodeClient) {
  const tools = new Map<string, Function>();
  const mockServer = {
    tool: vi.fn((...args: unknown[]) => {
      tools.set(args[0] as string, args[args.length - 1] as Function);
    }),
  } as unknown as McpServer;
  registerWorkflowTools(mockServer, client);
  return tools;
}

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content[0]?.text ?? "";
}

function parseJsonBlock(text: string): Record<string, unknown> {
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  if (!match) {
    throw new Error(`Expected a fenced TaskResult JSON block, got:\n${text}`);
  }
  return JSON.parse(match[1]!) as Record<string, unknown>;
}

function assistant(parentID: string, text = "All tasks completed.") {
  return {
    info: {
      id: "msg_assistant_done",
      role: "assistant",
      parentID,
      providerID: "anthropic",
      modelID: "claude-3",
      finish: "stop",
      time: { created: 1, completed: 2 },
    },
    parts: [{ type: "text", text }],
  };
}

function sessionAndPromptClient(options?: {
  sessionId?: string;
  afterPrompt?: (messageID: string) => void;
  messages?: (messageID: string | undefined) => unknown[];
  permissions?: unknown[];
  questions?: unknown[];
  status?: Record<string, unknown>;
}) {
  const sessionId = options?.sessionId ?? "ses-workflow-1";
  let requestMessageID: string | undefined;

  const post = vi.fn((path: string, body?: Record<string, unknown>) => {
    if (path === "/session") return Promise.resolve({ id: sessionId });
    if (path.endsWith("/prompt_async")) {
      requestMessageID =
        typeof body?.messageID === "string" ? body.messageID : undefined;
      options?.afterPrompt?.(requestMessageID ?? "");
      return Promise.resolve(undefined);
    }
    if (path.includes("/message")) {
      throw new Error(`unexpected POST ${path} — workflow tools must use prompt_async`);
    }
    return Promise.resolve({});
  });

  const get = vi.fn((path: string) => {
    if (path === `/session/${sessionId}`) return Promise.resolve({ id: sessionId });
    if (path === "/session/status") {
      return Promise.resolve(options?.status ?? {});
    }
    if (path === "/permission") return Promise.resolve(options?.permissions ?? []);
    if (path === "/question") return Promise.resolve(options?.questions ?? []);
    if (path === `/session/${sessionId}/message`) {
      return Promise.resolve(options?.messages?.(requestMessageID) ?? []);
    }
    return Promise.resolve([]);
  });

  return {
    client: createMockClient({ get, post }),
    post,
    get,
    sessionId,
    requestMessageID: () => requestMessageID,
  };
}

afterEach(() => {
  resetEventMonitorsForTests();
});

describe("opencode_fire", () => {
  it("submits via prompt_async and returns a job handle without waiting", async () => {
    const { client, post, sessionId } = sessionAndPromptClient();
    const handler = register(client).get("opencode_fire")!;

    const result = await handler({
      prompt: "Build everything",
      providerID: "anthropic",
      modelID: "claude-3",
    });
    const text = textOf(result);
    const json = parseJsonBlock(text);

    expect(text).toContain(sessionId);
    expect(text).toMatch(/dispatched|job/i);
    expect(json.jobId).toMatch(/^job_/);
    expect(json.sessionId).toBe(sessionId);
    expect(json.submissionState).toBe("accepted");
    expect(json.state).not.toBe("succeeded");
    expect(json.mayStillBeRunning).toBe(true);
    expect(json.safeToResubmit).toBe(false);
    expect(json.nextAction).toBeTruthy();
    expect(result.isError).toBeUndefined();

    const paths = post.mock.calls.map((call) => String(call[0]));
    expect(paths.some((path) => path.endsWith("/prompt_async"))).toBe(true);
    expect(paths.some((path) => path === `/session/${sessionId}/message`)).toBe(false);
  });

  it("surfaces unknown acceptance with safeToResubmit false", async () => {
    const post = vi.fn((path: string) => {
      if (path === "/session") return Promise.resolve({ id: "ses-amb" });
      if (path.endsWith("/prompt_async")) {
        return Promise.reject(
          new AmbiguousAcceptanceError("acceptance is unknown", {
            operation: "POST /session/ses-amb/prompt_async",
            submissionState: "unknown",
            mayStillBeRunning: true,
            safeToResubmit: false,
            nextAction: "Inspect this job; do not resend the prompt automatically.",
          }),
        );
      }
      return Promise.resolve({});
    });
    const client = createMockClient({ post });
    const handler = register(client).get("opencode_fire")!;
    const result = await handler({ prompt: "maybe" });
    const text = textOf(result);
    const json = parseJsonBlock(text);

    expect(result.isError).toBe(true);
    expect(json.safeToResubmit).toBe(false);
    expect(text).toMatch(/safeToResubmit/i);
  });
});

describe("opencode_run", () => {
  it("waits for a correlated terminal assistant and returns its content", async () => {
    const { client, post, sessionId } = sessionAndPromptClient({
      messages: (messageID) => (messageID ? [assistant(messageID)] : []),
    });
    const handler = register(client).get("opencode_run")!;

    const result = await handler({
      prompt: "Build app",
      providerID: "anthropic",
      modelID: "claude-3",
      maxDurationSeconds: 5,
    });
    const text = textOf(result);
    const json = parseJsonBlock(text);

    expect(result.isError).toBeUndefined();
    expect(text).toContain(sessionId);
    expect(text).toContain("All tasks completed.");
    expect(json.state).toBe("succeeded");
    expect(json.waitOutcome).toBe("completed");
    expect(json.jobId).toMatch(/^job_/);
    expect(post.mock.calls.some((call) => String(call[0]).endsWith("/prompt_async"))).toBe(
      true,
    );
    expect(
      post.mock.calls.some((call) => String(call[0]) === `/session/${sessionId}/message`),
    ).toBe(false);
  });

  it("returns a blocked result with pending request ids, not success", async () => {
    const sessionId = "ses-blocked";
    const { client } = sessionAndPromptClient({
      sessionId,
      permissions: [
        {
          id: "per_1",
          sessionID: sessionId,
          permission: "edit",
          title: "Edit src/app.ts",
        },
      ],
    });
    const handler = register(client).get("opencode_run")!;
    const result = await handler({
      prompt: "edit files",
      maxDurationSeconds: 5,
    });
    const text = textOf(result);
    const json = parseJsonBlock(text);

    expect(result.isError).toBeUndefined();
    expect(json.state).toBe("blocked_permission");
    expect(json.waitOutcome).toBe("blocked");
    expect(json.state).not.toBe("succeeded");
    expect(text).toMatch(/per_1/);
  });

  it("times out with a handle and mayStillBeRunning, without treating idle as done", async () => {
    const { client } = sessionAndPromptClient({
      status: { "ses-workflow-1": "idle" },
    });
    const handler = register(client).get("opencode_run")!;
    const result = await handler({
      prompt: "slow task",
      maxDurationSeconds: 1,
    });
    const text = textOf(result);
    const json = parseJsonBlock(text);

    expect(result.isError).toBe(true);
    expect(json.waitOutcome).toBe("timed_out");
    expect(json.mayStillBeRunning).toBe(true);
    expect(json.state).not.toBe("succeeded");
    expect(text).not.toMatch(/Done!/);
    expect(text).toMatch(/check|do not submit|do not resubmit/i);
  });
});

describe("opencode_check and opencode_wait selectors", () => {
  it("prefers jobId from fire when checking and never reports Done from idle", async () => {
    const { client, sessionId } = sessionAndPromptClient({
      status: { "ses-workflow-1": "idle" },
    });
    const tools = register(client);
    const fired = await tools.get("opencode_fire")!({ prompt: "work" });
    const jobId = parseJsonBlock(textOf(fired)).jobId as string;

    const checked = await tools.get("opencode_check")!({ jobId });
    const text = textOf(checked);
    const json = parseJsonBlock(text);

    expect(json.jobId).toBe(jobId);
    expect(json.sessionId).toBe(sessionId);
    expect(json.state).not.toBe("succeeded");
    expect(text).not.toMatch(/Done!/);
    expect(json.tracking).not.toBe("untracked");
  });

  it("session-only check is untracked and does not treat idle as Done", async () => {
    const client = createMockClient({
      get: vi.fn().mockImplementation((path: string) => {
        if (path === "/session/status") return Promise.resolve({ s1: "idle" });
        return Promise.resolve([]);
      }),
    });
    const result = await register(client).get("opencode_check")!({ sessionId: "s1" });
    const text = textOf(result);
    const json = parseJsonBlock(text);

    expect(json.tracking).toBe("untracked");
    expect(json.state).not.toBe("succeeded");
    expect(text).not.toMatch(/Done!/);
    expect(text).toMatch(/untracked|do not claim/i);
  });

  it("wait with requestMessageID completes only for a correlated assistant", async () => {
    const requestMessageID = "msg_user_turn";
    const client = createMockClient({
      get: vi.fn().mockImplementation((path: string) => {
        if (path === "/session/status") return Promise.resolve({});
        if (path === "/permission" || path === "/question") return Promise.resolve([]);
        if (path === "/session/s1/message") {
          return Promise.resolve([assistant(requestMessageID, "Result")]);
        }
        return Promise.resolve([]);
      }),
    });
    const result = await register(client).get("opencode_wait")!({
      sessionId: "s1",
      requestMessageID,
      timeoutSeconds: 5,
      pollIntervalMs: 50,
    });
    const json = parseJsonBlock(textOf(result));
    expect(json.waitOutcome).toBe("completed");
    expect(json.state).toBe("succeeded");
    expect(textOf(result)).toContain("Result");
  });
});
