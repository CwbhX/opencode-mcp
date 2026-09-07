import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Mock the server-manager module so reconnect-path tests don't try to boot
 * a real OpenCode server. The `vi.hoisted` block keeps the mock references
 * accessible from both the (hoisted) `vi.mock` factory and the test body.
 */
const { isServerRunningMock, ensureServerMock } = vi.hoisted(() => ({
  isServerRunningMock: vi.fn(),
  ensureServerMock: vi.fn(),
}));
vi.mock("../src/server-manager.js", () => ({
  isServerRunning: isServerRunningMock,
  ensureServer: ensureServerMock,
}));

/**
 * Mock `@opencode-ai/sdk` so every call to `createOpencodeClient` (both the
 * one in the `OpenCodeClient` constructor and the one issued by
 * `buildSdkClient` during reconnect) returns a fresh object. Tests that
 * assert SDK-client identity after a URL rebind rely on this.
 */
vi.mock("@opencode-ai/sdk", () => ({
  createOpencodeClient: () => ({ _client: {} }),
  OpencodeClient: vi.fn(),
}));

import { OpenCodeClient, OpenCodeError, AmbiguousAcceptanceError } from "../src/client.js";
import { normalizeDirectory } from "../src/helpers.js";

function headerOf(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found?.[1] ?? null;
  }
  const rec = headers as Record<string, string>;
  const direct = rec[name] ?? rec[name.toLowerCase()];
  if (direct) return direct;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? rec[key] : null;
}

function mockResponse(opts: {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  text?: () => Promise<string>;
  json?: () => Promise<unknown>;
}): Response {
  const status = opts.status ?? 200;
  const body = opts.body ?? "";
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(opts.headers),
    text: opts.text ?? (async () => body),
    json:
      opts.json ??
      (async () => {
        if (!body) throw new Error("JSON.parse should not run on an empty body");
        return JSON.parse(body);
      }),
    body: null,
  } as unknown as Response;
}

function jsonOk(data: unknown, status = 200): Response {
  return mockResponse({ status, body: JSON.stringify(data) });
}

