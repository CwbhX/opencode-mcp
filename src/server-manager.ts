import { createOpencodeServer } from "@opencode-ai/sdk";
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
}

export interface ServerStatus {
  running: boolean;
  version?: string;
  managedByUs: boolean;
  url?: string;
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

function parseBaseUrl(baseUrl: string): { hostname: string; port: number } {
  const url = new URL(baseUrl);
  return {
    hostname: url.hostname,
    port: url.port ? parseInt(url.port, 10) : 4096,
  };
}

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
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

function isTimeoutError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const name = (err as { name?: unknown }).name;
    if (name === "AbortError" || name === "TimeoutError") return true;
  }
  return collectErrorText(err).includes("etimedout");
}

function isConnectionRefusedError(err: unknown): boolean {
  const text = collectErrorText(err);
  return (
    text.includes("econnrefused") ||
    text.includes("fetch failed") ||
    text.includes("failed to fetch") ||
    text.includes("network error") ||
    text.includes("networkerror")
  );
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
    if (body && typeof body === "object" && "healthy" in body) {
      const rec = body as { healthy?: unknown; version?: unknown };
      const version = typeof rec.version === "string" ? rec.version : undefined;
      if (rec.healthy === true) {
        return { classification: "healthy", version, status };
      }
      return { classification: "reachable_but_unhealthy", version, status };
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
        `OpenCode health probe at ${safeUrl} returned an incompatible response (HTML, non-JSON, or missing healthy field). ` +
        `The process on that port does not look like OpenCode. The bridge will not start another server.`
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
      `${message}. The opencode executable was not found on PATH. Install OpenCode or configure an absolute executable path.`,
    );
  }
  return err instanceof Error ? err : new Error(message);
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
  Promise<{ url: string; version?: string }>
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
  opts?: { timeoutMs?: number },
): Promise<ClassifiedProbe> {
  try {
    const headers: Record<string, string> = {};
    const authHeader = buildBasicAuthHeader(username, password);
    if (authHeader) {
      headers["Authorization"] = authHeader;
    }
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/global/health`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(opts?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS),
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

async function startManagedServer(
  baseUrl: string,
  timeoutMs: number,
  credentials?: { username?: string; password?: string },
): Promise<{ url: string; version?: string }> {
  const { hostname, port } = parseBaseUrl(baseUrl);

  console.error(`Starting OpenCode SDK server on ${hostname}:${port}`);

  // Capture into a local so concurrent `startServer` calls (against
  // different baseUrls) don't clobber each other's return values via the
  // module-level `managedServer` singleton. The singleton is still
  // updated (for shutdown handler reach) but the URL we return is the
  // one this specific call produced.
  let created: { url: string; close(): void } | undefined;
  try {
    created = await createOpencodeServer({
      hostname,
      port,
      timeout: timeoutMs,
    });
    managedServer = created;

    registerShutdownHandlers();

    const status = await probeHealth(
      created.url,
      credentials?.username,
      credentials?.password,
    );
    if (status.classification === "authentication_failed") {
      throw new Error(
        `OpenCode server started at ${sanitizeUrl(created.url)} but the health probe failed authentication (HTTP ${status.status ?? 401}). ` +
          `Check OPENCODE_SERVER_USERNAME and OPENCODE_SERVER_PASSWORD.`,
      );
    }
    return { url: created.url, version: status.version };
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

  const probe = await probeHealth(baseUrl, opts.username, opts.password);
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

  const { hostname } = parseBaseUrl(baseUrl);
  if (!isLoopbackHostname(hostname)) {
    throw new Error(
      `OpenCode server is not running at ${safeUrl} and auto-start is only allowed for loopback hosts (127.0.0.1, localhost, ::1). ` +
        `The configured host "${hostname}" is remote; start the server on that host instead of impersonating it with a local process.`,
    );
  }

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
  };
}
