import type { OpenCodeClient } from "./client.js";
import { defaultClock } from "./request-context.js";

export interface AppEvent {
  type: string;
  properties?: Record<string, unknown>;
  raw?: unknown;
}

export interface EventMonitorKey {
  serverBaseUrl: string;
  directory?: string;
}

export interface EventMonitor {
  readonly key: EventMonitorKey;
  readonly observationGap: boolean;
  waitUntilReady(deadlineAt: number, signal?: AbortSignal): Promise<void>;
  /** Subscribe; return unsubscribe. Filter by sessionId/messageId when those fields are present on the event. */
  on(filter: { sessionId?: string; messageId?: string }, listener: (event: AppEvent) => void): () => void;
  close(): void;
}

type EventMonitorClient = {
  subscribeSSE: OpenCodeClient["subscribeSSE"];
  getBaseUrl(): string;
};

type EventFilter = { sessionId?: string; messageId?: string };
type ListenerEntry = { filter: EventFilter; listener: (event: AppEvent) => void };
type ReadyWaiter = { resolve: () => void; reject: (error: Error) => void };

const MAX_RECENT_EVENTS = 100;
const MAX_RECONNECT_ATTEMPTS = 3;
const clock = defaultClock();

const monitors = new Map<string, SharedEventMonitor>();

