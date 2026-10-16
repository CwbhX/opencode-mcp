/**
 * Layer B HTTP client wire tests (OpenCode v2).
 *
 * Drive `OpenCodeClient` and the prompt/command serializers against a
 * strict local `http.createServer` fake speaking the v2 wire shapes.
 * These are component tests of the HTTP transport + translation layer;
 * they do **not** launch `node dist/index.js`. Real MCP subprocess
 * coverage lives in `tests/integration/mcp-stdio.test.ts`.
 *
 * The fake is not OpenCode. It enforces the v2 contract points the
 * bridge depends on: prompts are `{id?, text}` (v1 `parts`/`model`/
 * `variant` keys are rejected), model+variant are set per session via
 * `POST /api/session/{id}/model`, responses are `{data}` envelopes,
 * directory scoping arrives as `location[directory]`, and POSTs are
 * counted so mutations are proven not to replay.
 *
 * Covered IDs: WIRE-01, REPLAY-01, REPLAY-04, MODEL-01, MODEL-02.
 */

import http from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  AmbiguousAcceptanceError,
  OpenCodeClient,
  OpenCodeError,
} from "../../src/client.js";
import {
  buildCommandBody,
  buildPromptBody,
} from "../../src/model-selection.js";

interface RecordedRequest {
  method: string;
  url: string;
  pathname: string;
  search: string;
  contentType: string;
  authorization: string;
  locationDirectory: string;
  rawBody: string;
  json: unknown;
}

interface FakeOptions {
  requireAuth?: boolean;
  expectedUser?: string;
  expectedPassword?: string;
  dropNextPost?: boolean;
  postStatus?: (req: RecordedRequest) => number | "drop";
}

