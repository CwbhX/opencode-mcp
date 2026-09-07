/**
 * Layer B HTTP wire tests.
 *
 * Drive `OpenCodeClient` and the prompt/command serializers against a strict
 * local `http.createServer` fake. This is easier and more stable than spawning
 * `node dist/index.js` plus an MCP SDK client. It still records the actual
 * method/path/headers/body the bridge sends.
 *
 * The fake is not OpenCode. It rejects invalid command-model objects, nested
 * prompt variants, and invalid JSON; returns 204 for prompt_async; can return
 * 401; and counts POSTs so mutations are proven not to replay.
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
  directory: string;
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
        directory: String(req.headers["x-opencode-directory"] ?? ""),
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

      if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
        postCount += 1;
        requests.push(recorded);
      } else {
        requests.push(recorded);
      }

      if (opts.requireAuth) {
        const expected = Buffer.from(
          `${opts.expectedUser ?? "opencode"}:${opts.expectedPassword ?? "secret"}`,
        ).toString("base64");
        if (recorded.authorization !== `Basic ${expected}`) {
          res.writeHead(401, { "Content-Type": "text/plain" });
          res.end("unauthorized");
          return;
        }
      }

      if (recorded.directory && recorded.directory.startsWith("~")) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("bad directory routing");
        return;
      }

      const body = recorded.json;
      if (body && typeof body === "object") {
        const rec = body as Record<string, unknown>;
        if (rec.model && typeof rec.model === "object") {
          const model = rec.model as Record<string, unknown>;
          if ("variant" in model) {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("nested prompt variant is invalid");
            return;
          }
        }
        if (
          recorded.pathname.endsWith("/command") &&
          rec.model !== undefined &&
          typeof rec.model !== "string"
        ) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("command model must be a provider/model string");
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
        if (recorded.pathname.endsWith("/prompt_async")) {
          res.writeHead(204);
          res.end();
          return;
        }
        if (recorded.pathname === "/session") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "ses_wire" }));
          return;
        }
        if (recorded.pathname.endsWith("/command")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (recorded.pathname === "/session/ses_wire/message") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ info: { id: "msg_1", role: "assistant" }, parts: [] }));
        return;
      }

      if (recorded.pathname === "/global/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ healthy: true, version: "1.18.29-fake" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  return new Promise<{
    baseUrl: string;
    requests: RecordedRequest[];
    postCount: () => number;
    close: () => Promise<void>;
    setDropNextPost: (value: boolean) => void;
  }>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        requests,
        postCount: () => postCount,
        setDropNextPost: (value) => {
          opts.dropNextPost = value;
        },
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
    retryDelayMs: 0,
    ...extras,
  });
}

describe("Layer B OpenCode HTTP wire (local fake)", () => {
  it("WIRE-01: POST JSON Content-Type and body; prompt_async returns 204 without JSON parse", async () => {
    fake = await startFake();
    const client = clientFor(fake.baseUrl);
    const body = buildPromptBody({
      prompt: "hello",
      model: { providerID: "opencode", modelID: "muse-spark-1.3-contributor-free" },
      variant: "fast",
    });

    const result = await client.post("/session/ses_wire/prompt_async", body);
    expect(result).toBeUndefined();

    const posted = fake.requests.filter((r) => r.method === "POST");
    expect(posted).toHaveLength(1);
    expect(posted[0].pathname).toBe("/session/ses_wire/prompt_async");
    expect(posted[0].contentType).toMatch(/application\/json/i);
    expect(posted[0].rawBody).toBe(JSON.stringify(body));
    expect(() => JSON.parse(posted[0].rawBody)).not.toThrow();
    expect(posted[0].json).toEqual(body);
  });

  it("WIRE-01: GET query string is forwarded; authenticated GET can 401", async () => {
    fake = await startFake({
      requireAuth: true,
      expectedUser: "opencode",
      expectedPassword: "s3cret",
    });

    const anon = clientFor(fake.baseUrl);
    await expect(anon.get("/global/health")).rejects.toMatchObject({
      name: "OpenCodeError",
      status: 401,
      method: "GET",
      path: "/global/health",
    });
    expect(fake.requests.filter((r) => r.pathname === "/global/health")).toHaveLength(1);

    const authed = clientFor(fake.baseUrl, {
      username: "opencode",
      password: "s3cret",
    });
    await expect(authed.get("/global/health")).resolves.toEqual({
      healthy: true,
      version: "1.18.29-fake",
    });
    await expect(
      authed.get("/session/ses_wire/message", { limit: "2" }),
    ).resolves.toMatchObject({ info: { id: "msg_1" } });

    const listed = fake.requests.find((r) => r.pathname === "/session/ses_wire/message");
    expect(listed?.search).toBe("?limit=2");
  });

  it("MODEL-01: prompt body is a model object plus top-level variant (not nested)", async () => {
    fake = await startFake();
    const client = clientFor(fake.baseUrl);
    const body = buildPromptBody({
      prompt: "ping",
      model: { providerID: "opencode", modelID: "muse-spark-1.3-contributor-free" },
      variant: "max",
    });

    await client.post("/session/ses_wire/message", body);

    const posted = fake.requests.find((r) => r.pathname.endsWith("/message"));
    expect(posted?.json).toEqual({
      parts: [{ type: "text", text: "ping" }],
      model: {
        providerID: "opencode",
        modelID: "muse-spark-1.3-contributor-free",
      },
      variant: "max",
    });
    const model = (posted?.json as { model?: Record<string, unknown> }).model;
    expect(model).not.toHaveProperty("variant");
  });

  it("MODEL-02: command model is a provider/model string; object model is rejected by the fake", async () => {
    fake = await startFake();
    const client = clientFor(fake.baseUrl);

    await expect(
      client.post("/session/ses_wire/command", {
        command: "init",
        model: { providerID: "opencode", modelID: "muse-spark-1.3-contributor-free" },
      }),
    ).rejects.toMatchObject({
      name: "OpenCodeError",
      status: 400,
    });
    expect(fake.postCount()).toBe(1);

    const valid = buildCommandBody({
      command: "init",
      model: { providerID: "opencode", modelID: "muse-spark-1.3-contributor-free" },
      variant: "fast",
    });
    expect(valid.model).toBe("opencode/muse-spark-1.3-contributor-free");
    expect(valid.variant).toBe("fast");
    await expect(client.post("/session/ses_wire/command", valid)).resolves.toEqual({
      ok: true,
    });
    expect(fake.postCount()).toBe(2);
  });

  it("REPLAY-01: accepted POST then dropped connection is not replayed", async () => {
    fake = await startFake({ dropNextPost: true });
    const client = clientFor(fake.baseUrl);
    const body = buildPromptBody({ prompt: "do not replay" });

    const err = await client
      .post("/session/ses_wire/prompt_async", body)
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
    fake = await startFake({
      postStatus: () => 503,
    });
    const client = clientFor(fake.baseUrl);

    await expect(
      client.post("/session/ses_wire/prompt_async", buildPromptBody({ prompt: "x" })),
    ).rejects.toBeInstanceOf(AmbiguousAcceptanceError);
    expect(fake.postCount()).toBe(1);
  });

  it("WIRE-04: 401 on POST is OpenCodeError and is not replayed", async () => {
    fake = await startFake({
      requireAuth: true,
      expectedPassword: "s3cret",
    });
    const client = clientFor(fake.baseUrl);
    await expect(
      client.post("/session/ses_wire/prompt_async", buildPromptBody({ prompt: "x" })),
    ).rejects.toMatchObject({
      name: "OpenCodeError",
      status: 401,
    } satisfies Partial<OpenCodeError>);
    expect(fake.postCount()).toBe(1);
  });
});