function observationFailed(reason: string): Error {
  const error = new Error(`observation_failed: ${reason}`);
  error.name = "ObservationFailedError";
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeKey(key: EventMonitorKey): EventMonitorKey {
  const serverBaseUrl = key.serverBaseUrl.replace(/\/+$/, "");
  const directory = key.directory ? key.directory : undefined;
  return directory === undefined ? { serverBaseUrl } : { serverBaseUrl, directory };
}

function cacheKey(key: EventMonitorKey): string {
  const normalized = normalizeKey(key);
  return `${normalized.serverBaseUrl}\0${normalized.directory ?? ""}`;
}

function evict(monitor: SharedEventMonitor): void {
  const id = cacheKey(monitor.key);
  if (monitors.get(id) === monitor) {
    monitors.delete(id);
  }
}

function applicationType(parsed: Record<string, unknown>): string | undefined {
  const direct = asString(parsed.type);
  if (direct) return direct;
  if (isRecord(parsed.payload)) {
    return asString(parsed.payload.type);
  }
  return undefined;
}

function eventProperties(
  parsed: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (isRecord(parsed.properties)) return parsed.properties;
  if (isRecord(parsed.payload) && isRecord(parsed.payload.properties)) {
    return parsed.payload.properties;
  }
  return undefined;
}

function sessionIdOf(event: AppEvent): string | undefined {
  const props = event.properties;
  const raw = isRecord(event.raw) ? event.raw : undefined;
  const payload = raw && isRecord(raw.payload) ? raw.payload : undefined;
  return (
    asString(props?.sessionID) ??
    asString(props?.sessionId) ??
    asString(raw?.sessionID) ??
    asString(raw?.sessionId) ??
    asString(payload?.sessionID) ??
    asString(payload?.sessionId)
  );
}

function messageIdOf(event: AppEvent): string | undefined {
  const props = event.properties;
  const raw = isRecord(event.raw) ? event.raw : undefined;
  const payload = raw && isRecord(raw.payload) ? raw.payload : undefined;
  return (
    asString(props?.messageID) ??
    asString(props?.messageId) ??
    asString(props?.parentID) ??
    asString(raw?.messageID) ??
    asString(raw?.messageId) ??
    asString(raw?.parentID) ??
    asString(payload?.messageID) ??
    asString(payload?.messageId) ??
    asString(payload?.parentID)
  );
}

function matches(filter: EventFilter, event: AppEvent): boolean {
  if (filter.sessionId) {
    const sessionId = sessionIdOf(event);
    if (sessionId !== undefined) {
      if (sessionId !== filter.sessionId) return false;
    } else if (event.type !== "server.connected") {
      return false;
    }
  }

  if (filter.messageId) {
    const messageId = messageIdOf(event);
    if (messageId !== undefined && messageId !== filter.messageId) {
      return false;
    }
  }

  return true;
}

function notifyListener(listener: (event: AppEvent) => void, event: AppEvent): void {
  try {
    listener(event);
  } catch {
    // Invalid or hostile listeners must not take down the MCP process.
  }
}

function backoffMs(attempt: number): number {
  return Math.min(25 * 2 ** (attempt - 1), 200);
}

class SharedEventMonitor implements EventMonitor {
  readonly key: EventMonitorKey;
  private readonly client: EventMonitorClient;
  private readonly listeners = new Set<ListenerEntry>();
  private readonly readyWaiters = new Set<ReadyWaiter>();
  private readonly recent: AppEvent[] = [];
  private _observationGap = false;
  private ready = false;
  private closed = false;
  private waiterCount = 0;
  private running = false;
  private abort?: AbortController;

  constructor(client: EventMonitorClient, key: EventMonitorKey) {
    this.client = client;
    this.key = key;
  }

  get observationGap(): boolean {
    return this._observationGap;
  }

  async waitUntilReady(deadlineAt: number, signal?: AbortSignal): Promise<void> {
    if (this.closed) {
      throw observationFailed("event monitor is closed");
    }
    if (signal?.aborted) {
      throw observationFailed("aborted");
    }
    if (this.ready) {
      return;
    }
    if (clock.monotonic() >= deadlineAt) {
      throw observationFailed("deadline elapsed");
    }

    this.waiterCount += 1;
    this.ensureStarted();
    try {
      await this.awaitReady(deadlineAt, signal);
    } finally {
      this.waiterCount -= 1;
      this.releaseIfIdle();
    }
  }

  on(filter: EventFilter, listener: (event: AppEvent) => void): () => void {
    if (this.closed) {
      throw observationFailed("event monitor is closed");
    }

    const entry: ListenerEntry = { filter, listener };
    this.listeners.add(entry);
    for (const event of this.recent) {
      if (matches(filter, event)) {
        notifyListener(listener, event);
      }
    }
    this.ensureStarted();

    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(entry);
      this.releaseIfIdle();
    };
  }

  close(): void {
    if (this.closed) {
      this.abort?.abort();
      evict(this);
      return;
    }
    this.closed = true;
    this.abort?.abort();
    this.listeners.clear();
    this.rejectReady(observationFailed("event monitor closed"));
    evict(this);
  }

  private isActive(): boolean {
    return this.listeners.size > 0 || this.waiterCount > 0;
  }

  private releaseIfIdle(): void {
    if (!this.isActive()) {
      this.close();
    }
  }

  private ensureStarted(): void {
    if (this.closed || this.running) return;
    if (!this.abort || this.abort.signal.aborted) {
      this.abort = new AbortController();
    }
    this.running = true;
    void this.runPump().finally(() => {
      this.running = false;
    });
  }

  private async runPump(): Promise<void> {
    let failures = 0;
    while (!this.closed && this.isActive() && !this.abort?.signal.aborted) {
      try {
        const stream = this.client.subscribeSSE("/event", {
          directory: this.key.directory,
          signal: this.abort?.signal,
        });
        for await (const frame of stream) {
          if (this.closed || this.abort?.signal.aborted) return;
          this.handleFrame(frame);
          failures = 0;
        }
        if (this.closed || this.abort?.signal.aborted || !this.isActive()) {
          return;
        }
        this._observationGap = true;
      } catch {
        if (this.closed || this.abort?.signal.aborted || !this.isActive()) {
          return;
        }
        this._observationGap = true;
      }

      failures += 1;
      if (failures > MAX_RECONNECT_ATTEMPTS) {
        return;
      }
      try {
        await clock.sleep(backoffMs(failures), this.abort?.signal);
      } catch {
        return;
      }
    }
  }

  private handleFrame(frame: { event: string; data: string }): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.data);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const type = applicationType(parsed);
    if (!type) return;
    const properties = eventProperties(parsed);
    this.dispatch({
      type,
      ...(properties ? { properties } : {}),
      raw: parsed,
    });
  }

  private dispatch(event: AppEvent): void {
    this.recent.push(event);
    if (this.recent.length > MAX_RECENT_EVENTS) {
      this.recent.shift();
    }

    if (event.type === "server.connected") {
      this._observationGap = false;
    }
    if (!this.ready) {
      this.ready = true;
      this.resolveReady();
    }

    for (const entry of this.listeners) {
      if (matches(entry.filter, event)) {
        notifyListener(entry.listener, event);
      }
    }
  }

  private awaitReady(deadlineAt: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let waiter: ReadyWaiter;

      const complete = (fn: () => void) => {
        if (settled) return;
        settled = true;
        this.readyWaiters.delete(waiter);
        signal?.removeEventListener("abort", onAbort);
        clearTimeout(timer);
        fn();
      };

      waiter = {
        resolve: () => complete(resolve),
        reject: (error: Error) => complete(() => reject(error)),
      };

      const onAbort = () => waiter.reject(observationFailed("aborted"));
      const remaining = Math.max(0, deadlineAt - clock.monotonic());
      const timer = setTimeout(() => {
        waiter.reject(observationFailed("deadline elapsed"));
      }, remaining);

      this.readyWaiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });

      if (this.ready) {
        waiter.resolve();
        return;
      }
      if (signal?.aborted) {
        waiter.reject(observationFailed("aborted"));
      }
    });
  }

  private resolveReady(): void {
    const waiters = [...this.readyWaiters];
    this.readyWaiters.clear();
    for (const waiter of waiters) waiter.resolve();
  }

  private rejectReady(error: Error): void {
    const waiters = [...this.readyWaiters];
    this.readyWaiters.clear();
    for (const waiter of waiters) waiter.reject(error);
  }
}

export function acquireEventMonitor(
  client: EventMonitorClient,
  key: EventMonitorKey,
): EventMonitor {
  const normalized = normalizeKey(key);
  const id = cacheKey(normalized);
  const existing = monitors.get(id);
  if (existing) return existing;
  const created = new SharedEventMonitor(client, normalized);
  monitors.set(id, created);
  return created;
}

export function resetEventMonitorsForTests(): void {
  const active = [...monitors.values()];
  monitors.clear();
  for (const monitor of active) {
    monitor.close();
  }
}
