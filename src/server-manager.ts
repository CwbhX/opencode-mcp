import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { HealthClassification } from "./bridge-types.js";

export interface ServerManagerOptions {
  baseUrl: string;
  autoServe?: boolean;
  /**
   * HTTP Basic auth credentials forwarded to the `/global/health` probe.
   * Required when the OpenCode server is configured with
   * `OPENCODE_SERVER_PASSWORD` — without these, the probe would receive 401
   * and `ensureServer` would falsely treat a healthy server as down.
   */
  username?: string;
  password?: string;
  signal?: AbortSignal;
  deadlineAt?: number;
}

export interface ServerStatus {
  running: boolean;
  version?: string;
  managedByUs: boolean;
  url?: string;
  /**
   * Password the client must use for the (managed) server. Set when a
   * managed v2 server was started with a bridge-generated password.
   */
  password?: string;
}

export interface ClassifiedProbe {
  classification: HealthClassification;
  version?: string;
  status?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 3000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Build an `Authorization: Basic ...` header value, or undefined when no
 * password is configured. Mirrors the helper in `src/client.ts` to keep the
 * two HTTP entry points consistent.
 */
function buildBasicAuthHeader(
  username?: string,
  password?: string,
): string | undefined {
  if (!password) return undefined;
  const user = username ?? "opencode";
  return "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
}

/**
 * Log-safe URL: strip userinfo so diagnostics never contain credentials.
 */
function sanitizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
      return url.href.replace(/\/$/, "");
    }
    return raw;
  } catch {
    return "[invalid-url]";
  }
}

function combinedAbortSignal(signals: AbortSignal[]): AbortSignal {
  if (signals.length === 1) return signals[0]!;
  const anyFn = (AbortSignal as { any?: (input: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") {
    return anyFn(signals);
  }
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function parseBaseUrl(baseUrl: string): { hostname: string; port: number; url: URL } {
  const url = new URL(baseUrl);
  const hostname = url.hostname.replace(/^\[([^\]]+)\]$/, "$1");
  return {
    hostname,
    port: url.port ? parseInt(url.port, 10) : 4096,
    url,
  };
}

function assertAutoStartTarget(baseUrl: string): { hostname: string; port: number } {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid OPENCODE_BASE_URL for auto-start: "${baseUrl}"`);
  }
  if (parsed.protocol !== "http:") {
    throw new Error(
      `Auto-start is only supported for http:// loopback URLs. Unsupported protocol "${parsed.protocol}".`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error("Auto-start URLs must not include credentials.");
  }
  if (parsed.pathname && parsed.pathname !== "/") {
    throw new Error(
      `Auto-start URLs must not include a base path ("${parsed.pathname}").`,
    );
  }
  if (!parsed.port) {
    throw new Error(
      "Auto-start requires an explicit port (for example http://127.0.0.1:4096).",
    );
  }
  const hostname = parsed.hostname;
  if (!isLoopbackHostname(hostname)) {
    throw new Error(
      `OpenCode auto-start is only allowed for loopback hosts (127.0.0.1, localhost, ::1). ` +
        `The configured host "${hostname}" is not supported.`,
    );
  }
  return { hostname, port: parseInt(parsed.port, 10) };
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[([^\]]+)\]$/, "$1").toLowerCase();
  return LOOPBACK_HOSTS.has(normalized);
}

function collectErrorText(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const e = current as {
      name?: unknown;
      message?: unknown;
      code?: unknown;
      cause?: unknown;
    };
    if (typeof e.name === "string") parts.push(e.name);
    if (typeof e.message === "string") parts.push(e.message);
    if (typeof e.code === "string" || typeof e.code === "number") {
      parts.push(String(e.code));
    }
    current = e.cause;
  }
  if (typeof err === "string") parts.push(err);
  return parts.join(" ").toLowerCase();
}

function collectErrorCodes(err: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const e = current as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof e.code === "string" || typeof e.code === "number") {
      codes.push(String(e.code).toUpperCase());
    }
    if (Array.isArray(e.errors)) {
      for (const nested of e.errors) {
        codes.push(...collectErrorCodes(nested));
      }
    }
    current = e.cause;
  }
  return codes;
}

