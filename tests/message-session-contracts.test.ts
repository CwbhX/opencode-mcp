import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AmbiguousAcceptanceError } from "../src/bridge-types.js";
import { OpenCodeClient } from "../src/client.js";
import { OpenCodeError } from "../src/http-transport.js";
import { registerMessageTools } from "../src/tools/message.js";
import { registerSessionTools } from "../src/tools/session.js";

const submitAsync = vi.hoisted(() => vi.fn());

vi.mock("../src/task-manager.js", () => ({
  getSharedTaskManager: vi.fn(() => ({
    submitAsync,
    withSessionTurn: async (_params: unknown, fn: () => unknown) => fn(),
    assertSessionTurnAvailable: () => undefined,
  })),
}));

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function captureTools(
  register: (server: McpServer, client: OpenCodeClient) => void,
  overrides: Record<string, unknown> = {},
) {
  const tools = new Map<string, ToolHandler>();
  const mockServer = {
    tool: vi.fn((...args: unknown[]) => {
      tools.set(args[0] as string, args[args.length - 1] as ToolHandler);
    }),
  } as unknown as McpServer;
  const mockClient = {
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(undefined),
    subscribeSSE: vi.fn(),
    getBaseUrl: vi.fn().mockReturnValue("http://localhost:4096"),
    ...overrides,
  } as unknown as OpenCodeClient;
  register(mockServer, mockClient);
  return { tools, client: mockClient };
}

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]?.text ?? "";
}

const ENV_KEYS = [
  "OPENCODE_DEFAULT_PROVIDER",
  "OPENCODE_DEFAULT_MODEL",
  "OPENCODE_REQUIRE_EXPLICIT_MODEL",
  "OPENCODE_ALLOWED_MODELS",
] as const;

