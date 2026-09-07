import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../src/client.js";
import { registerQuestionTools } from "../src/tools/question.js";

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function captureQuestionTools(overrides: Record<string, unknown> = {}) {
  const tools = new Map<string, { handler: ToolHandler; annotations?: unknown }>();
  const mockServer = {
    tool: vi.fn((...args: unknown[]) => {
      tools.set(args[0] as string, {
        handler: args[args.length - 1] as ToolHandler,
        annotations: args.length === 5 ? args[3] : undefined,
      });
    }),
  } as unknown as McpServer;
  const mockClient = {
    get: vi.fn().mockResolvedValue([]),
    post: vi.fn().mockResolvedValue(true),
    patch: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(undefined),
    subscribeSSE: vi.fn(),
    getBaseUrl: vi.fn().mockReturnValue("http://localhost:4096"),
    ...overrides,
  } as unknown as OpenCodeClient;
  registerQuestionTools(mockServer, mockClient);
  return { tools, client: mockClient };
}

describe("question tools", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "oc-mcp-q-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("registers list, reply, and reject tools", () => {
    const { tools } = captureQuestionTools();
    expect(tools.has("opencode_question_list")).toBe(true);
    expect(tools.has("opencode_question_reply")).toBe(true);
    expect(tools.has("opencode_question_reject")).toBe(true);
  });

  it("marks list as read-only and reply/reject as mutating", () => {
    const { tools } = captureQuestionTools();
    expect(tools.get("opencode_question_list")!.annotations).toEqual(
      expect.objectContaining({ readOnlyHint: true }),
    );
    expect(tools.get("opencode_question_reply")!.annotations).not.toEqual(
      expect.objectContaining({ readOnlyHint: true }),
    );
    expect(tools.get("opencode_question_reject")!.annotations).not.toEqual(
      expect.objectContaining({ readOnlyHint: true }),
    );
  });

  it("lists pending questions from GET /question", async () => {
    const get = vi.fn().mockResolvedValue([
      {
        id: "q_1",
        sessionID: "ses_1",
        questions: [
          {
            header: "Color",
            question: "Which color?",
            options: [
              { label: "Red", description: "warm" },
              { label: "Blue", description: "cool" },
            ],
          },
        ],
      },
    ]);
    const { tools } = captureQuestionTools({ get });
    const result = await tools.get("opencode_question_list")!.handler({});
    const text = result.content[0].text;
    expect(get).toHaveBeenCalledWith("/question", undefined, undefined);
    expect(text).toContain("q_1");
    expect(text).toContain("ses_1");
    expect(text).toContain("Which color?");
    expect(text).toContain("Red");
    expect(text).toContain("Blue");
  });

  it("POSTs answers in question order", async () => {
    const post = vi.fn().mockResolvedValue(true);
    const { tools } = captureQuestionTools({ post });
    const answers = [["Yes"], ["Red", "Blue"]];
    const result = await tools.get("opencode_question_reply")!.handler({
      requestID: "q_1",
      answers,
    });
    expect(result.isError).not.toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    const [urlPath, body] = post.mock.calls[0] as [string, { answers: string[][] }];
    expect(urlPath).toBe("/question/q_1/reply");
    expect(body).toEqual({ answers });
    expect(body.answers[0]).toEqual(["Yes"]);
    expect(body.answers[1]).toEqual(["Red", "Blue"]);
    expect(JSON.stringify(body.answers)).toBe(JSON.stringify(answers));
  });

  it("rejects without inventing a body", async () => {
    const post = vi.fn().mockResolvedValue(true);
    const { tools } = captureQuestionTools({ post });
    await tools.get("opencode_question_reject")!.handler({ requestID: "q_1" });
    expect(post).toHaveBeenCalledWith(
      "/question/q_1/reject",
      undefined,
      expect.anything(),
    );
  });

  it("validates directory before mutating", async () => {
    const post = vi.fn().mockResolvedValue(true);
    const { tools } = captureQuestionTools({ post });
    const result = await tools.get("opencode_question_reply")!.handler({
      requestID: "q_1",
      answers: [["Yes"]],
      directory: "relative/path",
    });
    expect(result.isError).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  it("forwards a validated directory on reply", async () => {
    const post = vi.fn().mockResolvedValue(true);
    const { tools } = captureQuestionTools({ post });
    await tools.get("opencode_question_reply")!.handler({
      requestID: "q_1",
      answers: [["Yes"]],
      directory,
    });
    expect(post).toHaveBeenCalledWith(
      "/question/q_1/reply",
      { answers: [["Yes"]] },
      { directory },
    );
  });
});