function makeClient(
  overrides?: ConstructorParameters<typeof OpenCodeClient>[0],
): OpenCodeClient {
  return new OpenCodeClient({
    baseUrl: "http://localhost:4096",
    retryDelayMs: 0,
    ...overrides,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── OpenCodeError ───────────────────────────────────────────────────────

describe("OpenCodeError", () => {
  it("creates error with all fields", () => {
    const err = new OpenCodeError("fail", 500, "GET", "/test", "body");
    expect(err.message).toBe("fail");
    expect(err.status).toBe(500);
    expect(err.method).toBe("GET");
    expect(err.path).toBe("/test");
    expect(err.body).toBe("body");
    expect(err.name).toBe("OpenCodeError");
  });

  describe("isTransient", () => {
    it.each([429, 502, 503, 504])("returns true for status %i", (status) => {
      const err = new OpenCodeError("", status, "", "", "");
      expect(err.isTransient).toBe(true);
    });

    it.each([400, 401, 403, 404, 500])("returns false for status %i", (status) => {
      const err = new OpenCodeError("", status, "", "", "");
      expect(err.isTransient).toBe(false);
    });
  });

  describe("isNotFound", () => {
    it("returns true for 404", () => {
      const err = new OpenCodeError("", 404, "", "", "");
      expect(err.isNotFound).toBe(true);
    });

    it("returns false for other statuses", () => {
      const err = new OpenCodeError("", 500, "", "", "");
      expect(err.isNotFound).toBe(false);
    });
  });

  describe("isAuth", () => {
    it.each([401, 403])("returns true for status %i", (status) => {
      const err = new OpenCodeError("", status, "", "", "");
      expect(err.isAuth).toBe(true);
    });

    it("returns false for other statuses", () => {
      const err = new OpenCodeError("", 500, "", "", "");
      expect(err.isAuth).toBe(false);
    });
  });
});

// ─── OpenCodeClient construction ─────────────────────────────────────────

describe("OpenCodeClient", () => {
  describe("constructor", () => {
    it("strips trailing slash from baseUrl", () => {
      const client = new OpenCodeClient({ baseUrl: "http://localhost:4096/" });
      expect(client.getBaseUrl()).toBe("http://localhost:4096");
    });

    it("preserves baseUrl without trailing slash", () => {
      const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
      expect(client.getBaseUrl()).toBe("http://localhost:4096");
    });

    it("exposes the underlying SDK client via `api`", () => {
      const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
      expect(client.api).toBeDefined();
    });
  });

  describe("autoServe option", () => {
    it("defaults autoServe to false", () => {
      const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
      expect(client.getBaseUrl()).toBe("http://localhost:4096");
    });

    it("accepts autoServe option in constructor", () => {
      const client = new OpenCodeClient({
        baseUrl: "http://localhost:4096",
        autoServe: true,
      });
      expect(client.getBaseUrl()).toBe("http://localhost:4096");
    });
  });

  describe("auth credentials", () => {
    it("constructs without auth when neither username nor password is provided", () => {
      expect(
        () => new OpenCodeClient({ baseUrl: "http://localhost:4096" }),
      ).not.toThrow();
    });

    it("constructs with password-only auth (default username 'opencode')", () => {
      expect(
        () =>
          new OpenCodeClient({
            baseUrl: "http://localhost:4096",
            password: "secret",
          }),
      ).not.toThrow();
    });

    it("constructs with username+password auth", () => {
      expect(
        () =>
          new OpenCodeClient({
            baseUrl: "http://localhost:4096",
            username: "admin",
            password: "secret",
          }),
      ).not.toThrow();
    });

    it("sends Basic Authorization when password is set", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonOk({ ok: true }));
      const client = makeClient({ password: "secret" });
      await client.get("/health");
      expect(headerOf(fetchMock.mock.calls[0][1] as RequestInit, "authorization")).toBe(
        "Basic " + Buffer.from("opencode:secret").toString("base64"),
      );
    });

    it("uses the provided username in the Basic header", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonOk({ ok: true }));
      const client = makeClient({ username: "admin", password: "secret" });
      await client.get("/health");
      expect(headerOf(fetchMock.mock.calls[0][1] as RequestInit, "authorization")).toBe(
        "Basic " + Buffer.from("admin:secret").toString("base64"),
      );
    });
  });
});

// ─── normalizeDirectory (used by every dispatch path) ────────────────────

describe("normalizeDirectory", () => {
  it("returns undefined when input is undefined", () => {
    expect(normalizeDirectory(undefined)).toBeUndefined();
  });

  it("returns absolute path unchanged when it exists", () => {
    expect(normalizeDirectory("/tmp")).toBe("/tmp");
  });

  it("strips trailing slash", () => {
    expect(normalizeDirectory("/tmp/")).toBe("/tmp");
  });

  it("resolves '..' segments", () => {
    expect(normalizeDirectory("/tmp/foo/..")).toBe("/tmp");
  });

  it("throws for non-existent directory", () => {
    expect(() =>
      normalizeDirectory("/this/absolutely/does/not/exist/xyz123"),
    ).toThrow("does not exist");
  });
});

// ─── x-opencode-directory header (regression: must NOT be URI-encoded) ───

describe("x-opencode-directory header", () => {
  /**
   * Regression test for the bug where directory paths like `/tmp/proj` were
   * URI-encoded to `%2Ftmp%2Fproj` before being placed in the header. The
   * OpenCode server treats the header value as a literal absolute filesystem
   * path, so encoding broke project scoping for every tool that accepts a
   * `directory` argument.
   */
  it("sends the raw normalized path (no URI encoding)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonOk({}));

    const client = makeClient();
    await client.get("/project/current", undefined, "/tmp");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const value = headerOf(fetchMock.mock.calls[0][1] as RequestInit, "x-opencode-directory");
    expect(value).toBe("/tmp");
    expect(value).not.toContain("%2F");
  });

  it("omits the header when no directory is provided", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonOk({}));

    const client = makeClient();
    await client.get("/project/current");

    expect(headerOf(fetchMock.mock.calls[0][1] as RequestInit, "x-opencode-directory")).toBeNull();
  });
});

