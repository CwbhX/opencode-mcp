import { describe, expect, it } from "vitest";
import type { TaskResult } from "../src/bridge-types.js";
import {
  checkToolIsError,
  fireToolIsError,
  formatTaskResult,
  runToolIsError,
  taskResultJson,
  waitToolIsError,
} from "../src/task-result-format.js";

function result(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    jobId: "job_test",
    sessionId: "ses_test",
    requestMessageID: "msg_test",
    state: "queued",
    submissionState: "accepted",
    terminal: false,
    mayStillBeRunning: true,
    safeToResubmit: false,
    tracking: "correlated",
    pendingRequests: [],
    error: null,
    nextAction: "Check this job; do not submit it again.",
    ...overrides,
  };
}

describe("taskResultJson", () => {
  it("includes the machine TaskResult fields callers need to resume a job", () => {
    const json = taskResultJson(
      result({
        directory: "/tmp",
        waitOutcome: "timed_out",
        rawSessionState: "busy",
      }),
    );

    expect(json).toMatchObject({
      jobId: "job_test",
      sessionId: "ses_test",
      requestMessageID: "msg_test",
      directory: "/tmp",
      state: "queued",
      submissionState: "accepted",
      mayStillBeRunning: true,
      safeToResubmit: false,
      nextAction: "Check this job; do not submit it again.",
    });
    expect(json.waitOutcome).toBe("timed_out");
    expect(json.rawSessionState).toBe("busy");
    expect(json).toHaveProperty("terminal");
    expect(json).toHaveProperty("requestedModel");
    expect(json).toHaveProperty("observedModel");
    expect(json).toHaveProperty("content");
  });
});

describe("formatTaskResult", () => {
  it("keeps the human summary and appends a fenced JSON block", () => {
    const text = formatTaskResult("Task dispatched to session: ses_test", result());

    expect(text).toContain("Task dispatched to session: ses_test");
    expect(text).toContain("```json");
    expect(text).toContain('"jobId": "job_test"');
    expect(text).toContain('"safeToResubmit": false');
  });
});

describe("tool isError policy", () => {
  it("fire: accepted + running is not an error", () => {
    expect(
      fireToolIsError(result({ submissionState: "accepted", state: "queued" })),
    ).toBe(false);
  });

  it("fire: accepted + failed is an error", () => {
    expect(
      fireToolIsError(
        result({
          submissionState: "accepted",
          state: "failed",
          terminal: true,
          mayStillBeRunning: false,
          error: "ProviderAuthError",
        }),
      ),
    ).toBe(true);
  });

  it("fire: not_sent / rejected / missing session are errors", () => {
    expect(fireToolIsError(result({ submissionState: "not_sent", state: "failed" }))).toBe(
      true,
    );
    expect(fireToolIsError(result({ submissionState: "rejected", state: "failed" }))).toBe(
      true,
    );
    expect(fireToolIsError(result({ submissionState: "not_sent", state: "failed" }))).toBe(
      true,
    );
  });

  it("fire: unknown acceptance is an error and stays not-safe-to-resubmit", () => {
    const unknown = result({
      submissionState: "unknown",
      state: "indeterminate",
      safeToResubmit: false,
      mayStillBeRunning: true,
    });
    expect(fireToolIsError(unknown)).toBe(true);
    expect(unknown.safeToResubmit).toBe(false);
  });

  it("run/wait: blocked permission or question is not an error", () => {
    const blocked = result({
      state: "blocked_permission",
      waitOutcome: "blocked",
      terminal: false,
    });
    expect(runToolIsError(blocked)).toBe(false);
    expect(waitToolIsError(blocked)).toBe(false);
  });

  it("run/wait: timed_out is an error so the parent checks instead of resubmitting", () => {
    const timedOut = result({
      waitOutcome: "timed_out",
      mayStillBeRunning: true,
      nextAction: "Check this job; do not submit it again.",
    });
    expect(runToolIsError(timedOut)).toBe(true);
    expect(waitToolIsError(timedOut)).toBe(true);
  });

  it("run/wait: truncated terminal completion is an error", () => {
    const truncated = result({
      state: "indeterminate",
      waitOutcome: "completed",
      terminal: true,
      mayStillBeRunning: false,
      error: "Assistant finish is length (truncated).",
    });
    expect(runToolIsError(truncated)).toBe(true);
    expect(waitToolIsError(truncated)).toBe(true);
  });

  it("run: succeeded is not an error", () => {
    expect(
      runToolIsError(
        result({
          state: "succeeded",
          waitOutcome: "completed",
          terminal: true,
          mayStillBeRunning: false,
        }),
      ),
    ).toBe(false);
  });

  it("check: untracked idle is not an error", () => {
    expect(
      checkToolIsError(
        result({
          jobId: "untracked",
          state: "indeterminate",
          submissionState: "not_sent",
          tracking: "untracked",
          terminal: null,
        }),
      ),
    ).toBe(false);
  });
});