function isTimeoutError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const name = (err as { name?: unknown }).name;
    if (name === "AbortError" || name === "TimeoutError") return true;
  }
  const codes = collectErrorCodes(err);
  return codes.includes("ETIMEDOUT") || collectErrorText(err).includes("etimedout");
}

const NON_REFUSAL_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA",
  "ETIMEDOUT",
  "EPERM",
  "EACCES",
]);

function isConnectionRefusedError(err: unknown): boolean {
  const codes = collectErrorCodes(err);
  if (codes.some((code) => NON_REFUSAL_CODES.has(code))) return false;
  if (codes.includes("ECONNREFUSED")) return true;
  const text = collectErrorText(err);
  if (/\beconnrefused\b/.test(text)) return true;
  return false;
}

function readContentType(response: Response): string {
  const headers = response.headers;
  if (headers && typeof headers.get === "function") {
    return (headers.get("content-type") ?? "").toLowerCase();
  }
  return "";
}

/**
 * Classify a completed HTTP response.
 *
 * Policy for other non-2xx (e.g. HTTP 500): `reachable_but_unhealthy`.
 * The endpoint answered, so auto-start would race a live process.
 * 401/403 are `authentication_failed` instead — credentials are wrong,
 * not missing.
 */
async function classifyHttpResponse(
  response: Response,
): Promise<ClassifiedProbe> {
  const status = response.status;
  if (status === 401 || status === 403) {
    return { classification: "authentication_failed", status };
  }
  if (!response.ok) {
    return { classification: "reachable_but_unhealthy", status };
  }

  if (readContentType(response).includes("text/html")) {
    return { classification: "incompatible_response", status };
  }

  try {
    const body = (await response.json()) as unknown;
    if (body && typeof body === "object" && "version" in body) {
      const rec = body as { version?: unknown; urls?: unknown };
      const version = typeof rec.version === "string" ? rec.version : undefined;
      // v2 /api/info answers { version: "2.x.y", urls: [...] }. Anything
      // else (including a v1 server) is not a server this bridge can use.
      if (version !== undefined && version.startsWith("2.") && Array.isArray(rec.urls)) {
        return { classification: "healthy", version, status };
      }
      return { classification: "incompatible_response", version, status };
    }
    return { classification: "incompatible_response", status };
  } catch {
    return { classification: "incompatible_response", status };
  }
}

function classifyFetchError(err: unknown): ClassifiedProbe {
  if (isTimeoutError(err)) {
    return { classification: "probe_timed_out" };
  }
  if (isConnectionRefusedError(err)) {
    return { classification: "connection_refused" };
  }
  // Unexpected fetch failures must not look like "nothing listening".
  return { classification: "incompatible_response" };
}

function describeUnhealthyProbe(safeUrl: string, probe: ClassifiedProbe): string {
  switch (probe.classification) {
    case "authentication_failed":
      return (
        `OpenCode server at ${safeUrl} rejected the health probe with HTTP ${probe.status ?? 401} (authentication failed). ` +
        `Check OPENCODE_SERVER_USERNAME and OPENCODE_SERVER_PASSWORD. The bridge will not start another server.`
      );
    case "probe_timed_out":
      return (
        `Health probe to OpenCode at ${safeUrl} timed out. An existing server may be slow or stuck. ` +
        `The bridge will not start another server.`
      );
    case "incompatible_response":
      return (
        `OpenCode health probe at ${safeUrl} returned an incompatible response. ` +
        `This bridge requires an OpenCode v2 server (GET /api/info reporting version 2.x); ` +
        `a v1 server or a non-OpenCode process on that port will not work. The bridge will not start another server.`
      );
    case "reachable_but_unhealthy":
      return (
        `OpenCode server at ${safeUrl} is reachable but reports unhealthy` +
        (probe.status !== undefined ? ` (HTTP ${probe.status})` : "") +
        `. The bridge will not start another server.`
      );
    default:
      return `OpenCode server at ${safeUrl} is not healthy (${probe.classification}). The bridge will not start another server.`;
  }
}

function wrapStartError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/ENOENT|not found/i.test(message)) {
    return new Error(
      `${message}. The opencode (v2) executable was not found. Install OpenCode v2 (@opencode/cli) or set OPENCODE_BINARY to its absolute path.`,
    );
  }
  return err instanceof Error ? err : new Error(message);
}

