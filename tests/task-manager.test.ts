import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Clock } from "../src/bridge-types.js";
import {
  AmbiguousAcceptanceError,
  SessionBusyError,
  SessionDirectoryMismatchError,
} from "../src/bridge-types.js";
import { OpenCodeError } from "../src/http-transport.js";
import { isValidMessageId } from "../src/opencode-id.js";
import { resetEventMonitorsForTests } from "../src/event-monitor.js";
import {
  createTaskManager,
  type SubmitPromptInput,
  type TaskManager,
} from "../src/task-manager.js";

const BASE = "http://127.0.0.1:4096/";
const SESSION = "ses_bridge_task";
const MODEL = {
  providerID: "opencode",
  modelID: "muse-spark-1.3-contributor-free",
} as const;

const ENV_KEYS = [
  "OPENCODE_DEFAULT_PROVIDER",
  "OPENCODE_DEFAULT_MODEL",
  "OPENCODE_REQUIRE_EXPLICIT_MODEL",
  "OPENCODE_ALLOWED_MODELS",
] as const;

const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> =
  {};

function createFakeClock(start = performance.now()): Clock {
  let mono = start;
  let wall = Date.now();
  return {
    now: () => wall,
    monotonic: () => mono,
    async sleep(ms: number, signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        throw error;
      }
      mono += ms;
      wall += ms;
    },
  };
}

