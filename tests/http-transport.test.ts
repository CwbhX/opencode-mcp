import { describe, it, expect, vi, afterEach } from "vitest";
import {
  AmbiguousAcceptanceError,
  OpenCodeError,
  buildRequestUrl,
  defaultRetryClass,
  sanitizeErrorBody,
  transportRequest,
  MAX_ERROR_BODY_CHARS,
} from "../src/http-transport.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockResponse(opts: {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}): Response {
  const status = opts.status ?? 200;
  const body = opts.body ?? "";
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(opts.headers),
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

describe("http-transport helpers", () => {
  it("classifies GET as read and mutating verbs as mutation", () => {
    expect(defaultRetryClass("GET")).toBe("read");
    expect(defaultRetryClass("post")).toBe("mutation");
    expect(defaultRetryClass("PATCH")).toBe("mutation");
    expect(defaultRetryClass("PUT")).toBe("mutation");
    expect(defaultRetryClass("DELETE")).toBe("mutation");
  });

  it("builds URLs without encoding the path and appends query params", () => {
    expect(buildRequestUrl("http://localhost:4096", "/project/current")).toBe(
      "http://localhost:4096/project/current",
    );
    expect(buildRequestUrl("http://localhost:4096/", "/find", { q: "a b" })).toBe(
      "http://localhost:4096/find?q=a+b",
    );
  });

  it("truncates error bodies and leaves short bodies intact", () => {
    expect(sanitizeErrorBody("short")).toBe("short");
    const long = "x".repeat(MAX_ERROR_BODY_CHARS + 20);
    const sanitized = sanitizeErrorBody(long);
    expect(sanitized.endsWith("…")).toBe(true);
    expect(sanitized.length).toBe(MAX_ERROR_BODY_CHARS + 1);
    expect(sanitized).not.toContain("Authorization");
  });
});

describe("transportRequest", () => {
  it("returns undefined for 204 without calling json()", async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        status: 204,
        headers: new Headers(),
        text: async () => "",
        json: async () => {
          throw new Error("json() must not run on 204");
        },
      } as unknown as Response;
    });

    const result = await transportRequest(
      { baseUrl: "http://localhost:4096", method: "POST", path: "/session", body: { a: 1 } },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    expect(result).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not replay a mutation after a 503", async () => {
    const fetchMock = vi.fn(async () => mockResponse({ status: 503, body: "down" }));
    await expect(
      transportRequest(
        { baseUrl: "http://localhost:4096", method: "POST", path: "/session", body: { a: 1 } },
        { fetch: fetchMock as unknown as typeof fetch, retryDelayMs: 0 },
      ),
    ).rejects.toBeInstanceOf(AmbiguousAcceptanceError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a GET 503 then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 503, body: "down" }))
      .mockResolvedValueOnce(mockResponse({ status: 200, body: '{"ok":true}' }));

    await expect(
      transportRequest(
        { baseUrl: "http://localhost:4096", method: "GET", path: "/health" },
        { fetch: fetchMock as unknown as typeof fetch, retryDelayMs: 0 },
      ),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry past a deadline when Retry-After is too large", async () => {
    const fetchMock = vi.fn(async () =>
      mockResponse({ status: 503, body: "wait", headers: { "Retry-After": "30" } }),
    );
    const sleeps: number[] = [];
    await expect(
      transportRequest(
        {
          baseUrl: "http://localhost:4096",
          method: "GET",
          path: "/health",
          deadlineAt: 25,
        },
        {
          fetch: fetchMock as unknown as typeof fetch,
          now: () => 0,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        },
      ),
    ).rejects.toBeInstanceOf(OpenCodeError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });
});
