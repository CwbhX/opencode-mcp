import { ensureServer } from "./server-manager.js";
import {
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
import {
  buildFormAnswer,
  synthesizeAuthMethods,
  synthesizeProviderCatalog,
  translateDiffs,
  translateFormToQuestion,
  translateMessage,
  translateMessages,
  translatePermissionRequest,
  translateProject,
  translateSession,
  translateSessionList,
  unwrapV2,
} from "./v2-adapt.js";

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

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const MAX_RECONNECT_ATTEMPTS = 3;

/** Features with no OpenCode v2 server equivalent fail with this error. */
export class UnsupportedOnV2Error extends Error {
  constructor(operation: string, detail?: string) {
    super(
      `${operation} is not available on OpenCode v2` +
        (detail ? `: ${detail}` : ". The v2 server API has no equivalent endpoint."),
    );
    this.name = "UnsupportedOnV2Error";
  }
}

/**
 * HTTP client for the OpenCode **v2** server API.
 *
 * The bridge's tools address the client with stable internal (v1-shaped)
 * paths such as `/session/{id}/message`; this class translates each call
 * to the v2 wire (`/api/...`, `location[directory]` scoping, `{data}`
 * envelopes, per-session model/agent selection) and translates responses
 * back. All v2 knowledge lives here and in `v2-adapt.ts`.
 */
export class OpenCodeClient {
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
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  /** Adopt credentials (used after auto-start generates a server password). */
  setCredentials(username: string | undefined, password: string | undefined): void {
    this.username = username;
    this.password = password;
  }

  getCredentials(): { username?: string; password?: string } {
    return { username: this.username, password: this.password };
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    const authHeader = buildBasicAuthHeader(this.username, this.password);
    if (authHeader) headers["Authorization"] = authHeader;
    return headers;
  }

  /** Validate `directory` and apply the bridge's unsupported-path policy. */
  private checkedDirectory(directory?: string): string | undefined {
    const normalized = validateDirectory(directory);
    if (normalized && isUnsupportedLiteralPercentPath(normalized)) {
      throw new Error(
        `Unsupported directory: literal '%' path segments are not safely routable ("${normalized}").`,
      );
    }
    return normalized;
  }

  /**
   * Query params for a v2 call. Location-scoped endpoints take the project
   * directory as `location[directory]` instead of v1's header.
   */
  private v2Query(
    directory: string | undefined,
    extra?: Record<string, string>,
    withLocation = true,
  ): Record<string, string> | undefined {
    const query: Record<string, string> = { ...(extra ?? {}) };
    if (withLocation && directory) query["location[directory]"] = directory;
    return Object.keys(query).length > 0 ? query : undefined;
  }

  private fetchImpl(): typeof globalThis.fetch {
    return this.hooks.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** One raw v2 wire request (already-translated path), envelope-unwrapped. */
  private async v2<T = unknown>(
    method: string,
    path: string,
    opts?: ClientRequestOptions & { maxRetries?: number },
  ): Promise<T> {
    const raw = await transportRequest<unknown>(
      {
        baseUrl: this.baseUrl,
        method,
        path,
        query: opts?.query,
        body: opts?.body,
        headers: this.authHeaders(),
        timeout: opts?.timeout,
        deadlineAt: opts?.deadlineAt,
        signal: opts?.signal,
        retryClass: opts?.retryClass ?? defaultRetryClass(method),
        maxRetries: opts?.maxRetries,
      },
      this.hooks,
    );
    return unwrapV2(raw) as T;
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
      if (ensured.password) this.password = ensured.password;
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

    const result = await this.translate<T>(method, path, { ...opts, maxRetries: 0 });
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
      const result = await this.translate<T>(method, path, { ...opts, retryClass });
      this.reconnectAttempts = 0;
      return result;
    } catch (err) {
      if (this.shouldReconnectRead(err, retryClass)) {
        return this.reconnectAndRetryRead<T>(method, path, opts, err);
      }
      throw err;
    }
  }

  // ── v2 composites ────────────────────────────────────────────────────

  /** Apply model/agent selection to a session (v2 keeps both per-session). */
  private async applySessionSelection(
    sessionId: string,
    body: Rec,
    opts?: ClientRequestOptions,
  ): Promise<void> {
    const model = isRecord(body.model) ? body.model : undefined;
    const modelID = model ? (asString(model.modelID) ?? asString(model.id)) : undefined;
    const providerID = model ? asString(model.providerID) : undefined;
    const variant = asString(body.variant);
    if (modelID && providerID) {
      await this.v2("POST", `/api/session/${sessionId}/model`, {
        ...opts,
        body: {
          model: { id: modelID, providerID, ...(variant ? { variant } : {}) },
        },
        retryClass: "mutation",
      });
    } else if (variant) {
      // Variant without an explicit model pair: re-apply the session's
      // current model with the requested variant.
      const session = await this.v2<Rec>("GET", `/api/session/${sessionId}`, {
        ...opts,
        retryClass: "read",
      });
      const current = isRecord(session?.model) ? session.model : undefined;
      const curId = current ? asString(current.id) : undefined;
      const curProvider = current ? asString(current.providerID) : undefined;
      if (curId && curProvider) {
        await this.v2("POST", `/api/session/${sessionId}/model`, {
          ...opts,
          body: { model: { id: curId, providerID: curProvider, variant } },
          retryClass: "mutation",
        });
      }
    }
    const agent = asString(body.agent);
    if (agent) {
      await this.v2("POST", `/api/session/${sessionId}/agent`, {
        ...opts,
        body: { agent },
        retryClass: "mutation",
      });
    }
  }

  private promptTextOf(body: Rec): string {
    const parts = Array.isArray(body.parts) ? body.parts : [];
    return parts
      .filter(isRecord)
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("");
  }

  /** Fetch and translate the message list (ascending) for composites. */
  private async fetchMessages(
    sessionId: string,
    opts?: ClientRequestOptions,
    limit?: string,
  ): Promise<Rec[]> {
    const query: Record<string, string> = { order: "asc" };
    if (limit) query.limit = limit;
    const raw = await this.v2("GET", `/api/session/${sessionId}/message`, {
      ...opts,
      query,
      // Composite sub-reads must not inherit an outer mutation's retry
      // class (that would turn a dropped GET into ambiguous acceptance).
      retryClass: "read",
    });
    return translateMessages(raw);
  }

  private async waitForIdle(
    sessionId: string,
    opts?: ClientRequestOptions,
  ): Promise<void> {
    await this.v2("POST", `/api/experimental/session/${sessionId}/wait`, {
      ...opts,
      body: {},
      retryClass: "read",
      maxRetries: 0,
    });
  }

  /**
   * v1 sync prompt (`POST /session/{id}/message`): v2 prompts are async, so
   * submit, wait for idle, and return the correlated terminal assistant.
   */
  private async syncPrompt<T>(
    sessionId: string,
    body: Rec,
    opts?: ClientRequestOptions,
  ): Promise<T> {
    await this.applySessionSelection(sessionId, body, opts);
    const system = asString(body.system);
    if (system) {
      await this.v2("POST", `/api/session/${sessionId}/synthetic`, {
        ...opts,
        body: { text: system, resume: false },
        retryClass: "mutation",
      });
    }
    const noReply = body.noReply === true;
    const submitted = await this.v2<Rec>("POST", `/api/session/${sessionId}/prompt`, {
      ...opts,
      body: {
        ...(asString(body.messageID) ? { id: body.messageID } : {}),
        text: this.promptTextOf(body),
        ...(noReply ? { resume: false } : {}),
      },
      retryClass: "mutation",
    });
    const userId = asString(submitted?.id) ?? asString(body.messageID);
    if (noReply) {
      return {
        info: { id: userId ?? "?", role: "user" },
        parts: [{ type: "text", text: this.promptTextOf(body) }],
      } as T;
    }
    await this.waitForIdle(sessionId, opts);
    const messages = await this.fetchMessages(sessionId, opts);
    const correlated = messages.filter((m) => {
      const info = isRecord(m.info) ? m.info : {};
      return info.role === "assistant" && (!userId || info.parentID === userId);
    });
    const latest = correlated[correlated.length - 1];
    if (latest) return latest as T;
    return {
      info: {
        id: "?",
        role: "assistant",
        error: {
          name: "EmptyResponse",
          message: "The session went idle without an assistant reply to this prompt.",
        },
      },
      parts: [],
    } as T;
  }

  /** v1 `prompt_async`: submit only; acceptance means the inbox took it. */
  private async asyncPrompt(
    sessionId: string,
    body: Rec,
    opts?: ClientRequestOptions,
  ): Promise<void> {
    await this.applySessionSelection(sessionId, body, opts);
    const system = asString(body.system);
    if (system) {
      await this.v2("POST", `/api/session/${sessionId}/synthetic`, {
        ...opts,
        body: { text: system, resume: false },
        retryClass: "mutation",
      });
    }
    await this.v2("POST", `/api/session/${sessionId}/prompt`, {
      ...opts,
      body: {
        ...(asString(body.messageID) ? { id: body.messageID } : {}),
        text: this.promptTextOf(body),
        ...(body.noReply === true ? { resume: false } : {}),
      },
      retryClass: "mutation",
    });
  }

  private async providerCatalog<T>(directory?: string, opts?: ClientRequestOptions): Promise<T> {
    const query = this.v2Query(directory);
    const [models, providers, integrations, defaultModel] = await Promise.all([
      this.v2("GET", "/api/model", { ...opts, query }),
      this.v2("GET", "/api/provider", { ...opts, query }).catch(() => []),
      this.v2("GET", "/api/integration", { ...opts, query }).catch(() => []),
      this.v2("GET", "/api/model/default", { ...opts, query }).catch(() => undefined),
    ]);
    return synthesizeProviderCatalog({ models, providers, integrations, defaultModel }) as T;
  }

  private async currentProject<T>(directory?: string, opts?: ClientRequestOptions): Promise<T> {
    const location = await this.v2<Rec>("GET", "/api/location", {
      ...opts,
      query: this.v2Query(directory),
    });
    const project = isRecord(location?.project) ? location.project : {};
    let merged: Rec = { ...project };
    try {
      const projects = await this.v2<unknown[]>("GET", "/api/project", opts);
      const found = (Array.isArray(projects) ? projects : []).find(
        (p) => isRecord(p) && p.id === project.id,
      );
      if (isRecord(found)) merged = { ...found, ...project };
    } catch {
      // Project list enrichment is best-effort.
    }
    return translateProject(merged) as T;
  }

  private async formById(
    formId: string,
    directory?: string,
    opts?: ClientRequestOptions,
  ): Promise<Rec> {
    const forms = await this.v2<unknown[]>("GET", "/api/form", {
      ...opts,
      query: this.v2Query(directory),
    });
    const found = (Array.isArray(forms) ? forms : []).find(
      (f) => isRecord(f) && f.id === formId,
    );
    if (!isRecord(found)) {
      throw new OpenCodeError(
        `Pending question (form) ${formId} was not found.`,
        404,
        "GET",
        "/api/form",
        "",
      );
    }
    return found;
  }

  // ── Internal (v1-shaped) -> v2 wire translation ─────────────────────

  private async translate<T = unknown>(
    method: string,
    path: string,
    opts?: ClientRequestOptions & { maxRetries?: number },
  ): Promise<T> {
    const m = method.toUpperCase();
    const directory = this.checkedDirectory(opts?.directory);
    const body: Rec = isRecord(opts?.body) ? opts.body : {};
    const query = opts?.query;
    // Composite translations fan out into several v2 calls. The outer
    // request's body/query must never leak into those subcalls (a GET
    // subcall inheriting a POST body is a hard fetch error); each subcall
    // below passes its own explicit body/query.
    opts = {
      timeout: opts?.timeout,
      deadlineAt: opts?.deadlineAt,
      signal: opts?.signal,
      retryClass: opts?.retryClass,
      maxRetries: opts?.maxRetries,
      directory: opts?.directory,
    };
    const seg = path.split("/").filter(Boolean);

    const sessionScoped = (
      inner: string,
      v2method: string,
      suffix: string,
      v2opts?: ClientRequestOptions,
    ) =>
      this.v2<T>(v2method, `/api/session/${inner}${suffix}`, {
        ...opts,
        ...v2opts,
      });

    // ── Global / discovery ──
    if (m === "GET" && path === "/global/health") {
      const info = await this.v2<Rec>("GET", "/api/info", opts);
      return { healthy: true, version: asString(info?.version) } as T;
    }
    if (m === "GET" && path === "/project") {
      const raw = await this.v2("GET", "/api/project", opts);
      return (Array.isArray(raw) ? raw : []).map(translateProject) as T;
    }
    if (m === "GET" && path === "/project/current") {
      return this.currentProject<T>(directory, opts);
    }
    if (m === "GET" && path === "/path") {
      const location = await this.v2<Rec>("GET", "/api/location", {
        ...opts,
        query: this.v2Query(directory),
      });
      const project = isRecord(location?.project) ? location.project : {};
      return {
        directory: location?.directory,
        worktree: project.canonical ?? project.directory ?? location?.directory,
        projectID: project.id,
      } as T;
    }
    if (m === "GET" && path === "/vcs") {
      const raw = await this.v2<Rec>("GET", "/api/vcs", {
        ...opts,
        query: this.v2Query(directory),
      });
      const branch = isRecord(raw?.branch) ? raw.branch : {};
      return {
        ...raw,
        type: asString(raw?.provider) ?? "git",
        branch: asString(branch.current),
        defaultBranch: asString(branch.default),
      } as T;
    }
    if (m === "GET" && path === "/config") {
      const raw = await this.v2("GET", "/api/config", {
        ...opts,
        query: this.v2Query(directory),
      });
      const entries = Array.isArray(raw) ? raw.filter(isRecord) : [];
      const documents = entries.filter((e) => e.type === "document");
      if (documents.length === 1 && isRecord(documents[0]!.info)) {
        return documents[0]!.info as T;
      }
      return { documents: entries } as T;
    }
    if (m === "PATCH" && path === "/config") {
      const keys = Object.keys(body);
      if (keys.length !== 1 || keys[0] !== "shell" || typeof body.shell !== "string") {
        throw new UnsupportedOnV2Error(
          "PATCH /config",
          "the v2 config patch endpoint only accepts { shell: string }. Edit opencode.json directly for other settings.",
        );
      }
      return this.v2<T>("PATCH", "/api/experimental/config", {
        ...opts,
        body: { shell: body.shell },
      });
    }
    if (m === "GET" && path === "/config/providers") {
      const catalog = await this.providerCatalog<Rec>(directory, opts);
      return { providers: catalog.all, default: catalog.default } as T;
    }
    if (m === "GET" && path === "/agent") {
      return this.v2<T>("GET", "/api/agent", { ...opts, query: this.v2Query(directory) });
    }
    if (m === "GET" && path === "/command") {
      return this.v2<T>("GET", "/api/command", { ...opts, query: this.v2Query(directory) });
    }
    if (m === "GET" && path === "/mcp") {
      const raw = await this.v2("GET", "/api/mcp", {
        ...opts,
        query: this.v2Query(directory),
      });
      const out: Rec = {};
      for (const entry of Array.isArray(raw) ? raw : []) {
        if (!isRecord(entry) || !asString(entry.name)) continue;
        const status = isRecord(entry.status) ? entry.status : {};
        out[entry.name as string] = {
          ...entry,
          status: asString(status.status) ?? asString(status.state) ?? "unknown",
        };
      }
      return out as T;
    }
    if (m === "POST" && path === "/mcp") {
      const name = asString(body.name);
      if (!name) throw new Error("MCP add requires a server name.");
      return this.v2<T>("PUT", `/api/experimental/mcp/${encodeURIComponent(name)}`, {
        ...opts,
        query: this.v2Query(directory),
        body: { config: body.config },
      });
    }
    if (m === "POST" && path === "/instance/dispose") {
      return this.v2<T>("POST", "/api/location/reload", { ...opts, body: {} });
    }
    if (path === "/lsp" || path === "/formatter") {
      throw new UnsupportedOnV2Error(`GET ${path}`);
    }
    if (path === "/experimental/tool" || path === "/experimental/tool/ids") {
      throw new UnsupportedOnV2Error(`GET ${path}`);
    }
    if (m === "POST" && path === "/log") {
      throw new UnsupportedOnV2Error("POST /log");
    }
    if (path.startsWith("/tui/")) {
      throw new UnsupportedOnV2Error(
        `${m} ${path}`,
        "v2 has no remote TUI-control endpoints; the TUI is driven through its own client.",
      );
    }

    // ── Providers / auth ──
    if (m === "GET" && path === "/provider") {
      return this.providerCatalog<T>(directory, opts);
    }
    if (m === "GET" && path === "/provider/auth") {
      const integrations = await this.v2("GET", "/api/integration", {
        ...opts,
        query: this.v2Query(directory),
      });
      return synthesizeAuthMethods(integrations) as T;
    }
    const oauthStart = path.match(/^\/provider\/([^/]+)\/oauth\/authorize$/);
    if (m === "POST" && oauthStart) {
      const providerId = decodeURIComponent(oauthStart[1]!);
      const integration = await this.v2<Rec>(
        "GET",
        `/api/integration/${encodeURIComponent(providerId)}`,
        opts,
      );
      const methods = Array.isArray(integration?.methods) ? integration.methods.filter(isRecord) : [];
      const oauth = methods.find((x) => x.type === "oauth");
      if (!oauth || !asString(oauth.id)) {
        throw new Error(`Provider ${providerId} has no OAuth method in OpenCode v2.`);
      }
      return this.v2<T>(
        "POST",
        `/api/integration/${encodeURIComponent(providerId)}/connect/oauth`,
        { ...opts, body: { methodID: oauth.id } },
      );
    }
    const oauthDone = path.match(/^\/provider\/([^/]+)\/oauth\/callback$/);
    if (m === "POST" && oauthDone) {
      const providerId = decodeURIComponent(oauthDone[1]!);
      const attemptID = asString(body.attemptID) ?? asString(body.attemptId);
      if (!attemptID) {
        throw new Error(
          "OpenCode v2 OAuth completion requires callbackData.attemptID (returned by opencode_provider_oauth_authorize) plus callbackData.code.",
        );
      }
      return this.v2<T>(
        "POST",
        `/api/integration/${encodeURIComponent(providerId)}/connect/oauth/${encodeURIComponent(attemptID)}/complete`,
        { ...opts, body: { code: asString(body.code) ?? null } },
      );
    }
    const authSet = path.match(/^\/auth\/([^/]+)$/);
    if (m === "PUT" && authSet) {
      const providerId = decodeURIComponent(authSet[1]!);
      const key = asString(body.key);
      if (!key) throw new Error("Auth set requires a key.");
      return this.v2<T>(
        "POST",
        `/api/integration/${encodeURIComponent(providerId)}/connect/key`,
        { ...opts, body: { key } },
      );
    }

    // ── Files / find ──
    if (m === "GET" && path === "/find") {
      throw new UnsupportedOnV2Error(
        "GET /find (content search)",
        "v2 exposes file-name search only; use opencode_find_file or a session shell grep.",
      );
    }
    if (m === "GET" && path === "/find/file") {
      const extra: Record<string, string> = { query: query?.query ?? "" };
      if (query?.type) extra.type = query.type;
      if (query?.limit) extra.limit = query.limit;
      const raw = await this.v2("GET", "/api/fs/find", {
        ...opts,
        query: this.v2Query(directory, extra),
      });
      return (Array.isArray(raw) ? raw : [])
        .filter(isRecord)
        .map((e) => asString(e.path) ?? "")
        .filter(Boolean) as T;
    }
    if (m === "GET" && path === "/find/symbol") {
      throw new UnsupportedOnV2Error("GET /find/symbol");
    }
    if (m === "GET" && path === "/file") {
      const raw = await this.v2("GET", "/api/fs/list", {
        ...opts,
        query: this.v2Query(directory, { path: query?.path || "." }),
      });
      return (Array.isArray(raw) ? raw : []).filter(isRecord).map((e) => ({
        name: asString(e.path),
        path: asString(e.path),
        type: asString(e.type),
      })) as T;
    }
    if (m === "GET" && path === "/file/content") {
      const filePath = query?.path ?? "";
      const encoded = filePath.split("/").map(encodeURIComponent).join("/");
      const raw = await this.v2("GET", `/api/fs/read/${encoded}`, {
        ...opts,
        query: this.v2Query(directory),
      });
      return { content: typeof raw === "string" ? raw : "" } as T;
    }
    if (m === "GET" && path === "/file/status") {
      const raw = await this.v2("GET", "/api/vcs/status", {
        ...opts,
        query: this.v2Query(directory),
      });
      return (Array.isArray(raw) ? raw : []).filter(isRecord).map((e) => ({
        ...e,
        path: asString(e.file) ?? asString(e.path),
      })) as T;
    }

    // ── Permission / question collections ──
    if (m === "GET" && path === "/permission") {
      const raw = await this.v2("GET", "/api/permission/request", {
        ...opts,
        query: this.v2Query(directory),
      });
      return (Array.isArray(raw) ? raw : []).map(translatePermissionRequest) as T;
    }
    const permReply = path.match(/^\/permission\/([^/]+)\/reply$/);
    if (m === "POST" && permReply) {
      const requestId = decodeURIComponent(permReply[1]!);
      const pending = await this.v2<unknown[]>("GET", "/api/permission/request", {
        ...opts,
        query: this.v2Query(directory),
        retryClass: "read",
      });
      const found = (Array.isArray(pending) ? pending : []).find(
        (p) => isRecord(p) && p.id === requestId,
      );
      const sessionID = isRecord(found) ? asString(found.sessionID) : undefined;
      if (!sessionID) {
        throw new OpenCodeError(
          `Permission request ${requestId} was not found among pending requests.`,
          404,
          "GET",
          "/api/permission/request",
          "",
        );
      }
      return this.v2<T>(
        "POST",
        `/api/session/${sessionID}/permission/${encodeURIComponent(requestId)}/reply`,
        { ...opts, body: { decision: asString(body.reply) ?? body.reply } },
      );
    }
    const legacyPerm = path.match(/^\/session\/([^/]+)\/permissions\/([^/]+)$/);
    if (m === "POST" && legacyPerm) {
      return this.v2<T>(
        "POST",
        `/api/session/${legacyPerm[1]}/permission/${legacyPerm[2]}/reply`,
        { ...opts, body: { decision: asString(body.response) ?? body.response } },
      );
    }
    if (m === "GET" && path === "/question") {
      const raw = await this.v2("GET", "/api/form", {
        ...opts,
        query: this.v2Query(directory),
      });
      return (Array.isArray(raw) ? raw : []).map(translateFormToQuestion) as T;
    }
    const questionReply = path.match(/^\/question\/([^/]+)\/reply$/);
    if (m === "POST" && questionReply) {
      const formId = decodeURIComponent(questionReply[1]!);
      const form = await this.formById(formId, directory, {
        ...opts,
        retryClass: "read",
      });
      const answers = Array.isArray(body.answers)
        ? (body.answers as unknown[]).map((a) =>
            Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [],
          )
        : [];
      return this.v2<T>(
        "POST",
        `/api/session/${asString(form.sessionID)}/form/${encodeURIComponent(formId)}/reply`,
        { ...opts, body: { answer: buildFormAnswer(form, answers) } },
      );
    }
    const questionReject = path.match(/^\/question\/([^/]+)\/reject$/);
    if (m === "POST" && questionReject) {
      const formId = decodeURIComponent(questionReject[1]!);
      const form = await this.formById(formId, directory, {
        ...opts,
        retryClass: "read",
      });
      return this.v2<T>(
        "DELETE",
        `/api/session/${asString(form.sessionID)}/form/${encodeURIComponent(formId)}`,
        opts,
      );
    }

    // ── Sessions ──
    if (m === "GET" && path === "/session") {
      const extra: Record<string, string> = { limit: "200", order: "desc" };
      if (directory) extra.directory = directory;
      const raw = await this.v2("GET", "/api/session", { ...opts, query: extra });
      return translateSessionList(raw) as T;
    }
    if (m === "POST" && path === "/session") {
      const createBody: Rec = {};
      if (asString(body.title)) createBody.title = body.title;
      if (asString(body.parentID)) createBody.parentID = body.parentID;
      if (asString(body.agent)) createBody.agent = body.agent;
      const model = isRecord(body.model) ? body.model : undefined;
      if (model && asString(model.modelID) && asString(model.providerID)) {
        createBody.model = { id: model.modelID, providerID: model.providerID };
      }
      if (directory) createBody.location = { directory };
      const raw = await this.v2("POST", "/api/session", { ...opts, body: createBody });
      return translateSession(raw) as T;
    }
    if (m === "GET" && path === "/session/status") {
      const raw = await this.v2<Rec>("GET", "/api/session/active", opts);
      const out: Rec = {};
      for (const id of Object.keys(raw ?? {})) out[id] = { type: "busy" };
      return out as T;
    }

    if (seg[0] === "session" && seg[1]) {
      const sid = seg[1];
      const rest = seg.slice(2).join("/");

      if (rest === "" && m === "GET") {
        const raw = await sessionScoped(sid, "GET", "");
        return translateSession(raw) as T;
      }
      if (rest === "" && m === "DELETE") return sessionScoped(sid, "DELETE", "");
      if (rest === "" && m === "PATCH") {
        await sessionScoped(sid, "PATCH", "", {
          body: asString(body.title) !== undefined ? { title: body.title } : {},
        });
        const raw = await sessionScoped(sid, "GET", "");
        return translateSession(raw) as T;
      }
      if (rest === "children" && m === "GET") {
        const raw = await this.v2("GET", "/api/session", {
          ...opts,
          query: { parentID: sid, limit: "200" },
        });
        return translateSessionList(raw) as T;
      }
      if (rest === "todo") {
        throw new UnsupportedOnV2Error(
          `GET /session/{id}/todo`,
          "v2 does not expose a session todo list endpoint.",
        );
      }
      if (rest === "init" && m === "POST") {
        await this.applySessionSelection(
          sid,
          {
            model: { providerID: body.providerID, modelID: body.modelID },
          },
          opts,
        );
        return sessionScoped(sid, "POST", "/command", {
          body: { name: "init", text: "" },
        });
      }
      if (rest === "abort" && m === "POST") {
        return sessionScoped(sid, "POST", "/interrupt", { body: {} });
      }
      if (rest === "fork" && m === "POST") {
        const raw = await sessionScoped(sid, "POST", "/fork", {
          body: asString(body.messageID) ? { before: body.messageID } : {},
        });
        return translateSession(raw) as T;
      }
      if (rest === "share" || rest === "unshare") {
        throw new UnsupportedOnV2Error(`${m} /session/{id}/share`);
      }
      if (rest === "diff" && m === "GET") {
        const extra: Record<string, string> = {};
        if (query?.messageID) extra.from = query.messageID;
        const raw = await sessionScoped(sid, "GET", "/diff", { query: extra });
        return translateDiffs(raw) as T;
      }
      if (rest === "summarize" && m === "POST") {
        await this.applySessionSelection(
          sid,
          { model: { providerID: body.providerID, modelID: body.modelID } },
          opts,
        );
        return sessionScoped(sid, "POST", "/compact", { body: {} });
      }
      if (rest === "revert" && m === "POST") {
        await sessionScoped(sid, "POST", "/revert/stage", {
          body: { messageID: body.messageID, files: true },
        });
        return sessionScoped(sid, "POST", "/revert/commit", { body: {} });
      }
      if (rest === "unrevert" && m === "POST") {
        return sessionScoped(sid, "DELETE", "/revert");
      }
      if (rest === "message" && m === "GET") {
        return this.fetchMessages(sid, opts, query?.limit) as Promise<T>;
      }
      const messageGet = rest.match(/^message\/([^/]+)$/);
      if (messageGet && m === "GET") {
        const raw = await sessionScoped(sid, "GET", `/message/${messageGet[1]}`);
        return translateMessage(raw) as T;
      }
      if (rest === "message" && m === "POST") {
        return this.syncPrompt<T>(sid, body, opts);
      }
      if (rest === "prompt_async" && m === "POST") {
        await this.asyncPrompt(sid, body, opts);
        return undefined as T;
      }
      if (rest === "command" && m === "POST") {
        const modelPair = (() => {
          const rawModel = body.model;
          if (typeof rawModel === "string" && rawModel.includes("/")) {
            const idx = rawModel.indexOf("/");
            return {
              providerID: rawModel.slice(0, idx),
              modelID: rawModel.slice(idx + 1),
            };
          }
          if (isRecord(rawModel)) {
            return {
              providerID: asString(rawModel.providerID),
              modelID: asString(rawModel.modelID) ?? asString(rawModel.id),
            };
          }
          return undefined;
        })();
        await this.applySessionSelection(
          sid,
          {
            ...(modelPair?.providerID && modelPair?.modelID
              ? { model: modelPair }
              : {}),
            variant: body.variant,
            agent: body.agent,
          },
          opts,
        );
        await sessionScoped(sid, "POST", "/command", {
          body: {
            name: asString(body.command) ?? "",
            text: asString(body.arguments) ?? "",
          },
        });
        await this.waitForIdle(sid, opts);
        const messages = await this.fetchMessages(sid, opts);
        const assistants = messages.filter(
          (x) => isRecord(x.info) && x.info.role === "assistant",
        );
        return (assistants[assistants.length - 1] ?? {
          info: { id: "?", role: "assistant" },
          parts: [],
        }) as T;
      }
      if (rest === "shell" && m === "POST") {
        await this.applySessionSelection(sid, body, opts);
        const before = await this.fetchMessages(sid, opts).catch(() => [] as Rec[]);
        const beforeIds = new Set(
          before.map((x) => (isRecord(x.info) ? x.info.id : undefined)),
        );
        await sessionScoped(sid, "POST", "/shell", {
          body: { command: asString(body.command) ?? "" },
        });
        await this.waitForIdle(sid, opts);
        const after = await this.fetchMessages(sid, opts);
        const shellMsg = [...after]
          .reverse()
          .find(
            (x) =>
              isRecord(x.info) &&
              x.info.role === "shell" &&
              !beforeIds.has(x.info.id),
          );
        if (shellMsg) {
          return {
            info: { id: (shellMsg.info as Rec).id, role: "assistant" },
            parts: shellMsg.parts,
          } as T;
        }
        return { info: { id: "?", role: "assistant" }, parts: [] } as T;
      }
    }

    throw new UnsupportedOnV2Error(`${m} ${path}`);
  }

  // ── Public internal-path API (used by tools) ────────────────────────

  async get<T = unknown>(
    path: string,
    query?: Record<string, string>,
    directory?: string,
    opts?: { deadlineAt?: number; signal?: AbortSignal },
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
    // v2 streams all locations on one endpoint; directory is validated for
    // policy parity but events carry their own location field.
    this.checkedDirectory(opts?.directory);
    const v2path = path === "/event" ? "/api/event" : path;
    const url = new URL(v2path, `${this.baseUrl}/`).toString();
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      ...this.authHeaders(),
    };

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



