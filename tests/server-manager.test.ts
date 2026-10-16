import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

/**
 * Server manager tests (OpenCode v2).
 *
 * The v2 bridge probes `GET /api/info` (healthy = version 2.x + urls) and
 * auto-starts by spawning `opencode serve` with
 * `OPENCODE_SERVER_PASSWORD` set. `node:child_process` spawn is mocked
 * with a fake child that prints the v2 "server listening" line.
 */

const { spawnMock, children } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  children: [] as Array<EventEmitter & { kill: ReturnType<typeof vi.fn> }>,
}));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import {
  isServerRunning,
  startServer,
  stopServer,
  ensureServer,
  probeHealth,
  generateServerPassword,
} from "../src/server-manager.js";

// ─── Helpers ─────────────────────────────────────────────────────────────

let fetchMock: ReturnType<typeof vi.fn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

function infoResponse(version = "2.0.28") {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({ version, urls: ["http://127.0.0.1:4096"] }),
  } as unknown as Response;
}

function mockFetchHealthy(version = "2.0.28") {
  fetchMock.mockResolvedValueOnce(infoResponse(version));
}

function refusedError(): Error {
  return Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4096"), {
    code: "ECONNREFUSED",
  });
}

function mockFetchDown() {
  fetchMock.mockRejectedValueOnce(refusedError());
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
    json: async () => ({ _tag: "UnauthorizedError" }),
  } as unknown as Response);
}

function mockFetchHtml() {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
    json: async () => {
      throw new SyntaxError("Unexpected token <");
    },
    text: async () => "<html><title>OpenCode</title></html>",
  } as unknown as Response);
}

function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  children.push(child);
  queueMicrotask(() => {
    child.stdout.emit(
      "data",
      Buffer.from("server listening on http://127.0.0.1:4096\n"),
    );
  });
  return child;
}

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  void consoleErrorSpy;
  spawnMock.mockReset();
  children.length = 0;
  spawnMock.mockImplementation(() => makeFakeChild());
  delete process.env.OPENCODE_BINARY;
});

afterEach(() => {
  vi.restoreAllMocks();
  stopServer();
});

// ─── isServerRunning ─────────────────────────────────────────────────────

describe("isServerRunning", () => {
  it("returns healthy=true with version when the v2 server responds", async () => {
    mockFetchHealthy("2.0.28");
    const result = await isServerRunning("http://127.0.0.1:4096");
    expect(result).toEqual({ healthy: true, version: "2.0.28" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4096/api/info",
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

  it("treats a v1-shaped health body as not healthy (incompatible)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ healthy: true, version: "1.19.2" }),
    } as unknown as Response);
    const result = await isServerRunning("http://127.0.0.1:4096");
    expect(result.healthy).toBe(false);
  });

  it("strips trailing slash from base URL", async () => {
    mockFetchHealthy();
    await isServerRunning("http://127.0.0.1:4096/");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4096/api/info",
      expect.anything(),
    );
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
    expect(headers.Authorization).toBe("Basic b3BlbmNvZGU6c2VjcmV0MTIz");
  });
});

// ─── probeHealth ─────────────────────────────────────────────────────────

describe("probeHealth", () => {
  it("classifies HTTP 200 + v2 info as healthy and records version", async () => {
    mockFetchHealthy("2.0.28");
    const result = await probeHealth("http://127.0.0.1:4096");
    expect(result).toEqual({
      classification: "healthy",
      version: "2.0.28",
      status: 200,
    });
  });

  it("classifies a v1 version string as incompatible_response", async () => {
    fetchMock.mockResolvedValueOnce(infoResponse("1.19.2"));
    const result = await probeHealth("http://127.0.0.1:4096");
    expect(result.classification).toBe("incompatible_response");
    expect(result.version).toBe("1.19.2");
  });

  it("classifies HTTP 401 as authentication_failed", async () => {
    mockFetchAuthFailed(401);
    const result = await probeHealth("http://127.0.0.1:4096", "opencode", "wrong");
    expect(result).toEqual({ classification: "authentication_failed", status: 401 });
  });

  it("classifies HTTP 403 as authentication_failed", async () => {
    mockFetchAuthFailed(403);
    const result = await probeHealth("http://127.0.0.1:4096");
    expect(result.classification).toBe("authentication_failed");
  });

  it("classifies ECONNREFUSED as connection_refused", async () => {
    mockFetchDown();
    const result = await probeHealth("http://127.0.0.1:4096");
    expect(result).toEqual({ classification: "connection_refused" });
  });

  it("classifies generic fetch-failed as incompatible, not connection_refused", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const result = await probeHealth("http://127.0.0.1:4096");
    expect(result.classification).toBe("incompatible_response");
  });

  it("classifies AbortError as probe_timed_out", async () => {
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    );
    const result = await probeHealth("http://127.0.0.1:4096");
    expect(result).toEqual({ classification: "probe_timed_out" });
  });

  it("classifies HTTP 200 HTML (SPA fallback) as incompatible_response", async () => {
    mockFetchHtml();
    const result = await probeHealth("http://127.0.0.1:4096");
    expect(result.classification).toBe("incompatible_response");
    expect(result.status).toBe(200);
  });

  it("classifies HTTP 500 as reachable_but_unhealthy", async () => {
    mockFetchNotOk();
    const result = await probeHealth("http://127.0.0.1:4096");
    expect(result.classification).toBe("reachable_but_unhealthy");
    expect(result.status).toBe(500);
  });
});

