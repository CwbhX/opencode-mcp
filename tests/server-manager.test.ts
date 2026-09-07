import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Server manager tests.
 *
 * Post-SDK-migration (PR #11), `startServer` calls `createOpencodeServer` from
 * `@opencode-ai/sdk` instead of spawning `opencode serve` as a subprocess.
 * These tests cover the surviving contract: `isServerRunning` health probes
 * via `fetch`, and `ensureServer`'s detect-or-start branching.
 *
 * Deep startup / lifecycle integration is deferred to a real integration
 * suite (see roadmap C2) — we can't fully exercise `createOpencodeServer`
 * without booting a real port.
 */

// Mock the SDK before importing the server-manager module so the import chain
// picks up the mock. `vi.hoisted` keeps the mock reference accessible from
// both the (hoisted) `vi.mock` factory and the assertions below.
const { createOpencodeServerMock } = vi.hoisted(() => ({
  createOpencodeServerMock: vi.fn(),
}));
vi.mock("@opencode-ai/sdk", () => ({
  createOpencodeServer: createOpencodeServerMock,
  OpencodeClient: vi.fn(),
}));

import {
  isServerRunning,
  startServer,
  stopServer,
  ensureServer,
  probeHealth,
} from "../src/server-manager.js";

// ─── Helpers ─────────────────────────────────────────────────────────────

let fetchMock: ReturnType<typeof vi.fn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

function mockFetchHealthy(version = "1.14.46") {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ healthy: true, version }),
  } as unknown as Response);
}

function mockFetchDown() {
  fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
}

function mockFetchUnhealthy() {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ healthy: false }),
  } as unknown as Response);
}

function mockFetchNotOk() {
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status: 500,
    text: async () => "Internal Server Error",
  } as unknown as Response);
}

function mockFetchAuthFailed(status: 401 | 403 = 401) {
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => ({ error: "Unauthorized" }),
  } as unknown as Response);
}

function mockFetchHtml() {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null,
    },
    json: async () => {
      throw new SyntaxError("Unexpected token <");
    },
    text: async () => "<html><title>Welcome</title></html>",
  } as unknown as Response);
}

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  createOpencodeServerMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  stopServer();
});

// ─── isServerRunning ─────────────────────────────────────────────────────