// ─── Reconnect path: URL rebinding + reconnectAttempts reset ─────────────

describe("reconnect path", () => {
  beforeEach(() => {
    isServerRunningMock.mockReset();
    ensureServerMock.mockReset();
  });

  /**
   * The read path tries the original URL up to MAX_RETRIES + 1 times, then
   * may reconnect and issue one more GET. Tests inject retryDelayMs: 0 so
   * this stays fast.
   */
  const MAX_RETRIES_PLUS_ONE = 3;

  function mockFlakyThenOk(): { urls: string[] } {
    const urls: string[] = [];
    let count = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      count++;
      urls.push(String(input));
      if (count <= MAX_RETRIES_PLUS_ONE) {
        throw new Error("fetch failed");
      }
      return jsonOk({ ok: true });
    });
    return { urls };
  }

  it("rebuilds the SDK client when ensureServer returns a different url", async () => {
    const { urls } = mockFlakyThenOk();

    const client = makeClient({ autoServe: true });
    const originalApi = client.api;

    isServerRunningMock.mockResolvedValueOnce({ healthy: false });
    ensureServerMock.mockResolvedValueOnce({
      running: true,
      version: "1.14.46",
      managedByUs: true,
      url: "http://localhost:5000",
    });

    await client.get("/health");

    expect(ensureServerMock).toHaveBeenCalledOnce();
    expect(client.getBaseUrl()).toBe("http://localhost:5000");
    expect(urls[0]).toContain("http://localhost:4096");
    expect(urls[urls.length - 1]).toContain("http://localhost:5000");
    expect(client.api).not.toBe(originalApi);
  });

  it("does not rebuild the SDK client when ensureServer returns the same url", async () => {
    mockFlakyThenOk();

    const client = makeClient({ autoServe: true });
    const originalApi = client.api;

    isServerRunningMock.mockResolvedValueOnce({ healthy: false });
    ensureServerMock.mockResolvedValueOnce({
      running: true,
      version: "1.14.46",
      managedByUs: true,
      url: "http://localhost:4096",
    });

    await client.get("/health");

    expect(client.getBaseUrl()).toBe("http://localhost:4096");
    expect(client.api).toBe(originalApi);
  });

  it("resets reconnectAttempts after a successful request", async () => {
    const client = makeClient({ autoServe: true });

    for (let i = 0; i < 4; i++) {
      mockFlakyThenOk();
      isServerRunningMock.mockResolvedValueOnce({ healthy: true, version: "1.14.46" });
      await client.get("/health");
    }

    expect(isServerRunningMock).toHaveBeenCalledTimes(4);
  });

  it("does not auto-start or replay a mutation after a connection drop", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch failed"));

    const client = makeClient({ autoServe: true });
    await expect(client.post("/session", { title: "x" })).rejects.toBeInstanceOf(
      AmbiguousAcceptanceError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ensureServerMock).not.toHaveBeenCalled();
  });
});

// ─── SSE line-ending handling ────────────────────────────────────────────