function connectedSse() {
  return async function* subscribeSSE(
    _path: string,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<{ event: string; data: string }> {
    yield { event: "message", data: '{"type":"server.connected"}' };
    await new Promise<void>((resolve) => {
      if (!opts?.signal) return;
      if (opts.signal.aborted) {
        resolve();
        return;
      }
      opts.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  };
}

function assistant(parentID: string, extras?: { id?: string; text?: string }) {
  return {
    info: {
      id: extras?.id ?? "msg_assistant_done",
      role: "assistant",
      parentID,
      providerID: MODEL.providerID,
      modelID: MODEL.modelID,
      finish: "stop",
      time: { created: 1, completed: 2 },
    },
    parts: [{ type: "text", text: extras?.text ?? "done" }],
  };
}

function notFound(pathName: string): OpenCodeError {
  return new OpenCodeError(
    `GET ${pathName} failed (404)`,
    404,
    "GET",
    pathName,
    "",
  );
}

interface HarnessState {
  sessions: Map<string, { id: string; directory?: string }>;
  messages: Map<string, unknown[]>;
  status: Record<string, unknown>;
  permissions: unknown[];
  questions: unknown[];
  missingSessions: Set<string>;
  promptAsync?: () => Promise<unknown>;
}

const HARNESS_DIR = tmpdir();

function createHarness(initial?: Partial<HarnessState>) {
  const state: HarnessState = {
    sessions: new Map([[SESSION, { id: SESSION, directory: HARNESS_DIR }]]),
    messages: new Map(),
    status: {},
    permissions: [],
    questions: [],
    missingSessions: new Set(),
    ...initial,
  };

  const get = vi.fn(
    async (pathName: string): Promise<unknown> => {
      if (pathName === "/session/status") return state.status;
      if (pathName === "/permission") return state.permissions;
      if (pathName === "/question") return state.questions;
      const messageMatch = pathName.match(/^\/session\/([^/]+)\/message$/);
      if (messageMatch) {
        return state.messages.get(messageMatch[1]!) ?? [];
      }
      const sessionMatch = pathName.match(/^\/session\/([^/]+)$/);
      if (sessionMatch) {
        const id = sessionMatch[1]!;
        if (state.missingSessions.has(id)) throw notFound(pathName);
        return state.sessions.get(id) ?? { id, directory: HARNESS_DIR };
      }
      throw notFound(pathName);
    },
  );

  const post = vi.fn(
    async (pathName: string, _body?: unknown): Promise<unknown> => {
      if (pathName === "/session") {
        const id = "ses_created_by_bridge";
        state.sessions.set(id, { id, directory: HARNESS_DIR });
        return { id, directory: HARNESS_DIR };
      }
      if (/^\/session\/[^/]+\/prompt_async$/.test(pathName)) {
        if (state.promptAsync) return state.promptAsync();
        return undefined;
      }
      throw new Error(`unexpected POST ${pathName}`);
    },
  );

  const client = {
    getBaseUrl: () => BASE,
    get,
    post,
    subscribeSSE: connectedSse(),
  };

  return { client, get, post, state };
}

function promptAsyncCalls(post: ReturnType<typeof vi.fn>): unknown[][] {
  return post.mock.calls.filter(([pathName]) =>
    String(pathName).endsWith("/prompt_async"),
  );
}

describe("createTaskManager", () => {
  let clock: Clock;
  let harness: ReturnType<typeof createHarness>;
  let manager: TaskManager;
  let scratch: string | undefined;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    clock = createFakeClock();
    harness = createHarness();
    manager = createTaskManager({ client: harness.client, clock });
  });

  afterEach(async () => {
    manager.reset();
    resetEventMonitorsForTests();
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (scratch) {
      await rm(scratch, { recursive: true, force: true });
      scratch = undefined;
    }
  });

  function submitInput(
    overrides: Partial<SubmitPromptInput> = {},
  ): SubmitPromptInput {
    return {
      prompt: "do the work",
      sessionId: SESSION,
      providerID: MODEL.providerID,
      modelID: MODEL.modelID,
      deadlineAt: clock.monotonic() + 30_000,
      ...overrides,
    };
  }

  it("ASYNC-01: submitAsync returns accepted handle while you have NOT yielded a terminal assistant", async () => {
    const result = await manager.submitAsync(submitInput());

    expect(result.submissionState).toBe("accepted");
    expect(["queued", "running"]).toContain(result.state);
    expect(result.state).not.toBe("succeeded");
    expect(result.terminal).not.toBe(true);
    expect(result.mayStillBeRunning).toBe(true);
    expect(result.sessionId).toBe(SESSION);
    expect(result.requestMessageID).toBeDefined();
    expect(isValidMessageId(result.requestMessageID!)).toBe(true);
    expect(result.jobId).toMatch(/^job_/);
    expect(harness.state.messages.get(SESSION) ?? []).toEqual([]);
  });

  it("ASYNC-02: POST path is /session/{id}/prompt_async and handles 204", async () => {
    const result = await manager.submitAsync(submitInput());
    const calls = promptAsyncCalls(harness.post);

    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(`/session/${SESSION}/prompt_async`);
    expect(calls[0]![1]).toMatchObject({
      parts: [{ type: "text", text: "do the work" }],
      messageID: result.requestMessageID,
      model: MODEL,
    });
    expect(calls[0]![2]).toMatchObject({ retryClass: "mutation" });
    expect(result.submissionState).toBe("accepted");
    expect(result.state).not.toBe("succeeded");
  });

  it("JOB-01: GET session 404 => failed, not succeeded", async () => {
    harness.state.missingSessions.add(SESSION);

    const result = await manager.submitAsync(submitInput());

    expect(result.state).toBe("failed");
    expect(result.state).not.toBe("succeeded");
    expect(result.terminal).toBe(true);
    expect(result.mayStillBeRunning).toBe(false);
    expect(result.error).toMatch(/missing|404/i);
    expect(result.nextAction).toMatch(/do not claim Done|missing|failed lookup/i);
    expect(promptAsyncCalls(harness.post)).toHaveLength(0);
  });

  it("JOB-02: old assistant with different parentID does not make check() succeeded", async () => {
    const submitted = await manager.submitAsync(submitInput());
    harness.state.messages.set(SESSION, [
      assistant("msg_from_an_older_turn", { id: "msg_old_assistant" }),
    ]);

    const checked = await manager.check({ jobId: submitted.jobId });

    expect(checked.state).not.toBe("succeeded");
    expect(checked.terminal).not.toBe(true);
    expect(checked.requestMessageID).toBe(submitted.requestMessageID);
    expect(submitted.requestMessageID).not.toBe("msg_from_an_older_turn");
  });

  it("DEADLINE-03: wait times out; later check can succeed when you then provide correlated terminal assistant", async () => {
    const submitted = await manager.submitAsync(submitInput());

    const waited = await manager.wait(
      { jobId: submitted.jobId },
      { deadlineAt: clock.monotonic() + 10, pollIntervalMs: 50 },
    );

    expect(waited.waitOutcome).toBe("timed_out");
    expect(waited.state).not.toBe("succeeded");
    expect(waited.state).not.toBe("aborted");
    expect(waited.mayStillBeRunning).toBe(true);

    await expect(manager.submitAsync(submitInput())).rejects.toBeInstanceOf(
      SessionBusyError,
    );

    harness.state.messages.set(SESSION, [
      assistant(submitted.requestMessageID!, { text: "finished after wait" }),
    ]);

    const checked = await manager.check({ jobId: submitted.jobId });
    expect(checked.state).toBe("succeeded");
    expect(checked.waitOutcome).toBeUndefined();
    expect(checked.terminal).toBe(true);
    expect(promptAsyncCalls(harness.post)).toHaveLength(1);
  });

  it("CONCUR-01: second submitAsync same session throws SessionBusyError", async () => {
    await manager.submitAsync(submitInput());

    await expect(manager.submitAsync(submitInput())).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof SessionBusyError && error.sessionId === SESSION,
    );
    expect(promptAsyncCalls(harness.post)).toHaveLength(1);
  });

  it("JOB-11: check({ jobId: \"unknown\" }) untracked", async () => {
    const unknown = await manager.check({ jobId: "unknown" });
    expect(unknown.tracking).toBe("untracked");
    expect(unknown.state).not.toBe("succeeded");
    expect(unknown.terminal).not.toBe(true);
    expect(unknown.jobId).toBe("unknown");

    const submitted = await manager.submitAsync(submitInput());
    manager.reset();
    const afterRestart = await manager.check({ jobId: submitted.jobId });
    expect(afterRestart.tracking).toBe("untracked");
    expect(afterRestart.state).not.toBe("succeeded");
    expect(afterRestart.nextAction).toMatch(/untracked|unknown|recover/i);
  });

  it("REPLAY-01: post throws AmbiguousAcceptanceError => unknown, post called once", async () => {
    harness.state.promptAsync = async () => {
      throw new AmbiguousAcceptanceError(
        "POST /session/ses_bridge_task/prompt_async acceptance is unknown",
        {
          operation: "POST /session/ses_bridge_task/prompt_async",
          submissionState: "unknown",
          mayStillBeRunning: true,
          safeToResubmit: false,
          nextAction: "Inspect this job or message; do not resend automatically.",
        },
      );
    };

    const result = await manager.submitAsync(submitInput());

    expect(result.submissionState).toBe("unknown");
    expect(result.mayStillBeRunning).toBe(true);
    expect(result.safeToResubmit).toBe(false);
    expect(result.state).not.toBe("succeeded");
    expect(promptAsyncCalls(harness.post)).toHaveLength(1);
  });

  it("DIR-03: session directory mismatch => no prompt_async POST", async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "task-mgr-dir-"));
    const dirA = path.join(scratch, "project-a");
    const dirB = path.join(scratch, "project-b");
    await mkdir(dirA);
    await mkdir(dirB);
    harness.state.sessions.set(SESSION, { id: SESSION, directory: dirA });

    await expect(
      manager.submitAsync(submitInput({ directory: dirB })),
    ).rejects.toBeInstanceOf(SessionDirectoryMismatchError);
    expect(promptAsyncCalls(harness.post)).toHaveLength(0);
  });

  it("JOB-09: conflicting selector identifiers are rejected", async () => {
    const submitted = await manager.submitAsync(submitInput());

    await expect(
      manager.check({
        jobId: submitted.jobId,
        sessionId: "ses_some_other_session",
      }),
    ).rejects.toThrow(/JOB-09|mismatch|disagree|conflict/i);
  });
});