describe("message/session contracts", () => {
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  let dirA: string;
  let dirB: string;

  beforeEach(async () => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    submitAsync.mockReset();
    dirA = await mkdtemp(path.join(tmpdir(), "oc-mcp-a-"));
    dirB = await mkdtemp(path.join(tmpdir(), "oc-mcp-b-"));
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  });

  describe("opencode_message_send", () => {
    it("serializes prompt model as an object without variant", async () => {
      const post = vi.fn().mockResolvedValue({
        info: { id: "m1", role: "assistant" },
        parts: [{ type: "text", text: "ok" }],
      });
      const { tools } = captureTools(registerMessageTools, { post });
      await tools.get("opencode_message_send")!({
        sessionId: "ses_1",
        text: "hello",
        providerID: "opencode",
        modelID: "muse-spark-1.3-contributor-free",
        variant: "max",
      });
      expect(post).toHaveBeenCalledTimes(1);
      const [, body] = post.mock.calls[0] as [string, Record<string, unknown>];
      expect(body.model).toEqual({
        providerID: "opencode",
        modelID: "muse-spark-1.3-contributor-free",
      });
      expect(body.model).not.toHaveProperty("variant");
      expect(body.variant).toBe("max");
      expect(body.parts).toEqual([{ type: "text", text: "hello" }]);
    });

    it("rejects a half model pair without POSTing", async () => {
      const post = vi.fn().mockResolvedValue({});
      const { tools } = captureTools(registerMessageTools, { post });
      const result = await tools.get("opencode_message_send")!({
        sessionId: "ses_1",
        text: "hello",
        providerID: "opencode",
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/providerID and modelID/i);
      expect(post).not.toHaveBeenCalled();
    });

    it("acknowledges noReply as context injection, not a generated answer", async () => {
      const post = vi.fn().mockResolvedValue(null);
      const { tools } = captureTools(registerMessageTools, { post });
      const result = await tools.get("opencode_message_send")!({
        sessionId: "ses_1",
        text: "remember this",
        noReply: true,
      });
      const text = textOf(result);
      expect(text).toMatch(/context injection acknowledged/i);
      expect(text).not.toMatch(/WARNING/);
      expect(text).not.toMatch(/empty response/i);
      expect(post).toHaveBeenCalledWith(
        "/session/ses_1/message",
        expect.objectContaining({ noReply: true }),
        expect.anything(),
      );
    });

    it("does not POST when directory does not match the session", async () => {
      const get = vi.fn().mockResolvedValue({ id: "ses_1", directory: dirB });
      const post = vi.fn().mockResolvedValue({});
      const { tools } = captureTools(registerMessageTools, { get, post });
      const result = await tools.get("opencode_message_send")!({
        sessionId: "ses_1",
        text: "hello",
        directory: dirA,
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/SESSION_DIRECTORY_MISMATCH/);
      expect(get).toHaveBeenCalledWith("/session/ses_1", undefined, dirA);
      expect(post).not.toHaveBeenCalled();
    });
  });

  describe("opencode_command_execute", () => {
    it("serializes command body.model as a provider-qualified string", async () => {
      const post = vi.fn().mockResolvedValue({
        info: { id: "m1", role: "assistant" },
        parts: [{ type: "text", text: "ok" }],
      });
      const { tools } = captureTools(registerMessageTools, { post });
      await tools.get("opencode_command_execute")!({
        sessionId: "ses_1",
        command: "init",
        providerID: "opencode",
        modelID: "muse-spark-1.3-contributor-free",
        variant: "max",
      });
      const [, body] = post.mock.calls[0] as [string, Record<string, unknown>];
      expect(typeof body.model).toBe("string");
      expect(body.model).toBe("opencode/muse-spark-1.3-contributor-free");
      expect(body.variant).toBe("max");
    });
  });

  describe("opencode_shell_execute", () => {
    it("returns UnsupportedParameterError when variant is provided", async () => {
      const post = vi.fn().mockResolvedValue({});
      const { tools } = captureTools(registerMessageTools, { post });
      const result = await tools.get("opencode_shell_execute")!({
        sessionId: "ses_1",
        command: "ls",
        agent: "build",
        variant: "max",
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/variant is not supported for shell/);
      expect(post).not.toHaveBeenCalled();
    });
  });

  describe("opencode_message_send_async", () => {
    it("returns an accepted handle and does not claim completion", async () => {
      submitAsync.mockResolvedValue({
        jobId: "job_1",
        sessionId: "ses_1",
        requestMessageID: "msg_1",
        directory: dirA,
        state: "queued",
        submissionState: "accepted",
      });
      const { tools } = captureTools(registerMessageTools);
      const result = await tools.get("opencode_message_send_async")!({
        sessionId: "ses_1",
        text: "hello",
        providerID: "opencode",
        modelID: "muse-spark-1.3-contributor-free",
        directory: dirA,
      });
      expect(submitAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "ses_1",
          prompt: "hello",
          providerID: "opencode",
          modelID: "muse-spark-1.3-contributor-free",
          directory: dirA,
        }),
      );
      const text = textOf(result);
      expect(text).toMatch(/Message accepted asynchronously/);
      expect(text).not.toMatch(/completed/i);
      expect(text).toContain("job_1");
      expect(text).toContain("msg_1");
      expect(text).toContain('"submissionState": "accepted"');
    });
  });

  describe("opencode_session_summarize", () => {
    it("rejects variant and does not POST", async () => {
      const post = vi.fn().mockResolvedValue({});
      const { tools } = captureTools(registerSessionTools, { post });
      const result = await tools.get("opencode_session_summarize")!({
        id: "ses_1",
        providerID: "opencode",
        modelID: "muse-spark-1.3-contributor-free",
        variant: "max",
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/variant is not supported for summarize/);
      expect(post).not.toHaveBeenCalled();
    });

    it("POSTs providerID and modelID without variant", async () => {
      const post = vi.fn().mockResolvedValue(true);
      const { tools } = captureTools(registerSessionTools, { post });
      await tools.get("opencode_session_summarize")!({
        id: "ses_1",
        providerID: "opencode",
        modelID: "muse-spark-1.3-contributor-free",
      });
      expect(post).toHaveBeenCalledWith(
        "/session/ses_1/summarize",
        { providerID: "opencode", modelID: "muse-spark-1.3-contributor-free" },
        expect.anything(),
      );
    });
  });

  describe("opencode_session_abort", () => {
    it("reports abort request accepted, not an observed job abort", async () => {
      const post = vi.fn().mockResolvedValue({});
      const { tools } = captureTools(registerSessionTools, { post });
      const result = await tools.get("opencode_session_abort")!({ id: "ses_1" });
      const text = textOf(result);
      expect(text).toMatch(/abort request accepted/i);
      expect(text).toMatch(/session-wide/i);
      expect(text).not.toMatch(/job .* aborted/i);
      expect(post).toHaveBeenCalledWith(
        "/session/ses_1/abort",
        undefined,
        expect.anything(),
      );
    });
  });

  describe("opencode_session_status", () => {
    it("does not claim all sessions idle when the status map is empty", async () => {
      const get = vi.fn().mockResolvedValue({});
      const { tools } = captureTools(registerSessionTools, { get });
      const result = await tools.get("opencode_session_status")!({});
      const text = textOf(result);
      expect(text).toMatch(/No sessions reported active/);
      expect(text).toMatch(/status map empty \(idle entries are omitted\)/i);
      expect(text).not.toMatch(/All sessions idle/);
    });
  });

  describe("session directory guard", () => {
    it("does not DELETE when directory does not match the session", async () => {
      const get = vi.fn().mockResolvedValue({ id: "ses_1", directory: dirB });
      const del = vi.fn().mockResolvedValue(undefined);
      const { tools } = captureTools(registerSessionTools, { get, delete: del });
      const result = await tools.get("opencode_session_delete")!({
        id: "ses_1",
        directory: dirA,
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/SESSION_DIRECTORY_MISMATCH/);
      expect(get).toHaveBeenCalledWith("/session/ses_1", undefined, dirA);
      expect(del).not.toHaveBeenCalled();
    });
  });

  describe("opencode_session_permission", () => {
    it("does not fall back to the legacy endpoint on 401", async () => {
      const post = vi.fn().mockRejectedValue(
        new OpenCodeError(
          "POST /permission/perm_1/reply failed (401): unauthorized",
          401,
          "POST",
          "/permission/perm_1/reply",
          "unauthorized",
        ),
      );
      const { tools } = captureTools(registerSessionTools, { post });
      const result = await tools.get("opencode_session_permission")!({
        id: "ses_1",
        permissionID: "perm_1",
        reply: "once",
      });
      expect(result.isError).toBe(true);
      expect(post).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledWith(
        "/permission/perm_1/reply",
        { reply: "once" },
        expect.anything(),
      );
      expect(post.mock.calls.some((call) => String(call[0]).includes("/session/"))).toBe(
        false,
      );
    });

    it("does not fall back on a request-specific 404", async () => {
      const post = vi.fn().mockRejectedValue(
        new OpenCodeError(
          "POST /permission/perm_1/reply failed (404): Permission not found",
          404,
          "POST",
          "/permission/perm_1/reply",
          "Permission not found",
        ),
      );
      const { tools } = captureTools(registerSessionTools, { post });
      const result = await tools.get("opencode_session_permission")!({
        id: "ses_1",
        permissionID: "perm_1",
        reply: "once",
      });
      expect(result.isError).toBe(true);
      expect(post).toHaveBeenCalledTimes(1);
    });

    it("does not retry after AmbiguousAcceptanceError", async () => {
      const post = vi.fn().mockRejectedValue(
        new AmbiguousAcceptanceError("POST /permission/perm_1/reply acceptance is unknown", {
          operation: "POST /permission/perm_1/reply",
          submissionState: "unknown",
          mayStillBeRunning: true,
          safeToResubmit: false,
          nextAction: "Inspect; do not resend automatically.",
        }),
      );
      const { tools } = captureTools(registerSessionTools, { post });
      const result = await tools.get("opencode_session_permission")!({
        id: "ses_1",
        permissionID: "perm_1",
        reply: "once",
      });
      expect(result.isError).toBe(true);
      expect(post).toHaveBeenCalledTimes(1);
    });

    it("falls back to the legacy route only when the new route is missing", async () => {
      const post = vi.fn().mockImplementation((urlPath: string) => {
        if (urlPath === "/permission/perm_1/reply") {
          return Promise.reject(
            new OpenCodeError(
              "POST /permission/perm_1/reply failed (404): Cannot POST /permission/perm_1/reply",
              404,
              "POST",
              "/permission/perm_1/reply",
              "Cannot POST /permission/perm_1/reply",
            ),
          );
        }
        return Promise.resolve({});
      });
      const { tools } = captureTools(registerSessionTools, { post });
      const result = await tools.get("opencode_session_permission")!({
        id: "ses_1",
        permissionID: "perm_1",
        reply: "once",
      });
      expect(result.isError).not.toBe(true);
      expect(post).toHaveBeenCalledTimes(2);
      expect(post).toHaveBeenNthCalledWith(
        2,
        "/session/ses_1/permissions/perm_1",
        { response: "once" },
        expect.anything(),
      );
    });
  });
});