describe("subscribeSSE", () => {
  /**
   * Build a `ReadableStream<Uint8Array>` from a single string. Used to
   * drive `subscribeSSE` without standing up an HTTP server.
   */
  function streamFrom(body: string): ReadableStream<Uint8Array> {
    const encoded = new TextEncoder().encode(body);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoded);
        controller.close();
      },
    });
  }

  function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
  }

  /** Drive a fake `fetch` so `subscribeSSE` consumes our scripted body. */
  function installFakeFetch(body: string) {
    return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: streamFrom(body),
      text: async () => "",
    } as unknown as Response);
  }

  /**
   * Regression: the SSE parser used to `split("\n")`, which left a
   * trailing `\r` on every line when servers emit `\r\n` (RFC 8895
   * permits CRLF). That broke the event name (`"message\r"` instead of
   * `"message"`) and the blank-line dispatcher (`"\r" !== ""`).
   */
  it("parses events when the server uses CRLF line endings", async () => {
    const body =
      "event: ready\r\n" +
      "data: hello\r\n" +
      "\r\n" +
      "event: chunk\r\n" +
      "data: world\r\n" +
      "\r\n";
    installFakeFetch(body);

    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
    const events: Array<{ event: string; data: string }> = [];
    for await (const e of client.subscribeSSE("/events")) {
      events.push(e);
    }

    expect(events).toEqual([
      { event: "ready", data: "hello" },
      { event: "chunk", data: "world" },
    ]);
  });

  it("still parses events when the server uses LF line endings", async () => {
    const body = "event: ready\ndata: hello\n\n";
    installFakeFetch(body);

    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
    const events: Array<{ event: string; data: string }> = [];
    for await (const e of client.subscribeSSE("/events")) {
      events.push(e);
    }

    expect(events).toEqual([{ event: "ready", data: "hello" }]);
  });

  it("joins multiple data: lines with a newline", async () => {
    installFakeFetch("event: msg\ndata: line1\ndata: line2\n\n");

    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
    const events: Array<{ event: string; data: string }> = [];
    for await (const e of client.subscribeSSE("/events")) {
      events.push(e);
    }

    expect(events).toEqual([{ event: "msg", data: "line1\nline2" }]);
  });

  it("ignores colon-prefix heartbeat comments", async () => {
    installFakeFetch(": keep-alive\n\nevent: ping\ndata: ok\n\n");

    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
    const events: Array<{ event: string; data: string }> = [];
    for await (const e of client.subscribeSSE("/events")) {
      events.push(e);
    }

    expect(events).toEqual([{ event: "ping", data: "ok" }]);
  });

  it("reassembles UTF-8 characters split across chunks", async () => {
    const encoded = new TextEncoder().encode("event: ready\ndata: café\n\n");
    const splitAt = encoded.indexOf(0xc3);
    expect(splitAt).toBeGreaterThan(0);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: streamFromChunks([encoded.slice(0, splitAt + 1), encoded.slice(splitAt + 1)]),
      text: async () => "",
    } as unknown as Response);

    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
    const events: Array<{ event: string; data: string }> = [];
    for await (const e of client.subscribeSSE("/events")) {
      events.push(e);
    }

    expect(events).toEqual([{ event: "ready", data: "café" }]);
  });

  it("throws OpenCodeError on a non-2xx SSE response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 503,
      body: null,
      text: async () => "unavailable",
    } as unknown as Response);

    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
    await expect(async () => {
      for await (const _ of client.subscribeSSE("/events")) {
        /* drain */
      }
    }).rejects.toMatchObject({
      name: "OpenCodeError",
      status: 503,
      method: "GET",
      path: "/events",
    });
  });

  it("sends x-opencode-directory when a directory is provided", async () => {
    const fetchMock = installFakeFetch("event: ready\ndata: hi\n\n");
    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
    for await (const _ of client.subscribeSSE("/event", { directory: "/tmp" })) {
      /* drain */
    }
    expect(headerOf(fetchMock.mock.calls[0][1] as RequestInit, "x-opencode-directory")).toBe(
      "/tmp",
    );
  });
});

// ─── Wire / replay / deadline (FIX-01, FIX-04) ───────────────────────────