// ─── ensureServer ────────────────────────────────────────────────────────

describe("ensureServer", () => {
  it("returns the running server without spawning when healthy", async () => {
    mockFetchHealthy();
    const status = await ensureServer({
      baseUrl: "http://127.0.0.1:4096",
      password: "pw",
    });
    expect(status.running).toBe(true);
    expect(status.managedByUs).toBe(false);
    expect(status.version).toBe("2.0.28");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("never spawns on 401 (authentication failure is not 'down')", async () => {
    mockFetchAuthFailed(401);
    await expect(
      ensureServer({ baseUrl: "http://127.0.0.1:4096", password: "wrong" }),
    ).rejects.toThrow(/authentication failed|401/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses to auto-start when OPENCODE_AUTO_SERVE=false semantics apply", async () => {
    mockFetchDown();
    await expect(
      ensureServer({ baseUrl: "http://127.0.0.1:4096", autoServe: false }),
    ).rejects.toThrow(/not running|AUTO_SERVE/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("spawns `opencode serve` with the configured password on connection-refused", async () => {
    mockFetchDown(); // initial probe: nothing listening
    mockFetchHealthy(); // post-start probe
    const status = await ensureServer({
      baseUrl: "http://127.0.0.1:4096",
      username: "opencode",
      password: "configured-pw",
    });
    expect(status.running).toBe(true);
    expect(status.managedByUs).toBe(true);
    expect(status.password).toBe("configured-pw");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [binary, args, options] = spawnMock.mock.calls[0];
    expect(binary).toBe("opencode");
    expect(args).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "4096"]);
    expect(options.env.OPENCODE_SERVER_PASSWORD).toBe("configured-pw");
  });

  it("generates and returns a password when none is configured", async () => {
    mockFetchDown();
    mockFetchHealthy();
    const status = await ensureServer({ baseUrl: "http://127.0.0.1:4096" });
    expect(status.password).toBeTypeOf("string");
    expect((status.password as string).length).toBeGreaterThanOrEqual(16);
    const [, , options] = spawnMock.mock.calls[0];
    expect(options.env.OPENCODE_SERVER_PASSWORD).toBe(status.password);
  });

  it("honors OPENCODE_BINARY for the spawned executable", async () => {
    process.env.OPENCODE_BINARY = "/opt/opencode2";
    mockFetchDown();
    mockFetchHealthy();
    await ensureServer({ baseUrl: "http://127.0.0.1:4096", password: "pw" });
    expect(spawnMock.mock.calls[0][0]).toBe("/opt/opencode2");
  });

  it("surfaces executable-missing errors with install guidance", async () => {
    spawnMock.mockImplementationOnce(() => {
      const child = makeFakeChild();
      queueMicrotask(() => {
        child.emit(
          "error",
          Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" }),
        );
      });
      return child;
    });
    mockFetchDown();
    await expect(
      ensureServer({ baseUrl: "http://127.0.0.1:4096" }),
    ).rejects.toThrow(/ENOENT|not found/i);
  });

  it("fails (does not spawn) for a non-loopback auto-start target", async () => {
    mockFetchDown();
    await expect(
      ensureServer({ baseUrl: "http://203.0.113.10:4096" }),
    ).rejects.toThrow(/loopback/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

// ─── startServer / stopServer ────────────────────────────────────────────

describe("startServer / stopServer", () => {
  it("starts a managed server and stopServer kills the child", async () => {
    mockFetchHealthy();
    const result = await startServer("http://127.0.0.1:4096", 5000);
    expect(result.url).toBe("http://127.0.0.1:4096");
    expect(result.version).toBe("2.0.28");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    stopServer();
    expect(children[0]?.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("stopServer is safe when nothing is managed", () => {
    expect(() => stopServer()).not.toThrow();
  });
});

describe("generateServerPassword", () => {
  it("produces distinct URL-safe passwords", () => {
    const a = generateServerPassword();
    const b = generateServerPassword();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(24);
  });
});
