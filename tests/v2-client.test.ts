import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../src/server-manager.js", () => ({
  ensureServer: vi.fn(),
  generateServerPassword: () => "generated-test-password",
}));

import { OpenCodeClient } from "../src/client.js";
import {
  buildFormAnswer,
  synthesizeProviderCatalog,
  translateMessages,
  unwrapV2,
} from "../src/v2-adapt.js";
import { formatMessageResponse } from "../src/helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResp(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => (data === undefined ? "" : JSON.stringify(data)),
    json: async () => data,
    body: null,
  } as unknown as Response;
}

/** Route-table fetch fake: key = "METHOD /api/..." (query ignored). */
function installFetch(routes: Record<string, (url: URL, init: RequestInit) => Response>) {
  const calls: Array<{ method: string; url: URL; body: unknown }> = [];
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${url.pathname}`;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const handler = routes[key];
    if (!handler) {
      return jsonResp({ _tag: "NotFound", message: `no fake route ${key}` }, 404);
    }
    return handler(url, init ?? {});
  });
  return { fetchMock, calls };
}

function makeClient(): OpenCodeClient {
  return new OpenCodeClient({
    baseUrl: "http://127.0.0.1:4096",
    password: "pw",
    retryDelayMs: 0,
  });
}

// ─── v2-adapt units ──────────────────────────────────────────────────────

describe("unwrapV2", () => {
  it("unwraps {data} and {location,data} and {data,cursor} envelopes", () => {
    expect(unwrapV2({ data: [1, 2] })).toEqual([1, 2]);
    expect(unwrapV2({ location: { directory: "/x" }, data: { a: 1 } })).toEqual({ a: 1 });
    expect(unwrapV2({ data: [], cursor: { next: "c" } })).toEqual([]);
  });

  it("leaves bare payloads and data-bearing content untouched", () => {
    expect(unwrapV2([{ id: 1 }])).toEqual([{ id: 1 }]);
    expect(unwrapV2({ data: "x", other: 1 })).toEqual({ data: "x", other: 1 });
    expect(unwrapV2("plain")).toBe("plain");
  });
});

describe("translateMessages", () => {
  const v2Messages = [
    { id: "msg_u1", type: "user", text: "hello", time: { created: 1 } },
    {
      id: "msg_a1",
      type: "assistant",
      agent: "build",
      model: { id: "m1", providerID: "p1", variant: "default" },
      finish: "stop",
      time: { created: 2, completed: 3 },
      cost: 0.01,
      tokens: { input: 5, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      content: [
        { type: "reasoning", text: "thinking" },
        { type: "text", text: "answer" },
        {
          type: "tool",
          id: "t1",
          name: "bash",
          state: { status: "completed", input: { command: "ls" }, content: [{ type: "text", text: "out" }] },
          time: { created: 2 },
        },
      ],
    },
    { id: "msg_i1", type: "idle", outcome: "succeeded", time: { created: 3 } },
  ];

  it("correlates assistants to the preceding user message via parentID", () => {
    const out = translateMessages(v2Messages);
    const assistant = out.find((m) => (m.info as { role?: string }).role === "assistant");
    expect(assistant).toBeDefined();
    const info = assistant!.info as Record<string, unknown>;
    expect(info.parentID).toBe("msg_u1");
    expect(info.providerID).toBe("p1");
    expect(info.modelID).toBe("m1");
    expect(info.finish).toBe("stop");
    const parts = assistant!.parts as Array<Record<string, unknown>>;
    expect(parts.find((p) => p.type === "text")?.text).toBe("answer");
    const tool = parts.find((p) => p.type === "tool");
    expect(tool?.toolName).toBe("bash");
    expect(tool?.output).toBe("out");
    // Succeeded idle markers are not conversation content.
    expect(out.some((m) => (m.info as { id?: string }).id === "msg_i1")).toBe(false);
  });

  it("turns a failed idle marker into an error assistant for the request", () => {
    const out = translateMessages([
      { id: "msg_u1", type: "user", text: "hi", time: { created: 1 } },
      {
        id: "msg_i1",
        type: "idle",
        outcome: "failed",
        error: { type: "ProviderError", message: "boom", status: 502 },
        time: { created: 2 },
      },
    ]);
    const assistant = out.find((m) => (m.info as { role?: string }).role === "assistant");
    const info = assistant!.info as Record<string, unknown>;
    expect(info.parentID).toBe("msg_u1");
    expect((info.error as Record<string, unknown>).name).toBe("ProviderError");
    expect((info.error as Record<string, unknown>).message).toBe("boom");
  });
});

describe("synthesizeProviderCatalog", () => {
  it("groups models by provider, records variant keys, marks connected providers", () => {
    const catalog = synthesizeProviderCatalog({
      models: [
        {
          id: "openrouter/m1",
          modelID: "m1",
          providerID: "openrouter",
          name: "M1",
          variants: [{ id: "low", settings: {} }, { id: "high", settings: {} }],
          cost: [{ input: 1.5, output: 2.5 }],
        },
        { id: "x", modelID: "m2", providerID: "unconnected", name: "M2", variants: [], cost: [] },
      ],
      providers: [],
      integrations: [
        { id: "openrouter", name: "OpenRouter", methods: [], connections: [{ id: "c1" }] },
        { id: "unconnected", name: "Nope", methods: [], connections: [] },
      ],
      defaultModel: { providerID: "openrouter", modelID: "m1" },
    });
    const all = catalog.all as Array<Record<string, unknown>>;
    const or = all.find((p) => p.id === "openrouter")!;
    expect(or.source).toBe("api");
    const m1 = (or.models as Record<string, Record<string, unknown>>).m1!;
    expect(Object.keys(m1.variants as object)).toEqual(["low", "high"]);
    expect(m1.cost).toEqual({ input: 1.5, output: 2.5 });
    expect(all.find((p) => p.id === "unconnected")?.source).toBe("custom");
    expect(catalog.default).toEqual({ openrouter: "m1" });
    expect(catalog.connected).toEqual(["openrouter"]);
  });
});

describe("formatMessageResponse with v2 parts", () => {
  it("omits reasoning traces and renders tool parts", () => {
    const out = formatMessageResponse({
      parts: [
        { type: "reasoning", text: "secret deliberation" },
        { type: "text", text: "visible answer" },
        { type: "tool", toolName: "bash", output: "ran ok" },
      ],
    });
    expect(out).toContain("visible answer");
    expect(out).not.toContain("secret deliberation");
    expect(out).toContain("[Tool: bash] ran ok");
  });
});

describe("buildFormAnswer", () => {
  it("maps positional labels to field keys and option values", () => {
    const form = {
      fields: [
        { key: "color", type: "string", options: [{ value: "r", label: "Red" }, { value: "b", label: "Blue" }] },
        { key: "tags", type: "multiselect", options: [{ value: "1", label: "One" }] },
        { key: "note", type: "string" },
      ],
    };
    expect(buildFormAnswer(form, [["Blue"], ["One", "custom"], ["hi"]])).toEqual({
      color: "b",
      tags: ["1", "custom"],
      note: "hi",
    });
  });
});

// ─── client wire translation ─────────────────────────────────────────────

describe("v2 client translation", () => {
  it("sync prompt: sets session model, prompts, waits, returns correlated assistant", async () => {
    const { calls } = installFetch({
      "POST /api/session/ses_1/model": () => jsonResp(undefined, 204),
      "POST /api/session/ses_1/prompt": () =>
        jsonResp({ data: { id: "msg_u9", sessionID: "ses_1", type: "user" } }),
      "POST /api/experimental/session/ses_1/wait": () => jsonResp(undefined, 204),
      "GET /api/session/ses_1/message": () =>
        jsonResp({
          data: [
            { id: "msg_u9", type: "user", text: "q", time: { created: 1 } },
            {
              id: "msg_a9",
              type: "assistant",
              model: { id: "m1", providerID: "p1", variant: "high" },
              finish: "stop",
              time: { created: 2, completed: 3 },
              content: [{ type: "text", text: "the answer" }],
            },
          ],
          cursor: {},
        }),
    });

    const client = makeClient();
    const result = (await client.post("/session/ses_1/message", {
      parts: [{ type: "text", text: "q" }],
      model: { providerID: "p1", modelID: "m1" },
      variant: "high",
    })) as { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };

    expect(result.info.modelID).toBe("m1");
    expect(result.info.parentID).toBe("msg_u9");
    expect(result.parts[0]?.text).toBe("the answer");

    const modelCall = calls.find((c) => c.url.pathname.endsWith("/model"));
    expect(modelCall?.body).toEqual({
      model: { id: "m1", providerID: "p1", variant: "high" },
    });
    const promptCall = calls.find((c) => c.url.pathname.endsWith("/prompt"));
    expect(promptCall?.body).toEqual({ text: "q" });
  });

  it("async prompt: client-minted message id is forwarded and acceptance returns undefined", async () => {
    const { calls } = installFetch({
      "POST /api/session/ses_1/prompt": () =>
        jsonResp({ data: { id: "msg_req1", sessionID: "ses_1", type: "user" } }),
    });
    const client = makeClient();
    const result = await client.post("/session/ses_1/prompt_async", {
      parts: [{ type: "text", text: "do it" }],
      messageID: "msg_req1",
    });
    expect(result).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ id: "msg_req1", text: "do it" });
  });

  it("health: synthesizes {healthy, version} from /api/info", async () => {
    installFetch({
      "GET /api/info": () =>
        jsonResp({ version: "2.0.28", urls: ["http://127.0.0.1:4096"] }),
    });
    const client = makeClient();
    await expect(client.get("/global/health")).resolves.toEqual({
      healthy: true,
      version: "2.0.28",
    });
  });

  it("session create: sends location + Model.Ref and translates directory back", async () => {
    const { calls } = installFetch({
      "POST /api/session": () =>
        jsonResp({
          data: {
            id: "ses_9",
            projectID: "p",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 10, updated: 10 },
            location: { directory: "/tmp" },
          },
        }),
    });
    const client = makeClient();
    const created = (await client.post(
      "/session",
      { title: "t", model: { providerID: "p1", modelID: "m1" } },
      { directory: "/tmp" },
    )) as Record<string, unknown>;
    expect(calls[0]?.body).toEqual({
      title: "t",
      model: { id: "m1", providerID: "p1" },
      location: { directory: "/tmp" },
    });
    expect(created.id).toBe("ses_9");
    expect(created.directory).toBe("/tmp");
  });

  it("session status: running sessions map to busy, absence stays absent", async () => {
    installFetch({
      "GET /api/session/active": () =>
        jsonResp({ data: { ses_busy: { type: "running" } } }),
    });
    const client = makeClient();
    await expect(client.get("/session/status")).resolves.toEqual({
      ses_busy: { type: "busy" },
    });
  });

  it("permission reply: resolves the session from the pending list, sends {decision}", async () => {
    const { calls } = installFetch({
      "GET /api/permission/request": () =>
        jsonResp({
          location: { directory: "/tmp" },
          data: [{ id: "per_1", sessionID: "ses_7", action: "bash", resources: ["ls"] }],
        }),
      "POST /api/session/ses_7/permission/per_1/reply": () => jsonResp(undefined, 204),
    });
    const client = makeClient();
    await client.post("/permission/per_1/reply", { reply: "once" }, { directory: "/tmp" });
    const reply = calls.find((c) => c.url.pathname.includes("/permission/per_1/reply"));
    expect(reply?.body).toEqual({ decision: "once" });
  });

  it("question list maps v2 forms; reply maps labels to a keyed answer", async () => {
    const form = {
      id: "frm_1",
      sessionID: "ses_3",
      title: "Pick",
      fields: [
        { key: "color", type: "string", title: "Color?", options: [{ value: "b", label: "Blue" }] },
      ],
    };
    const { calls } = installFetch({
      "GET /api/form": () => jsonResp({ location: { directory: "/tmp" }, data: [form] }),
      "POST /api/session/ses_3/form/frm_1/reply": () => jsonResp(undefined, 204),
    });
    const client = makeClient();
    const questions = (await client.get("/question", undefined, "/tmp")) as Array<
      Record<string, unknown>
    >;
    expect(questions[0]?.id).toBe("frm_1");
    const qs = questions[0]?.questions as Array<Record<string, unknown>>;
    expect(qs[0]?.question).toBe("Color?");

    await client.post("/question/frm_1/reply", { answers: [["Blue"]] }, { directory: "/tmp" });
    const reply = calls.find((c) => c.url.pathname.includes("/form/frm_1/reply"));
    expect(reply?.body).toEqual({ answer: { color: "b" } });
  });

  it("file content: raw octet-stream body becomes {content}", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/octet-stream" }),
      text: async () => "file body here",
      json: async () => {
        throw new Error("no json");
      },
      body: null,
    } as unknown as Response);
    const client = makeClient();
    await expect(
      client.get("/file/content", { path: "src/a.ts" }, "/tmp"),
    ).resolves.toEqual({ content: "file body here" });
  });

  it("unsupported v1-only endpoints fail with a clear v2 error and no fetch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const client = makeClient();
    await expect(client.post("/tui/append-prompt", { text: "x" })).rejects.toThrow(
      /not available on OpenCode v2/,
    );
    await expect(client.get("/session/ses_1/todo")).rejects.toThrow(
      /not available on OpenCode v2/,
    );
    await expect(client.get("/lsp")).rejects.toThrow(/not available on OpenCode v2/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("abort maps to interrupt; summarize maps to compact after model selection", async () => {
    const { calls } = installFetch({
      "POST /api/session/ses_2/interrupt": () => jsonResp(undefined, 204),
      "POST /api/session/ses_2/model": () => jsonResp(undefined, 204),
      "POST /api/session/ses_2/compact": () =>
        jsonResp({ data: { id: "msg_c1", type: "compaction" } }),
    });
    const client = makeClient();
    await client.post("/session/ses_2/abort");
    await client.post("/session/ses_2/summarize", { providerID: "p1", modelID: "m1" });
    expect(calls.map((c) => c.url.pathname)).toEqual([
      "/api/session/ses_2/interrupt",
      "/api/session/ses_2/model",
      "/api/session/ses_2/compact",
    ]);
  });
});