describe("operation-aware fetch adapter", () => {
  it("WIRE-01: POST JSON Content-Type + serialized JSON; 204 returns undefined without parse throw", async () => {
    const payload = { foo: 1, nested: { a: "b" } };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      expect(headerOf(init, "content-type")).toMatch(/application\/json/i);
      expect(init?.body).toBe(JSON.stringify(payload));
      expect(init?.body).not.toBe(String(payload));
      expect(init?.body).not.toBe("[object Object]");
      return mockResponse({
        status: 204,
        json: async () => {
          throw new Error("JSON.parse/json() must not run on 204");
        },
      });
    });

    const client = makeClient();
    const result = await client.post("/session", payload);
    expect(result).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("WIRE-02: non-2xx empty body still errors; network failure on GET is OpenCode/transport error with method/path", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse({ status: 400, body: "" }));

    const client = makeClient();
    await expect(client.get("/missing")).rejects.toMatchObject({
      name: "OpenCodeError",
      status: 400,
      method: "GET",
      path: "/missing",
    });

    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error("fetch failed"));
    const err = await client.get("/health").then(
      () => undefined,
      (error: unknown) => error as OpenCodeError,
    );
    expect(err).toBeInstanceOf(OpenCodeError);
    expect(err?.method).toBe("GET");
    expect(err?.path).toBe("/health");
    expect(err?.message).toMatch(/GET/);
    expect(err?.message).toMatch(/\/health/);
  });

  it("WIRE-03: GET transient 503 retried, then success; retry count bounded", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse({ status: 503, body: "unavailable" }))
      .mockResolvedValueOnce(jsonOk({ ok: true }));

    const client = makeClient();
    await expect(client.get("/health")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 503, body: "unavailable" }))
      .mockResolvedValueOnce(mockResponse({ status: 503, body: "unavailable" }))
      .mockResolvedValueOnce(mockResponse({ status: 503, body: "unavailable" }))
      .mockResolvedValueOnce(jsonOk({ ok: true }));

    await expect(client.get("/health")).rejects.toMatchObject({
      name: "OpenCodeError",
      status: 503,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("honors Retry-After seconds on GET 503 when the wait fits the budget", async () => {
    const sleeps: number[] = [];
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        mockResponse({ status: 503, body: "wait", headers: { "Retry-After": "2" } }),
      )
      .mockResolvedValueOnce(jsonOk({ ok: true }));

    const client = makeClient({
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await expect(client.get("/health")).resolves.toEqual({ ok: true });
    expect(sleeps).toEqual([2000]);
  });

  it("WIRE-04: 401 is not retried", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(mockResponse({ status: 401, body: "nope" }));

    const client = makeClient({ autoServe: true });
    await expect(client.get("/health")).rejects.toMatchObject({
      name: "OpenCodeError",
      status: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ensureServerMock).not.toHaveBeenCalled();
  });

  it("REPLAY-01: POST prompt accepted then socket drop => AmbiguousAcceptanceError, fetch called once", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("socket hang up"));

    const client = makeClient({ autoServe: true });
    const err = await client
      .post("/session/s1/prompt_async", { parts: [{ type: "text", text: "hi" }] })
      .then(
        () => undefined,
        (error: unknown) => error as AmbiguousAcceptanceError,
      );

    expect(err).toBeInstanceOf(AmbiguousAcceptanceError);
    expect(err?.details.submissionState).toBe("unknown");
    expect(err?.details.mayStillBeRunning).toBe(true);
    expect(err?.details.safeToResubmit).toBe(false);
    expect(err?.details.nextAction).toBe(
      "Inspect this job or message; do not resend automatically.",
    );
    expect(err?.details.operation).toMatch(/POST/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ensureServerMock).not.toHaveBeenCalled();
  });

  it("REPLAY-04: POST 503 => no second POST", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(mockResponse({ status: 503, body: "unavailable" }));

    const client = makeClient({ autoServe: true });
    await expect(client.post("/session", { title: "x" })).rejects.toBeInstanceOf(
      AmbiguousAcceptanceError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ensureServerMock).not.toHaveBeenCalled();
  });

  it("DEADLINE-05: timeout aborts a hanging fetch (body read included)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      return mockResponse({
        status: 200,
        body: '{"ok":true}',
        text: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
            });
          }),
      });
    });

    const client = makeClient();
    const started = Date.now();
    await expect(
      client.post("/session/1/prompt_async", { parts: [] }, { timeout: 40 }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not send a mutation when the caller aborted before fetch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const client = makeClient();
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.post("/session", { title: "x" }, { signal: controller.signal }),
    ).rejects.not.toBeInstanceOf(AmbiguousAcceptanceError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