function startFake(opts: FakeOptions = {}) {
  const requests: RecordedRequest[] = [];
  let postCount = 0;
  const messages: unknown[] = [];
  let sessionModel: Record<string, unknown> | undefined;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const host = req.headers.host ?? "127.0.0.1";
      const parsed = new URL(req.url ?? "/", `http://${host}`);
      const method = (req.method ?? "GET").toUpperCase();
      const contentType = String(req.headers["content-type"] ?? "");
      const recorded: RecordedRequest = {
        method,
        url: req.url ?? "/",
        pathname: parsed.pathname,
        search: parsed.search,
        contentType,
        authorization: String(req.headers.authorization ?? ""),
        locationDirectory: parsed.searchParams.get("location[directory]") ?? "",
        rawBody,
        json: undefined,
      };

      if (method !== "GET" && method !== "HEAD" && rawBody.length > 0) {
        if (!/application\/json/i.test(contentType)) {
          res.writeHead(415, { "Content-Type": "text/plain" });
          res.end("Content-Type must be application/json");
          return;
        }
        try {
          recorded.json = JSON.parse(rawBody);
        } catch {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("invalid JSON");
          return;
        }
      }

      requests.push(recorded);
      if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
        postCount += 1;
      }

      if (opts.requireAuth) {
        const expected = Buffer.from(
          `${opts.expectedUser ?? "opencode"}:${opts.expectedPassword ?? "secret"}`,
        ).toString("base64");
        if (recorded.authorization !== `Basic ${expected}`) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ _tag: "UnauthorizedError", message: "Authentication required" }));
          return;
        }
      }

      if (method === "POST") {
        const override = opts.postStatus?.(recorded);
        if (override === "drop" || opts.dropNextPost) {
          opts.dropNextPost = false;
          req.socket.destroy();
          return;
        }
        if (typeof override === "number") {
          res.writeHead(override, { "Content-Type": "text/plain" });
          res.end(override >= 400 ? "error" : "");
          return;
        }
      }

      const body = recorded.json as Record<string, unknown> | undefined;
      const send = (status: number, data?: unknown) => {
        if (status === 204) {
          res.writeHead(204);
          res.end();
          return;
        }
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      const invalid = (message: string) =>
        send(400, { _tag: "InvalidRequestError", message });

      // ── v2 routes ──
      if (method === "GET" && recorded.pathname === "/api/info") {
        return send(200, { version: "2.0.28-fake", urls: ["http://127.0.0.1"] });
      }
      if (method === "POST" && recorded.pathname === "/api/session") {
        return send(200, {
          data: {
            id: "ses_wire",
            projectID: "proj",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, updated: 1 },
            location: { directory: recorded.locationDirectory || "/tmp" },
          },
        });
      }
      if (method === "POST" && /\/api\/session\/[^/]+\/model$/.test(recorded.pathname)) {
        if (!body || !("model" in body) || typeof body.model !== "object" || body.model === null) {
          return invalid("model must be a Model.Ref object");
        }
        const model = body.model as Record<string, unknown>;
        if (typeof model.id !== "string" || typeof model.providerID !== "string") {
          return invalid("Model.Ref requires id + providerID");
        }
        if ("modelID" in model) return invalid("Model.Ref uses id, not modelID");
        sessionModel = model;
        return send(204);
      }
      if (method === "POST" && /\/api\/session\/[^/]+\/prompt$/.test(recorded.pathname)) {
        if (!body) return invalid("prompt body required");
        for (const banned of ["parts", "model", "variant", "agent", "system", "noReply", "messageID"]) {
          if (banned in body) return invalid(`v2 prompt rejects v1 key: ${banned}`);
        }
        if (typeof body.text !== "string") return invalid("prompt requires text");
        const user = {
          id: typeof body.id === "string" ? body.id : "msg_user_wire",
          type: "user",
          text: body.text,
          time: { created: 10 },
        };
        messages.push(user, {
          id: "msg_asst_wire",
          type: "assistant",
          agent: "build",
          model: sessionModel ?? { id: "default-model", providerID: "default-provider" },
          finish: "stop",
          time: { created: 11, completed: 12 },
          content: [{ type: "text", text: "wire answer" }],
        });
        return send(200, { data: { ...user, sessionID: "ses_wire", payload: { text: body.text }, delivery: "steer" } });
      }
      if (method === "POST" && /\/api\/session\/[^/]+\/command$/.test(recorded.pathname)) {
        if (!body || typeof body.name !== "string" || typeof body.text !== "string") {
          return invalid("command requires {name, text}");
        }
        if ("model" in body || "command" in body) return invalid("v1 command keys rejected");
        return send(204);
      }
      if (method === "POST" && /\/api\/experimental\/session\/[^/]+\/wait$/.test(recorded.pathname)) {
        return send(204);
      }
      if (method === "GET" && /\/api\/session\/[^/]+\/message$/.test(recorded.pathname)) {
        const limit = parsed.searchParams.get("limit");
        const page = limit ? messages.slice(0, Number(limit)) : messages;
        return send(200, { data: page, cursor: {} });
      }

      return send(200, { ok: true });
    });
  });

  return new Promise<{
    baseUrl: string;
    requests: RecordedRequest[];
    postCount: () => number;
    close: () => Promise<void>;
  }>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        requests,
        postCount: () => postCount,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
    server.on("error", reject);
  });
}

let fake: Awaited<ReturnType<typeof startFake>> | undefined;

afterEach(async () => {
  if (fake) {
    await fake.close();
    fake = undefined;
  }
});

function clientFor(baseUrl: string, extras?: ConstructorParameters<typeof OpenCodeClient>[0]) {
  return new OpenCodeClient({
    baseUrl,
    autoServe: false,
    password: "wire-pw",
    retryDelayMs: 0,
    ...extras,
  });
}