describe("isServerRunning", () => {
  it("returns healthy=true with version when server responds", async () => {
    mockFetchHealthy("1.14.46");
    const result = await isServerRunning("http://127.0.0.1:4096");
    expect(result).toEqual({ healthy: true, version: "1.14.46" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4096/global/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("returns healthy=false when server is down", async () => {
    mockFetchDown();
    const result = await isServerRunning("http://127.0.0.1:4096");
    expect(result).toEqual({ healthy: false });
  });

  it("returns healthy=false when response is not ok", async () => {
    mockFetchNotOk();
    const result = await isServerRunning("http://127.0.0.1:4096");
    expect(result).toEqual({ healthy: false });
  });

  it("returns healthy=false when body says not healthy", async () => {
    mockFetchUnhealthy();
    const result = await isServerRunning("http://127.0.0.1:4096");
    expect(result).toEqual({ healthy: false, version: undefined });
  });

  it("strips trailing slash from base URL", async () => {
    mockFetchHealthy();
    await isServerRunning("http://127.0.0.1:4096/");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4096/global/health",
      expect.anything(),
    );
  });

  it("handles version missing from response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ healthy: true }),
    } as unknown as Response);
    const result = await isServerRunning("http://127.0.0.1:4096");
    expect(result).toEqual({ healthy: true, version: undefined });
  });

  it("times out cleanly (returns unhealthy on AbortError)", async () => {
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    );
    const result = await isServerRunning("http://127.0.0.1:4096");
    expect(result).toEqual({ healthy: false });
  });

  it("does not send an Authorization header when no password is given", async () => {
    mockFetchHealthy();
    await isServerRunning("http://127.0.0.1:4096");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("sends Basic auth header when password is provided", async () => {
    mockFetchHealthy();
    await isServerRunning("http://127.0.0.1:4096", "admin", "secret123");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Basic YWRtaW46c2VjcmV0MTIz");
  });

  it("defaults username to 'opencode' when only password is provided", async () => {
    mockFetchHealthy();
    await isServerRunning("http://127.0.0.1:4096", undefined, "secret123");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = (init.headers ?? {}) as Record<string, string>;
    // base64("opencode:secret123") === "b3BlbmNvZGU6c2VjcmV0MTIz"
    expect(headers.Authorization).toBe("Basic b3BlbmNvZGU6c2VjcmV0MTIz");
  });
});

// ─── probeHealth ─────────────────────────────────────────────────────────

describe("probeHealth", () => {
  it("classifies HTTP 200 + { healthy: true } as healthy and records version", async () => {
    mockFetchHealthy("1.18.29");
    const result = await probeHealth("http://127.0.0.1:4096");
    expect(result).toEqual({
      classification: "healthy",
      version: "1.18.29",
      status: 200,
    });
  });

  it("classifies HTTP 200 + { healthy: false } as reachable_but_unhealthy", async () => {
    mockFetchUnhealthy();
    const result = await probeHealth("http://127.0.0.1:4096");
    expect(result.classification).toBe("reachable_but_unhealthy");
    expect(result.status).toBe(200);
  });

  it("classifies HTTP 401 as authentication_failed", async () => {
    mockFetchAuthFailed(401);
    const result = await probeHealth("http://127.0.0.1:4096", "admin", "wrong");
    expect(result).toEqual({
      classification: "authentication_failed",
      status: 401,
    });
  });

  it("classifies HTTP 403 as authentication_failed", async () => {
    mockFetchAuthFailed(403);
    const result = await probeHealth("http://127.0.0.1:4096");
    expect(result.classification).toBe("authentication_failed");
    expect(result.status).toBe(403);
  });

  it("classifies ECONNREFUSED as connection_refused", async () => {
    mockFetchDown();
    const result = await probeHealth("http://127.0.0.1:4096");
    expect(result).toEqual({ classification: "connection_refused" });
  });

  it("classifies generic fetch-failed network errors as incompatible_response, not connection_refused", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const result = await probeHealth("http://127.0.0.1:4096");
    expect(result.classification).not.toBe("connection_refused");
    expect(result.classification).toBe("incompatible_response");
  });

  it("classifies DNS/TLS error codes as not connection_refused", async () => {
    fetchMock.mockRejectedValueOnce(
      Object.assign(new TypeError("fetch failed"), {
        code: "ENOTFOUND",
        cause: { code: "ENOTFOUND" },
      }),
    );
    const dns = await probeHealth("http://127.0.0.1:4096");
    expect(dns.classification).not.toBe("connection_refused");

    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error("certificate"), {
        code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      }),
    );
    const tls = await probeHealth("http://127.0.0.1:4096");
    expect(tls.classification).not.toBe("connection_refused");
  });

  it("classifies AbortError as probe_timed_out", async () => {
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    );
    const result = await probeHealth("http://127.0.0.1:4096");
    expect(result).toEqual({ classification: "probe_timed_out" });
  });

  it("classifies HTTP 200 HTML / non-JSON as incompatible_response", async () => {
    mockFetchHtml();
    const result = await probeHealth("http://127.0.0.1:4096");
    expect(result.classification).toBe("incompatible_response");
    expect(result.status).toBe(200);
  });

  it("classifies HTTP 200 JSON missing healthy as incompatible_response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: "ok" }),
    } as unknown as Response);
    const result = await probeHealth("http://127.0.0.1:4096");
    expect(result.classification).toBe("incompatible_response");
    expect(result.status).toBe(200);
  });

  it("classifies HTTP 500 as reachable_but_unhealthy", async () => {
    // Documented policy: other non-2xx (except 401/403) means we reached a
    // process that answered, so we must not auto-start a competing server.
    mockFetchNotOk();
    const result = await probeHealth("http://127.0.0.1:4096");
    expect(result.classification).toBe("reachable_but_unhealthy");
    expect(result.status).toBe(500);
  });

  it("sends Basic auth and honors timeoutMs", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    mockFetchHealthy("1.18.29");
    await probeHealth("http://127.0.0.1:4096/", "admin", "secret123", {
      timeoutMs: 1500,
    });
    expect(timeoutSpy).toHaveBeenCalledWith(1500);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Basic YWRtaW46c2VjcmV0MTIz");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4096/global/health",
      expect.objectContaining({ method: "GET" }),
    );
  });
});

