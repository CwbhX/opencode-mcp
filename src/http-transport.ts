import { AmbiguousAcceptanceError } from "./bridge-types.js";
import type { RetryClass } from "./bridge-types.js";

export { AmbiguousAcceptanceError };
export type { RetryClass };

export const MAX_READ_RETRIES = 2;
export const DEFAULT_RETRY_DELAY_MS = 500;
export const MAX_BACKOFF_MS = 4000;
export const MAX_ERROR_BODY_CHARS = 2048;
export const AMBIGUOUS_NEXT_ACTION =
  "Inspect this job or message; do not resend automatically.";

export class OpenCodeError extends Error {
  retryAfterMs?: number;

  constructor(
    message: string,
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(message);
    this.name = "OpenCodeError";
  }

  get isTransient(): boolean {
    return (
      this.status === 429 ||
      this.status === 502 ||
      this.status === 503 ||
      this.status === 504
    );
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export class DeadlineError extends Error {
  constructor(method: string, path: string) {
    super(`${method} ${path} timed out`);
    this.name = "DeadlineError";
  }
}

export interface TransportHooks {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  retryDelayMs?: number;
}

export interface TransportRequest {
  baseUrl: string;
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
  timeout?: number;
  deadlineAt?: number;
  signal?: AbortSignal;
  retryClass?: RetryClass;
  /** Override retry budget. Reads default to MAX_READ_RETRIES; mutations 0. */
  maxRetries?: number;
}

export function buildBasicAuthHeader(
  username?: string,
  password?: string,
): string | undefined {
  if (!password) return undefined;
  const user = username ?? "opencode";
  return "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
}

export function defaultRetryClass(method: string): RetryClass {
  return method.toUpperCase() === "GET" ? "read" : "mutation";
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export function isConnectionError(err: unknown): boolean {
  const msg =
    err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("ehostunreach") ||
    msg.includes("fetch failed") ||
    msg.includes("network error") ||
    msg.includes("socket hang up")
  );
}

export function sanitizeErrorBody(body: string): string {
  if (body.length <= MAX_ERROR_BODY_CHARS) return body;
  return `${body.slice(0, MAX_ERROR_BODY_CHARS)}…`;
}

export function buildRequestUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string>,
): string {
  const root = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(path, root);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

export async function defaultSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

function ambiguousAcceptance(method: string, path: string): AmbiguousAcceptanceError {
  return new AmbiguousAcceptanceError(`${method} ${path} acceptance is unknown`, {
    operation: `${method} ${path}`,
    submissionState: "unknown",
    mayStillBeRunning: true,
    safeToResubmit: false,
    nextAction: AMBIGUOUS_NEXT_ACTION,
  });
}

function resolveDeadlineAt(
  now: () => number,
  timeout?: number,
  deadlineAt?: number,
): number | undefined {
  const fromTimeout = timeout !== undefined ? now() + timeout : undefined;
  if (fromTimeout === undefined) return deadlineAt;
  if (deadlineAt === undefined) return fromTimeout;
  return Math.min(deadlineAt, fromTimeout);
}

function remainingMs(deadlineAt: number | undefined, now: () => number): number | undefined {
  if (deadlineAt === undefined) return undefined;
  return deadlineAt - now();
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds * 1000;
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(abortError());
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function shouldRetryRead(err: unknown): boolean {
  if (err instanceof DeadlineError || isAbortError(err)) return false;
  if (err instanceof AmbiguousAcceptanceError) return false;
  if (err instanceof OpenCodeError) {
    if (err.isAuth || err.status === 400 || err.status === 404 || err.status === 422) {
      return false;
    }
    if (err.isTransient) return true;
    return err.status === 0 && isConnectionError(err);
  }
  return isConnectionError(err);
}

interface PreparedRequest extends TransportRequest {
  method: string;
  retryClass: RetryClass;
  deadlineAt?: number;
}

async function dispatchOnce<T>(
  req: PreparedRequest,
  hooks: TransportHooks,
  now: () => number,
): Promise<T> {
  if (req.signal?.aborted) throw abortError();

  const left = remainingMs(req.deadlineAt, now);
  if (left !== undefined && left <= 0) {
    throw new DeadlineError(req.method, req.path);
  }

  const controller = new AbortController();
  const onUserAbort = () => controller.abort();
  req.signal?.addEventListener("abort", onUserAbort);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = remainingMs(req.deadlineAt, now);
  if (budget !== undefined) {
    timer = setTimeout(() => controller.abort(), Math.max(0, budget));
  }

  let requestSent = false;
  try {
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    let bodyInit: string | undefined;
    if (req.body !== undefined) {
      if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
        headers["Content-Type"] = "application/json";
      }
      bodyInit = JSON.stringify(req.body);
    }

    const fetchFn = hooks.fetch ?? globalThis.fetch.bind(globalThis);
    requestSent = true;
    const res = await raceAbort(
      Promise.resolve(
        fetchFn(buildRequestUrl(req.baseUrl, req.path, req.query), {
          method: req.method,
          headers,
          body: bodyInit,
          signal: controller.signal,
        }),
      ),
      controller.signal,
    );

    if (res.status === 204) {
      return undefined as T;
    }

    const text = await raceAbort(Promise.resolve(res.text()), controller.signal);

    if (!res.ok) {
      const body = sanitizeErrorBody(text);
      const err = new OpenCodeError(
        `${req.method} ${req.path} failed (${res.status}): ${body}`,
        res.status,
        req.method,
        req.path,
        body,
      );
      err.retryAfterMs = parseRetryAfterMs(res.headers?.get("Retry-After") ?? null);
      if (req.retryClass === "mutation" && res.status >= 500) {
        throw ambiguousAcceptance(req.method, req.path);
      }
      throw err;
    }

    if (!text.trim()) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new OpenCodeError(
        `${req.method} ${req.path} failed: response was not valid JSON`,
        res.status,
        req.method,
        req.path,
        sanitizeErrorBody(text),
      );
    }
  } catch (err) {
    if (err instanceof AmbiguousAcceptanceError || err instanceof OpenCodeError) {
      throw err;
    }

    if (!requestSent) {
      if (req.signal?.aborted) throw isAbortError(err) ? err : abortError();
      if (req.deadlineAt !== undefined && now() >= req.deadlineAt) {
        throw new DeadlineError(req.method, req.path);
      }
      throw err;
    }

    if (req.retryClass === "mutation") {
      throw ambiguousAcceptance(req.method, req.path);
    }

    if (req.signal?.aborted) throw isAbortError(err) ? err : abortError();
    if (req.deadlineAt !== undefined && now() >= req.deadlineAt) {
      throw new DeadlineError(req.method, req.path);
    }
    if (isAbortError(err) && controller.signal.aborted) {
      throw new DeadlineError(req.method, req.path);
    }

    const message = err instanceof Error ? err.message : String(err);
    throw new OpenCodeError(
      `${req.method} ${req.path} failed: ${message}`,
      0,
      req.method,
      req.path,
      "",
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    req.signal?.removeEventListener("abort", onUserAbort);
  }
}

export async function transportRequest<T = unknown>(
  req: TransportRequest,
  hooks: TransportHooks = {},
): Promise<T> {
  const method = req.method.toUpperCase();
  const retryClass = req.retryClass ?? defaultRetryClass(method);
  const maxRetries = req.maxRetries ?? (retryClass === "read" ? MAX_READ_RETRIES : 0);
  const now = hooks.now ?? (() => performance.now());
  const sleep = hooks.sleep ?? defaultSleep;
  const retryDelayMs = hooks.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const deadlineAt = resolveDeadlineAt(now, req.timeout, req.deadlineAt);

  const prepared: PreparedRequest = {
    ...req,
    method,
    retryClass,
    deadlineAt,
  };

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await dispatchOnce<T>(prepared, hooks, now);
    } catch (err) {
      lastError = err;
      if (retryClass !== "read" || attempt >= maxRetries || !shouldRetryRead(err)) {
        throw err;
      }

      let delay = retryDelayMs * Math.pow(2, attempt);
      if (err instanceof OpenCodeError && err.retryAfterMs !== undefined) {
        delay = err.retryAfterMs;
      }
      delay = Math.min(delay, MAX_BACKOFF_MS);

      const remaining = remainingMs(deadlineAt, now);
      if (remaining !== undefined && delay > remaining) {
        throw err;
      }
      await sleep(delay, req.signal);
    }
  }

  throw lastError;
}