describe("Layer B OpenCode v2 HTTP wire (local fake)", () => {
  it("WIRE-01: prompt_async becomes model-set + {text} prompt on /api routes; acceptance resolves undefined", async () => {
    fake = await startFake();
    const client = clientFor(fake.baseUrl);
    const body = buildPromptBody({
      prompt: "hello",
      model: { providerID: "openrouter", modelID: "meta/muse-spark-open" },
      variant: "high",
      messageID: "msg_wire_req",
    });

    const result = await client.post("/session/ses_wire/prompt_async", body);
    expect(result).toBeUndefined();

    const posted = fake.requests.filter((r) => r.method === "POST");
    expect(posted.map((r) => r.pathname)).toEqual([
      "/api/session/ses_wire/model",
      "/api/session/ses_wire/prompt",
    ]);
    expect(posted[0].contentType).toMatch(/application\/json/i);
    expect(posted[0].json).toEqual({
      model: { id: "meta/muse-spark-open", providerID: "openrouter", variant: "high" },
    });
    expect(posted[1].json).toEqual({ id: "msg_wire_req", text: "hello" });
  });

  it("WIRE-01: health uses /api/info with mandatory Basic auth; 401 surfaces once", async () => {
    fake = await startFake({
      requireAuth: true,
      expectedUser: "opencode",
      expectedPassword: "s3cret",
    });

    const anon = clientFor(fake.baseUrl, { password: undefined });
    await expect(anon.get("/global/health")).rejects.toMatchObject({
      name: "OpenCodeError",
      status: 401,
      method: "GET",
      path: "/api/info",
    });
    expect(fake.requests.filter((r) => r.pathname === "/api/info")).toHaveLength(1);

    const authed = clientFor(fake.baseUrl, {
      username: "opencode",
      password: "s3cret",
    });
    await expect(authed.get("/global/health")).resolves.toEqual({
      healthy: true,
      version: "2.0.28-fake",
    });
  });

  it("MODEL-01: sync message applies variant via the session model, never nested in the prompt", async () => {
    fake = await startFake();
    const client = clientFor(fake.baseUrl);
    const body = buildPromptBody({
      prompt: "ping",
      model: { providerID: "openrouter", modelID: "meta/muse-spark-open" },
      variant: "max",
    });

    const result = (await client.post("/session/ses_wire/message", body)) as {
      info: Record<string, unknown>;
      parts: Array<Record<string, unknown>>;
    };
    expect(result.info.modelID).toBe("meta/muse-spark-open");
    expect(result.parts[0]?.text).toBe("wire answer");

    const prompt = fake.requests.find((r) => r.pathname.endsWith("/prompt"));
    expect(prompt?.json).toEqual({ text: "ping" });
    const modelCall = fake.requests.find((r) => r.pathname.endsWith("/model"));
    expect((modelCall?.json as { model: Record<string, unknown> }).model.variant).toBe("max");
  });

  it("MODEL-02: command sends {name,text}; the provider/model string is split onto the session model", async () => {
    fake = await startFake();
    const client = clientFor(fake.baseUrl);

    const valid = buildCommandBody({
      command: "init",
      arguments: "",
      model: { providerID: "openrouter", modelID: "meta/muse-spark-open" },
      variant: "fast",
    });
    expect(valid.model).toBe("openrouter/meta/muse-spark-open");

    await client.post("/session/ses_wire/command", valid);

    const command = fake.requests.find((r) => r.pathname.endsWith("/command"));
    expect(command?.json).toEqual({ name: "init", text: "" });
    const modelCall = fake.requests.find((r) => r.pathname.endsWith("/model"));
    expect(modelCall?.json).toEqual({
      model: { id: "meta/muse-spark-open", providerID: "openrouter", variant: "fast" },
    });
  });

  it("REPLAY-01: accepted POST then dropped connection is not replayed", async () => {
    fake = await startFake({ dropNextPost: true });
    const client = clientFor(fake.baseUrl);

    const err = await client
      .post("/session/ses_wire/prompt_async", buildPromptBody({ prompt: "do not replay" }))
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(err).toBeInstanceOf(AmbiguousAcceptanceError);
    const ambiguous = err as AmbiguousAcceptanceError;
    expect(ambiguous.details.safeToResubmit).toBe(false);
    expect(ambiguous.details.mayStillBeRunning).toBe(true);
    expect(fake.postCount()).toBe(1);
  });

  it("REPLAY-04: POST 503 is not automatically repeated", async () => {
    fake = await startFake({ postStatus: () => 503 });
    const client = clientFor(fake.baseUrl);

    await expect(
      client.post("/session/ses_wire/prompt_async", buildPromptBody({ prompt: "x" })),
    ).rejects.toBeInstanceOf(AmbiguousAcceptanceError);
    expect(fake.postCount()).toBe(1);
  });

  it("WIRE-04: 401 on POST is OpenCodeError and is not replayed", async () => {
    fake = await startFake({ requireAuth: true, expectedPassword: "s3cret" });
    const client = clientFor(fake.baseUrl, { password: undefined });
    await expect(
      client.post("/session/ses_wire/prompt_async", buildPromptBody({ prompt: "x" })),
    ).rejects.toMatchObject({
      name: "OpenCodeError",
      status: 401,
    } satisfies Partial<OpenCodeError>);
    expect(fake.postCount()).toBe(1);
  });
});