export function generateServerPassword(): string {
  return randomBytes(24).toString("base64url");
}

function closeCreatedServer(created: { close(): void }): void {
  try {
    created.close();
  } catch {
    // Cleanup must not hide the original start failure.
  }
  if (managedServer === created) {
    managedServer = null;
  }
}

let managedServer: { url: string; close(): void } | null = null;
let shutdownRegistered = false;

/**
 * In-flight startup promises, keyed by normalized `baseUrl`. Serializes
 * concurrent `ensureServer` callers so only one of them invokes
 * `createOpencodeServer` per target URL — others awaiting the same key
 * receive the same result. Prevents EADDRINUSE / leaked server handles
 * when two requests hit the MCP simultaneously and both observe the
 * initial health probe as connection-refused.
 *
 * Keying by `baseUrl` matters because two callers targeting different
 * URLs must NOT share each other's result (the second caller would
 * receive the first server's URL and bind to the wrong endpoint).
 */
const startServerInFlight = new Map<
  string,
  Promise<{ url: string; version?: string; password: string }>
>();

function registerShutdownHandlers(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;

  const cleanup = () => {
    if (managedServer) {
      managedServer.close();
      managedServer = null;
    }
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
}

export async function probeHealth(
  baseUrl: string,
  username?: string,
  password?: string,
  opts?: { timeoutMs?: number; signal?: AbortSignal; deadlineAt?: number },
): Promise<ClassifiedProbe> {
  try {
    if (opts?.signal?.aborted) {
      return { classification: "probe_timed_out" };
    }
    const headers: Record<string, string> = {};
    const authHeader = buildBasicAuthHeader(username, password);
    if (authHeader) {
      headers["Authorization"] = authHeader;
    }
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    const remaining =
      opts?.deadlineAt !== undefined
        ? Math.max(1, opts.deadlineAt - performance.now())
        : timeoutMs;
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/info`, {
      method: "GET",
      headers,
      signal: combinedAbortSignal(
        [
          AbortSignal.timeout(Math.min(timeoutMs, remaining)),
          ...(opts?.signal ? [opts.signal] : []),
        ],
      ),
    });
    return await classifyHttpResponse(response);
  } catch (err) {
    return classifyFetchError(err);
  }
}

export async function isServerRunning(
  baseUrl: string,
  username?: string,
  password?: string,
): Promise<{ healthy: boolean; version?: string }> {
  const probe = await probeHealth(baseUrl, username, password);
  const healthy = probe.classification === "healthy";
  // Preserve the version key for a JSON health document (healthy true/false)
  // so existing isServerRunning assertions keep matching.
  if (
    healthy ||
    (probe.classification === "reachable_but_unhealthy" && probe.status === 200)
  ) {
    return { healthy, version: probe.version };
  }
  return { healthy: false };
}

/**
 * Spawn `opencode serve` (v2) as a child process. v2 always requires
 * Basic auth, so the child is started with `OPENCODE_SERVER_PASSWORD`
 * set to the configured (or generated) password; the caller hands the
 * same password to the client. The binary comes from `OPENCODE_BINARY`
 * or PATH (`opencode`).
 */
async function spawnV2Server(
  hostname: string,
  port: number,
  password: string,
  timeoutMs: number,
): Promise<{ url: string; close(): void }> {
  const binary = process.env.OPENCODE_BINARY || "opencode";
  const url = `http://${hostname}:${port}`;
  const child: ChildProcess = spawn(
    binary,
    ["serve", "--hostname", hostname, "--port", String(port)],
    {
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  const capture = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-4096);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  const close = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already exited.
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        fn();
      };
      child.once("error", (err) => finish(() => reject(err)));
      child.once("exit", (code) =>
        finish(() =>
          reject(
            new Error(
              `opencode serve exited early (code ${code ?? "?"}). ${output.trim().slice(-500)}`,
            ),
          ),
        ),
      );
      const timer = setInterval(() => {
        if (output.includes("server listening")) {
          finish(resolve);
        } else if (Date.now() > deadline) {
          finish(() =>
            reject(new Error(`opencode serve did not start within ${timeoutMs}ms.`)),
          );
        }
      }, 100);
    });
  } catch (err) {
    close();
    throw err;
  }

  return { url, close };
}

