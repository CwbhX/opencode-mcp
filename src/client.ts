import { createOpencodeClient, OpencodeClient as NativeClient } from "@opencode-ai/sdk";
import { ensureServer } from "./server-manager.js";
import {
  encodeDirectoryHeader,
  isUnsupportedLiteralPercentPath,
  validateDirectory,
} from "./request-context.js";
import {
  AmbiguousAcceptanceError,
  OpenCodeError,
  buildBasicAuthHeader,
  defaultRetryClass,
  isConnectionError,
  sanitizeErrorBody,
  transportRequest,
  type RetryClass,
  type TransportHooks,
} from "./http-transport.js";

export { AmbiguousAcceptanceError, OpenCodeError };
export type { RetryClass };

export interface OpenCodeClientOptions {
  baseUrl: string;
  username?: string;
  password?: string;
  autoServe?: boolean;
  /**
   * Base delay for observational-read retries, in milliseconds. Default 500.
   * Set to `0` in unit tests so backoff does not dominate runtime.
   */
  retryDelayMs?: number;
  /** Injected fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Injected sleep used for read backoff and Retry-After waits. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injected monotonic clock in `performance.now()` units. */
  now?: () => number;
}

interface ClientRequestOptions {
  query?: Record<string, string>;
  body?: unknown;
  timeout?: number;
  directory?: string;
  deadlineAt?: number;
  signal?: AbortSignal;
  retryClass?: RetryClass;
}

const MAX_RECONNECT_ATTEMPTS = 3;

export class OpenCodeClient {
  public api: NativeClient;
  private baseUrl: string;
  private autoServe: boolean;
  private reconnectAttempts = 0;
  private username?: string;
  private password?: string;
  private readonly hooks: TransportHooks;

  constructor(options: OpenCodeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.autoServe = options.autoServe ?? false;
    this.username = options.username;
    this.password = options.password;
    this.hooks = {
      fetch: options.fetch,
      now: options.now,
      sleep: options.sleep,
      retryDelayMs: options.retryDelayMs,
    };

    this.api = this.buildSdkClient();
  }