// ─── startServer ─────────────────────────────────────────────────────────

describe("startServer", () => {
  it("calls createOpencodeServer with parsed hostname and port", async () => {
    createOpencodeServerMock.mockResolvedValueOnce({
      url: "http://127.0.0.1:4096",
      close: vi.fn(),
    });
    // Post-start health check
    mockFetchHealthy("1.14.46");

    const result = await startServer("http://127.0.0.1:4096", 5000);

    expect(createOpencodeServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: "127.0.0.1",
        port: 4096,
        timeout: 5000,
      }),
    );
    expect(result.url).toBe("http://127.0.0.1:4096");
    expect(result.version).toBe("1.14.46");
  });

  it("parses custom hostname and port from baseUrl", async () => {
    createOpencodeServerMock.mockResolvedValueOnce({
      url: "http://192.168.1.100:5000",
      close: vi.fn(),
    });
    mockFetchHealthy("1.14.46");

    await startServer("http://192.168.1.100:5000", 5000);

    expect(createOpencodeServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: "192.168.1.100",
        port: 5000,
      }),
    );
  });

  it("falls back to port 4096 when baseUrl omits port", async () => {
    createOpencodeServerMock.mockResolvedValueOnce({
      url: "http://example.com:4096",
      close: vi.fn(),
    });
    mockFetchHealthy("1.14.46");

    await startServer("http://example.com", 5000);

    expect(createOpencodeServerMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 4096 }),
    );
  });

  it("propagates createOpencodeServer rejection", async () => {
    createOpencodeServerMock.mockRejectedValueOnce(
      new Error("port already in use"),
    );

    await expect(startServer("http://127.0.0.1:4096", 5000)).rejects.toThrow(
      "port already in use",
    );
  });

  it("fails and closes the child when post-start health is not healthy", async () => {
    const close = vi.fn();
    createOpencodeServerMock.mockResolvedValueOnce({
      url: "http://127.0.0.1:4096",
      close,
    });
    mockFetchDown();

    await expect(startServer("http://127.0.0.1:4096", 5000)).rejects.toThrow(
      /post-start health/,
    );
    expect(close).toHaveBeenCalledOnce();
  });
});

// ─── stopServer ──────────────────────────────────────────────────────────

describe("stopServer", () => {
  it("does not throw when no managed server exists", () => {
    expect(() => stopServer()).not.toThrow();
  });

  it("calls close() on the managed server when one exists", async () => {
    const closeMock = vi.fn();
    createOpencodeServerMock.mockResolvedValueOnce({
      url: "http://127.0.0.1:4096",
      close: closeMock,
    });
    mockFetchHealthy();

    await startServer("http://127.0.0.1:4096", 5000);
    stopServer();

    expect(closeMock).toHaveBeenCalledOnce();
  });

  it("is idempotent (subsequent calls are no-ops)", async () => {
    const closeMock = vi.fn();
    createOpencodeServerMock.mockResolvedValueOnce({
      url: "http://127.0.0.1:4096",
      close: closeMock,
    });
    mockFetchHealthy();

    await startServer("http://127.0.0.1:4096", 5000);
    stopServer();
    stopServer();

    expect(closeMock).toHaveBeenCalledOnce();
  });
});

// ─── ensureServer ────────────────────────────────────────────────────────

