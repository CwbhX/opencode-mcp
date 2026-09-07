import { afterEach, describe, expect, it } from "vitest";
import type { OpenCodeClient } from "../src/client.js";
import {
  acquireEventMonitor,
  resetEventMonitorsForTests,
  type AppEvent,
  type EventMonitorKey,
} from "../src/event-monitor.js";

const BASE = "http://127.0.0.1:4096";
const KEY: EventMonitorKey = { serverBaseUrl: BASE, directory: "/tmp/proj" };

type SseFrame = { event: string; data: string };
type SseItem = { kind: "frame"; frame: SseFrame } | { kind: "end" } | { kind: "error"; error: Error };

type SubscribeOpts = { signal?: AbortSignal; directory?: string };

interface SseCall {
  path: string;
  directory?: string;
  signal?: AbortSignal;
}

function sse(
  type: string,
  properties?: Record<string, unknown>,
  eventName = "message",
): SseFrame {
  const body =
    properties === undefined ? { type } : { type, properties };
  return { event: eventName, data: JSON.stringify(body) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

function createSseHub() {
  const calls: SseCall[] = [];
  const generations: Array<{
    push: (frame: SseFrame) => void;
    end: () => void;
    fail: (error: Error) => void;
  }> = [];

  const subscribeSSE: OpenCodeClient["subscribeSSE"] = async function* (
    path: string,
    opts?: SubscribeOpts,
  ) {
    const queue: SseItem[] = [];
    let wake: (() => void) | undefined;

    const deliver = (item: SseItem) => {
      queue.push(item);
      wake?.();
    };

    const generation = {
      push: (frame: SseFrame) => deliver({ kind: "frame", frame }),
      end: () => deliver({ kind: "end" }),
      fail: (error: Error) => deliver({ kind: "error", error }),
    };
    generations.push(generation);
    calls.push({ path, directory: opts?.directory, signal: opts?.signal });

    const onAbort = () => deliver({ kind: "end" });
    if (opts?.signal) {
      if (opts.signal.aborted) return;
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      while (true) {
        while (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        const item = queue.shift()!;
        if (item.kind === "end") return;
        if (item.kind === "error") throw item.error;
        yield item.frame;
      }
    } finally {
      opts?.signal?.removeEventListener("abort", onAbort);
    }
  };

  return {
    calls,
    generations,
    subscribeSSE,
    client() {
      return {
        getBaseUrl: () => BASE,
        subscribeSSE,
      };
    },
    latest() {
      return generations[generations.length - 1];
    },
    push(frame: SseFrame) {
      const latest = generations[generations.length - 1];
      if (!latest) throw new Error("no active SSE generation");
      latest.push(frame);
    },
    end() {
      const latest = generations[generations.length - 1];
      if (!latest) throw new Error("no active SSE generation");
      latest.end();
    },
    fail(error: Error) {
      const latest = generations[generations.length - 1];
      if (!latest) throw new Error("no active SSE generation");
      latest.fail(error);
    },
  };
}

afterEach(() => {
  resetEventMonitorsForTests();
});

describe("acquireEventMonitor", () => {
  it("returns a shared monitor for the same server + directory and starts SSE lazily", async () => {
    const hub = createSseHub();
    const client = hub.client();
    const first = acquireEventMonitor(client, KEY);
    const second = acquireEventMonitor(client, {
      serverBaseUrl: `${BASE}/`,
      directory: "/tmp/proj",
    });
    const otherDir = acquireEventMonitor(client, {
      serverBaseUrl: BASE,
      directory: "/tmp/other",
    });

    expect(first).toBe(second);
    expect(otherDir).not.toBe(first);
    expect(first.key.serverBaseUrl).toBe(BASE);
    expect(hub.calls).toHaveLength(0);

    first.on({ sessionId: "ses_a" }, () => {});
    await waitFor("first subscribeSSE", () => hub.calls.length === 1);
    expect(hub.calls[0]).toMatchObject({
      path: "/event",
      directory: "/tmp/proj",
    });
    expect(hub.calls[0]?.signal).toBeInstanceOf(AbortSignal);

    otherDir.on({}, () => {});
    await waitFor("second subscribeSSE", () => hub.calls.length === 2);
    expect(hub.calls[1]).toMatchObject({
      path: "/event",
      directory: "/tmp/other",
    });
  });
});

describe("EVENT-01", () => {
  it("EVENT-01: malformed JSON does not throw; valid JSON type taken from payload", async () => {
    const hub = createSseHub();
    const received: AppEvent[] = [];
    const monitor = acquireEventMonitor(hub.client(), KEY);

    const unsubscribe = monitor.on({ sessionId: "ses_1" }, (event) => {
      received.push(event);
      if (event.type === "explode") {
        throw new Error("listener must not crash the monitor");
      }
    });

    await waitFor("SSE start", () => hub.calls.length === 1);

    hub.push({ event: "session.error", data: "{not-json" });
    hub.push({
      event: "ignored-frame-name",
      data: JSON.stringify({
        type: "session.error",
        properties: { sessionID: "ses_1" },
      }),
    });
    hub.push({
      event: "message",
      data: '{\n  "type": "session.idle",\n  "properties": { "sessionID": "ses_1" }\n}',
    });
    hub.push({
      event: "envelope",
      data: JSON.stringify({
        payload: {
          type: "explode",
          properties: { sessionID: "ses_1" },
        },
      }),
    });
    hub.push({
      event: "message",
      data: JSON.stringify({
        type: "session.error",
        properties: { sessionID: "ses_1", detail: "still listening" },
      }),
    });

    await waitFor("parsed application events", () => received.length >= 4);

    expect(received.map((e) => e.type)).toEqual([
      "session.error",
      "session.idle",
      "explode",
      "session.error",
    ]);
    expect(received[0]?.raw).toEqual({
      type: "session.error",
      properties: { sessionID: "ses_1" },
    });
    unsubscribe();
  });
});

describe("EVENT-03", () => {
  it("EVENT-03: wrong-session event does not reach the listener", async () => {
    const hub = createSseHub();
    const received: string[] = [];
    const monitor = acquireEventMonitor(hub.client(), KEY);

    monitor.on({ sessionId: "ses_job" }, (event) => {
      received.push(event.type);
    });
    await waitFor("SSE start", () => hub.calls.length === 1);

    hub.push(sse("session.error", { sessionID: "ses_other" }));
    hub.push(sse("session.status", { status: "busy" }));
    hub.push(sse("session.error", { sessionId: "ses_job" }));
    hub.push(sse("server.connected"));

    await waitFor("matching and global-connected events", () => received.length === 2);
    await new Promise((r) => setTimeout(r, 20));

    expect(received).toEqual(["session.error", "server.connected"]);
  });

  it("filters by messageId and still requires a session match", async () => {
    const hub = createSseHub();
    const received: string[] = [];
    const monitor = acquireEventMonitor(hub.client(), KEY);

    monitor.on({ sessionId: "ses_job", messageId: "msg_turn" }, (event) => {
      received.push(`${event.type}:${String(event.properties?.tag ?? "none")}`);
    });
    await waitFor("SSE start", () => hub.calls.length === 1);

    hub.push(sse("session.error", { sessionID: "ses_job", messageID: "msg_other", tag: "other-msg" }));
    hub.push(sse("session.error", { sessionID: "ses_other", messageID: "msg_turn", tag: "other-ses" }));
    hub.push(sse("session.error", { sessionID: "ses_job", messageID: "msg_turn", tag: "match-id" }));
    hub.push(sse("session.error", { sessionID: "ses_job", parentID: "msg_turn", tag: "match-parent" }));
    hub.push(sse("session.idle", { sessionID: "ses_job", tag: "session-level" }));

    await waitFor("message-filtered events", () => received.length === 3);
    await new Promise((r) => setTimeout(r, 20));

    expect(received).toEqual([
      "session.error:match-id",
      "session.error:match-parent",
      "session.idle:session-level",
    ]);
  });
});

describe("EVENT-04", () => {
  it("EVENT-04: unsubscribe/close stops the stream; second acquire after close can start fresh", async () => {
    const hub = createSseHub();
    const client = hub.client();
    const first = acquireEventMonitor(client, KEY);
    const received: string[] = [];

    const unsubscribe = first.on({ sessionId: "ses_job" }, (event) => {
      received.push(event.type);
    });
    await waitFor("first stream", () => hub.calls.length === 1);
    const firstSignal = hub.calls[0]?.signal;
    expect(firstSignal?.aborted).toBe(false);

    hub.push(sse("session.error", { sessionID: "ses_job" }));
    await waitFor("first event", () => received.length === 1);

    unsubscribe();
    await waitFor("first stream abort", () => firstSignal?.aborted === true);
    expect(hub.calls).toHaveLength(1);

    first.close();
    expect(firstSignal?.aborted).toBe(true);

    const second = acquireEventMonitor(client, KEY);
    expect(second).not.toBe(first);
    expect(second.observationGap).toBe(false);

    const later: string[] = [];
    second.on({ sessionId: "ses_job" }, (event) => {
      later.push(event.type);
    });
    await waitFor("fresh stream", () => hub.calls.length === 2);
    expect(hub.calls[1]?.signal).not.toBe(firstSignal);
    expect(hub.calls[1]?.signal?.aborted).toBe(false);

    hub.push(sse("session.error", { sessionID: "ses_job" }));
    await waitFor("event on fresh monitor", () => later.length === 1);
    expect(later).toEqual(["session.error"]);
    expect(received).toEqual(["session.error"]);
  });
});

describe("waitUntilReady", () => {
  it("resolves on server.connected", async () => {
    const hub = createSseHub();
    const monitor = acquireEventMonitor(hub.client(), KEY);
    const ready = monitor.waitUntilReady(performance.now() + 2000);

    await waitFor("SSE start from waitUntilReady", () => hub.calls.length === 1);
    expect(hub.calls[0]).toMatchObject({ path: "/event", directory: "/tmp/proj" });

    hub.push({
      event: "ready",
      data: JSON.stringify({ type: "server.connected" }),
    });
    await expect(ready).resolves.toBeUndefined();
  });

  it("resolves when the first application event arrives if server.connected is absent", async () => {
    const hub = createSseHub();
    const monitor = acquireEventMonitor(hub.client(), KEY);
    const ready = monitor.waitUntilReady(performance.now() + 2000);
    await waitFor("SSE start", () => hub.calls.length === 1);
    hub.push(sse("session.error", { sessionID: "ses_job" }));
    await expect(ready).resolves.toBeUndefined();
  });

  it("times out when deadline already passed", async () => {
    const hub = createSseHub();
    const monitor = acquireEventMonitor(hub.client(), KEY);
    await expect(monitor.waitUntilReady(0)).rejects.toThrow(/observation_failed/i);
    await expect(monitor.waitUntilReady(performance.now() - 10)).rejects.toThrow(
      /observation_failed/i,
    );
    expect(hub.calls).toHaveLength(0);
  });

  it("rejects when the abort signal fires before readiness", async () => {
    const hub = createSseHub();
    const monitor = acquireEventMonitor(hub.client(), KEY);
    const controller = new AbortController();
    const ready = monitor.waitUntilReady(performance.now() + 2000, controller.signal);
    await waitFor("SSE start", () => hub.calls.length === 1);
    controller.abort();
    await expect(ready).rejects.toThrow(/observation_failed/i);
  });
});

describe("observationGap", () => {
  it("becomes true if subscribeSSE throws after start", async () => {
    const started = deferred<void>();
    let generations = 0;
    const client = {
      getBaseUrl: () => BASE,
      async *subscribeSSE(_path: string, opts?: { signal?: AbortSignal }) {
        generations += 1;
        if (generations === 1) {
          started.resolve();
          yield sse("server.connected");
          throw new Error("socket reset");
        }
        await new Promise<void>((resolve) => {
          if (opts?.signal?.aborted) {
            resolve();
            return;
          }
          opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    const monitor = acquireEventMonitor(client, KEY);
    const received: string[] = [];
    monitor.on({}, (event) => {
      received.push(event.type);
    });

    await started.promise;
    await waitFor("observation gap after throw", () => monitor.observationGap);
    expect(received).toEqual(["server.connected"]);
  });

  it("becomes true if the generator ends unexpectedly and stays set until server.connected", async () => {
    const hub = createSseHub();
    const monitor = acquireEventMonitor(hub.client(), KEY);
    const received: string[] = [];
    monitor.on({ sessionId: "ses_job" }, (event) => {
      received.push(event.type);
    });

    await waitFor("SSE start", () => hub.calls.length === 1);
    hub.push(sse("server.connected"));
    await waitFor("initial connected", () => received.includes("server.connected"));
    expect(monitor.observationGap).toBe(false);

    hub.end();
    await waitFor("gap after unexpected end", () => monitor.observationGap);
    await waitFor("reconnect", () => hub.calls.length === 2);
    expect(monitor.observationGap).toBe(true);

    hub.push(sse("session.error", { sessionID: "ses_job" }));
    await waitFor("post-reconnect session event", () => received.includes("session.error"));
    expect(monitor.observationGap).toBe(true);

    hub.push(sse("server.connected"));
    await waitFor("gap cleared", () => monitor.observationGap === false);
  });
});