  /**
   * Rebuild the SDK client against the current `baseUrl` + auth state. Used
   * by the constructor and by the read-reconnect path when `ensureServer()`
   * surfaces a different URL than the one we were aiming at.
   */
  private buildSdkClient(): NativeClient {
    const headers: Record<string, string> = {};
    const authHeader = buildBasicAuthHeader(this.username, this.password);
    if (authHeader) {
      headers["Authorization"] = authHeader;
    }
    return createOpencodeClient({ baseUrl: this.baseUrl, headers });
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private buildHeaders(directory?: string): Record<string, string> {
    const headers: Record<string, string> = {};
    const authHeader = buildBasicAuthHeader(this.username, this.password);
    if (authHeader) {
      headers["Authorization"] = authHeader;
    }
    const normalized = validateDirectory(directory);
    if (normalized) {
      if (isUnsupportedLiteralPercentPath(normalized)) {
        throw new Error(
          `Unsupported directory: literal '%' path segments are not safely routable ("${normalized}").`,
        );
      }
      headers["x-opencode-directory"] = encodeDirectoryHeader(normalized);
    }
    return headers;
  }

  private fetchImpl(): typeof globalThis.fetch {
    return this.hooks.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async dispatch<T>(
    method: string,
    path: string,
    opts: ClientRequestOptions | undefined,
    extra?: { maxRetries?: number },
  ): Promise<T> {
    return transportRequest<T>(
      {
        baseUrl: this.baseUrl,
        method,
        path,
        query: opts?.query,
        body: opts?.body,
        headers: this.buildHeaders(opts?.directory),
        timeout: opts?.timeout,
        deadlineAt: opts?.deadlineAt,
        signal: opts?.signal,
        retryClass: opts?.retryClass ?? defaultRetryClass(method),
        maxRetries: extra?.maxRetries,
      },
      this.hooks,
    );
  }

  private shouldReconnectRead(err: unknown, retryClass: RetryClass): boolean {
    if (retryClass !== "read" || !this.autoServe) return false;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return false;
    if (err instanceof AmbiguousAcceptanceError) return false;
    if (err instanceof OpenCodeError && err.isAuth) return false;
    return isConnectionError(err);
  }

  private async reconnectAndRetryRead<T>(
    method: string,
    path: string,
    opts: ClientRequestOptions | undefined,
    lastError: unknown,
  ): Promise<T> {
    this.reconnectAttempts++;
    console.error(
      `Connection failed (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}), attempting server reconnection...`,
    );
    try {
      const ensured = await ensureServer({
        baseUrl: this.baseUrl,
        autoServe: true,
        username: this.username,
        password: this.password,
        signal: opts?.signal,
        deadlineAt: opts?.deadlineAt,
      });
      if (ensured.url) {
        const normalized = ensured.url.replace(/\/$/, "");
        if (normalized !== this.baseUrl) {
          throw new Error(
            `OpenCode reconnection would change the server URL from ${this.baseUrl} to ${normalized}. ` +
              `Existing jobs are not moved. Recover with the session/message/directory tuple if intended.`,
          );
        }
      }
    } catch (reconnectErr) {
      console.error(
        `Server reconnection failed: ${reconnectErr instanceof Error ? reconnectErr.message : String(reconnectErr)}`,
      );
      if (reconnectErr instanceof Error) {
        (reconnectErr as Error & { cause?: unknown }).cause = lastError;
        throw reconnectErr;
      }
      throw lastError;
    }

    const result = await this.dispatch<T>(method, path, opts, { maxRetries: 0 });
    this.reconnectAttempts = 0;
    return result;
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    opts?: ClientRequestOptions,
  ): Promise<T> {
    const retryClass = opts?.retryClass ?? defaultRetryClass(method);
    try {
      const result = await this.dispatch<T>(method, path, { ...opts, retryClass });
      this.reconnectAttempts = 0;
      return result;
    } catch (err) {
      if (this.shouldReconnectRead(err, retryClass)) {
        return this.reconnectAndRetryRead<T>(method, path, opts, err);
      }
      throw err;
    }
  }

  async get<T = unknown>(
    path: string,
    query?: Record<string, string>,
    directory?: string,
    opts?: {
      deadlineAt?: number;
      signal?: AbortSignal;
    },
  ): Promise<T> {
    return this.request<T>("GET", path, {
      query,
      directory,
      deadlineAt: opts?.deadlineAt,
      signal: opts?.signal,
    });
  }

  async post<T = unknown>(
    path: string,
    body?: unknown,
    opts?: {
      timeout?: number;
      directory?: string;
      deadlineAt?: number;
      signal?: AbortSignal;
      retryClass?: RetryClass;
    },
  ): Promise<T> {
    return this.request<T>("POST", path, {
      body,
      timeout: opts?.timeout,
      directory: opts?.directory,
      deadlineAt: opts?.deadlineAt,
      signal: opts?.signal,
      retryClass: opts?.retryClass,
    });
  }

  async patch<T = unknown>(path: string, body?: unknown, directory?: string): Promise<T> {
    return this.request<T>("PATCH", path, { body, directory });
  }

  async put<T = unknown>(path: string, body?: unknown, directory?: string): Promise<T> {
    return this.request<T>("PUT", path, { body, directory });
  }

  async delete<T = unknown>(
    path: string,
    query?: Record<string, string>,
    directory?: string,
  ): Promise<T> {
    return this.request<T>("DELETE", path, { query, directory });
  }

  async *subscribeSSE(
    path: string,
    opts?: { signal?: AbortSignal; directory?: string },
  ): AsyncGenerator<{ event: string; data: string }, void, undefined> {
    const url = new URL(path, `${this.baseUrl}/`).toString();
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
    };
    const authHeader = buildBasicAuthHeader(this.username, this.password);
    if (authHeader) {
      headers["Authorization"] = authHeader;
    }
    const normalized = validateDirectory(opts?.directory);
    if (normalized) {
      if (isUnsupportedLiteralPercentPath(normalized)) {
        throw new Error(
          `Unsupported directory: literal '%' path segments are not safely routable ("${normalized}").`,
        );
      }
      headers["x-opencode-directory"] = encodeDirectoryHeader(normalized);
    }

    const res = await this.fetchImpl()(url, {
      method: "GET",
      headers,
      signal: opts?.signal,
    });

    if (!res.ok) {
      const text = sanitizeErrorBody(await res.text());
      throw new OpenCodeError(
        `SSE ${path} failed (${res.status}): ${text}`,
        res.status,
        "GET",
        path,
        text,
      );
    }

    if (!res.body) throw new Error("No response body for SSE stream");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "";
    let currentData = "";

    const abortHandler = () => {
      try {
        void reader.cancel().catch(() => {});
      } catch {
        /* reader may already be released */
      }
    };
    if (opts?.signal) {
      if (opts.signal.aborted) abortHandler();
      else opts.signal.addEventListener("abort", abortHandler, { once: true });
    }

    try {
      while (true) {
        if (opts?.signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const rawLines = buffer.split("\n");
        buffer = rawLines.pop() ?? "";

        for (const rawLine of rawLines) {
          // SSE per RFC 8895 allows CRLF line endings. Splitting on
          // "\n" leaves a trailing "\r" on each line, which breaks
          // both event-name comparisons (event becomes "message\r")
          // and the blank-line dispatcher (a "blank" CRLF line is
          // "\r", not ""). Strip the trailing CR before processing.
          const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

          if (line.startsWith(":")) {
            continue;
          } else if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            const piece = line.slice(5).trim();
            currentData = currentData ? `${currentData}\n${piece}` : piece;
          } else if (line === "") {
            if (currentData) {
              yield { event: currentEvent || "message", data: currentData };
              currentEvent = "";
              currentData = "";
            }
          }
        }
      }
    } finally {
      if (opts?.signal) {
        try {
          opts.signal.removeEventListener("abort", abortHandler);
        } catch {
          /* ignore */
        }
      }
      reader.releaseLock();
    }
  }
}