async function startManagedServer(
  baseUrl: string,
  timeoutMs: number,
  credentials?: { username?: string; password?: string },
): Promise<{ url: string; version?: string; password: string }> {
  const { hostname, port } = parseBaseUrl(baseUrl);
  const password = credentials?.password ?? generateServerPassword();

  console.error(`Starting OpenCode v2 server on ${hostname}:${port}`);

  // Capture into a local so concurrent `startServer` calls (against
  // different baseUrls) don't clobber each other's return values via the
  // module-level `managedServer` singleton. The singleton is still
  // updated (for shutdown handler reach) but the URL we return is the
  // one this specific call produced.
  let created: { url: string; close(): void } | undefined;
  try {
    created = await spawnV2Server(hostname, port, password, timeoutMs);
    managedServer = created;

    registerShutdownHandlers();

    const status = await probeHealth(
      created.url,
      credentials?.username,
      password,
    );
    if (status.classification !== "healthy") {
      throw new Error(
        `OpenCode server started at ${sanitizeUrl(created.url)} but post-start health was ${status.classification}` +
          (status.status !== undefined ? ` (HTTP ${status.status})` : "") +
          `. The child was closed and is not reported ready.`,
      );
    }
    return { url: created.url, version: status.version, password };
  } catch (err) {
    if (created) {
      closeCreatedServer(created);
    }
    throw wrapStartError(err);
  }
}

export async function startServer(
  baseUrl: string,
  timeoutMs: number = 30000,
): Promise<{ url: string; version?: string }> {
  return startManagedServer(baseUrl, timeoutMs);
}

export function stopServer(): void {
  if (managedServer) {
    managedServer.close();
    managedServer = null;
  }
}

export async function ensureServer(
  opts: ServerManagerOptions,
): Promise<ServerStatus> {
  const baseUrl = opts.baseUrl;
  const autoServe = opts.autoServe !== false;
  const safeUrl = sanitizeUrl(baseUrl);

  if (opts.signal?.aborted) {
    throw new Error("OpenCode startup cancelled before health probe.");
  }
  if (opts.deadlineAt !== undefined && performance.now() >= opts.deadlineAt) {
    throw new Error("OpenCode startup deadline elapsed before health probe.");
  }

  const probe = await probeHealth(baseUrl, opts.username, opts.password, {
    signal: opts.signal,
    deadlineAt: opts.deadlineAt,
  });
  if (probe.classification === "healthy") {
    console.error(
      `OpenCode server already running at ${safeUrl} (v${probe.version ?? "unknown"})`,
    );
    return {
      running: true,
      version: probe.version,
      managedByUs: false,
      url: baseUrl,
    };
  }

  if (probe.classification !== "connection_refused") {
    throw new Error(describeUnhealthyProbe(safeUrl, probe));
  }

  if (!autoServe) {
    throw new Error(
      `OpenCode server is not running at ${baseUrl} and OPENCODE_AUTO_SERVE=false.\n` +
        `Start it manually: opencode serve`,
    );
  }

  if (opts.signal?.aborted) {
    throw new Error("OpenCode startup cancelled after connection-refused probe.");
  }
  if (opts.deadlineAt !== undefined && performance.now() >= opts.deadlineAt) {
    throw new Error("OpenCode startup deadline elapsed after connection-refused probe.");
  }

  const { hostname } = assertAutoStartTarget(baseUrl);
  void hostname;

  console.error("OpenCode server not detected, attempting auto-start...");
  // Coalesce concurrent startups per-baseUrl — see the
  // `startServerInFlight` declaration for rationale.
  const startupKey = baseUrl.replace(/\/$/, "");
  let inFlight = startServerInFlight.get(startupKey);
  if (!inFlight) {
    inFlight = startManagedServer(startupKey, 30000, {
      username: opts.username,
      password: opts.password,
    }).finally(() => {
      startServerInFlight.delete(startupKey);
    });
    startServerInFlight.set(startupKey, inFlight);
  }
  const result = await inFlight;
  console.error(`OpenCode server started successfully on ${sanitizeUrl(result.url)}`);

  return {
    running: true,
    version: result.version,
    managedByUs: true,
    url: result.url,
    password: result.password,
  };
}