describe("ensureServer", () => {
  it("returns immediately when server is already running", async () => {
    mockFetchHealthy("1.14.46");

    const result = await ensureServer({ baseUrl: "http://127.0.0.1:4096" });

    expect(result).toEqual({
      running: true,
      version: "1.14.46",
      managedByUs: false,
      url: "http://127.0.0.1:4096",
    });
    expect(createOpencodeServerMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("already running"),
    );
  });

  it("starts the server when not running and autoServe is true (default)", async () => {
    mockFetchDown(); // initial probe fails
    createOpencodeServerMock.mockResolvedValueOnce({
      url: "http://127.0.0.1:4096",
      close: vi.fn(),
    });
    mockFetchHealthy("1.14.46"); // post-start probe

    const result = await ensureServer({ baseUrl: "http://127.0.0.1:4096" });

    expect(result).toEqual({
      running: true,
      version: "1.14.46",
      managedByUs: true,
      url: "http://127.0.0.1:4096",
    });
    expect(createOpencodeServerMock).toHaveBeenCalledOnce();
  });

  it("throws when autoServe is false and server is not running", async () => {
    mockFetchDown();

    await expect(
      ensureServer({
        baseUrl: "http://127.0.0.1:4096",
        autoServe: false,
      }),
    ).rejects.toThrow("OPENCODE_AUTO_SERVE=false");
    expect(createOpencodeServerMock).not.toHaveBeenCalled();
  });

  it("propagates startServer errors", async () => {
    mockFetchDown();
    createOpencodeServerMock.mockRejectedValueOnce(new Error("EADDRINUSE"));

    await expect(
      ensureServer({ baseUrl: "http://127.0.0.1:4096" }),
    ).rejects.toThrow("EADDRINUSE");
  });

  it("forwards Basic auth credentials to the health probe", async () => {
    mockFetchHealthy("1.14.46");

    await ensureServer({
      baseUrl: "http://127.0.0.1:4096",
      username: "admin",
      password: "secret123",
    });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Basic YWRtaW46c2VjcmV0MTIz");
  });

  it("serializes concurrent startups onto one createOpencodeServer call", async () => {
    // Both initial probes report unhealthy → both callers reach the
    // startServer branch. Without the in-flight lock, this would race
    // `createOpencodeServer` twice (EADDRINUSE / leaked handle).
    mockFetchDown();
    mockFetchDown();

    // Single createOpencodeServer resolution shared by both callers.
    let resolveStart: (value: { url: string; close(): void }) => void;
    const startPromise = new Promise<{ url: string; close(): void }>((r) => {
      resolveStart = r;
    });
    createOpencodeServerMock.mockReturnValueOnce(startPromise);

    // Post-start health probe for both callers.
    mockFetchHealthy("1.14.46");
    mockFetchHealthy("1.14.46");

    const [a, b] = await Promise.all([
      (async () => {
        const p = ensureServer({ baseUrl: "http://127.0.0.1:4096" });
        // Resolve after both callers have queued, so both observe the
        // in-flight promise rather than racing into a second start.
        resolveStart({ url: "http://127.0.0.1:4096", close: vi.fn() });
        return p;
      })(),
      ensureServer({ baseUrl: "http://127.0.0.1:4096" }),
    ]);

    expect(createOpencodeServerMock).toHaveBeenCalledOnce();
    expect(a.running).toBe(true);
    expect(b.running).toBe(true);
  });

  it("does NOT coalesce concurrent startups across different baseUrls", async () => {
    // Two concurrent callers targeting different URLs must each invoke
    // their own `createOpencodeServer`. Before the per-baseUrl keying,
    // the second caller would await the first caller's in-flight promise
    // and receive the wrong endpoint.
    //
    // The mock returns whichever URL was passed in, so each caller gets
    // back its own startup result regardless of which one races to call
    // the mock first.
    mockFetchDown();
    mockFetchDown();

    createOpencodeServerMock.mockImplementation(
      async (opts: { hostname: string; port: number }) => ({
        url: `http://${opts.hostname}:${opts.port}`,
        close: vi.fn(),
      }),
    );

    // Post-start health probes for both.
    mockFetchHealthy("1.14.46");
    mockFetchHealthy("1.14.46");

    const [a, b] = await Promise.all([
      ensureServer({ baseUrl: "http://127.0.0.1:4096" }),
      ensureServer({ baseUrl: "http://127.0.0.1:5000" }),
    ]);

    expect(createOpencodeServerMock).toHaveBeenCalledTimes(2);
    expect(a.url).toBe("http://127.0.0.1:4096");
    expect(b.url).toBe("http://127.0.0.1:5000");
  });

  it("START-01: healthy server with password still attaches", async () => {
    mockFetchHealthy("1.18.29");

    const result = await ensureServer({
      baseUrl: "http://127.0.0.1:4096",
      username: "admin",
      password: "secret123",
    });

    expect(result).toEqual({
      running: true,
      version: "1.18.29",
      managedByUs: false,
      url: "http://127.0.0.1:4096",
    });
    expect(createOpencodeServerMock).not.toHaveBeenCalled();
    const logged = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).not.toContain("secret123");
    expect(logged).not.toContain("Authorization");
  });

  it("FUP-046/START-03: 401 probe does not call createOpencodeServer", async () => {
    mockFetchAuthFailed(401);

    await expect(
      ensureServer({
        baseUrl: "http://127.0.0.1:4096",
        username: "admin",
        password: "wrong-password",
      }),
    ).rejects.toThrow(/authentication|401|password|credential/i);
    expect(createOpencodeServerMock).not.toHaveBeenCalled();
  });

  it("START-03: HTML 200 does not spawn", async () => {
    mockFetchHtml();

    await expect(
      ensureServer({ baseUrl: "http://127.0.0.1:4096" }),
    ).rejects.toThrow(/incompatible|html|not (an )?opencode/i);
    expect(createOpencodeServerMock).not.toHaveBeenCalled();
  });

  it("START-03: timeout (AbortError) does not spawn", async () => {
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    );

    await expect(
      ensureServer({ baseUrl: "http://127.0.0.1:4096" }),
    ).rejects.toThrow(/timed? ?out|timeout|slow/i);
    expect(createOpencodeServerMock).not.toHaveBeenCalled();
  });

  it("after failed start, stopServer is safe", async () => {
    mockFetchDown();
    const closeMock = vi.fn();
    createOpencodeServerMock.mockResolvedValueOnce({
      url: "http://127.0.0.1:4096",
      close: closeMock,
    });
    mockFetchAuthFailed(401);

    await expect(
      ensureServer({
        baseUrl: "http://127.0.0.1:4096",
        password: "secret123",
      }),
    ).rejects.toThrow(/authentication|401/i);
    expect(closeMock).toHaveBeenCalledOnce();
    expect(() => stopServer()).not.toThrow();
    expect(closeMock).toHaveBeenCalledOnce();
  });

  it("remote hostname + connection_refused + autoServe true => throw, no spawn", async () => {
    mockFetchDown();

    await expect(
      ensureServer({
        baseUrl: "http://192.0.2.10:4096",
        autoServe: true,
      }),
    ).rejects.toThrow(/remote|loopback/i);
    expect(createOpencodeServerMock).not.toHaveBeenCalled();
  });

  it("START-04: includes executable-missing error from createOpencodeServer", async () => {
    mockFetchDown();
    createOpencodeServerMock.mockRejectedValueOnce(
      new Error("spawn opencode ENOENT: command not found"),
    );

    await expect(
      ensureServer({ baseUrl: "http://127.0.0.1:4096" }),
    ).rejects.toThrow(/not found|ENOENT/i);
  });

  it("FUP-052: rejects unsupported auto-start URL forms before spawn", async () => {
    mockFetchDown();
    await expect(
      ensureServer({ baseUrl: "https://127.0.0.1:4096", autoServe: true }),
    ).rejects.toThrow(/http:\/\//);
    expect(createOpencodeServerMock).not.toHaveBeenCalled();

    mockFetchDown();
    await expect(
      ensureServer({ baseUrl: "http://127.0.0.1:4096/v1", autoServe: true }),
    ).rejects.toThrow(/base path/);
    expect(createOpencodeServerMock).not.toHaveBeenCalled();

    mockFetchDown();
    await expect(
      ensureServer({
        baseUrl: "http://user:pass@127.0.0.1:4096",
        autoServe: true,
      }),
    ).rejects.toThrow(/credentials/);
    expect(createOpencodeServerMock).not.toHaveBeenCalled();

    mockFetchDown();
    await expect(
      ensureServer({ baseUrl: "http://127.0.0.1", autoServe: true }),
    ).rejects.toThrow(/explicit port/);
    expect(createOpencodeServerMock).not.toHaveBeenCalled();
  });

  it("FUP-052: loopback IPv6 with explicit port is an allowed auto-start target", async () => {
    mockFetchDown();
    createOpencodeServerMock.mockResolvedValueOnce({
      url: "http://[::1]:4096",
      close: vi.fn(),
    });
    mockFetchHealthy("1.18.29");

    const result = await ensureServer({
      baseUrl: "http://[::1]:4096",
      autoServe: true,
    });
    expect(result.running).toBe(true);
    expect(createOpencodeServerMock).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "::1", port: 4096 }),
    );
  });
});
