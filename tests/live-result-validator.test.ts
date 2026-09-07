import { describe, expect, it } from "vitest";
import {
  evaluateLiveTaskResult,
  parseTaskJsonBlock,
} from "../scripts/live-result-validator.mjs";

const PAIR = {
  requestedProvider: "opencode",
  requestedModel: "muse-spark-1.3-contributor-free",
  nonce: "nonce-abc-123",
  mcpInitialized: true,
  toolsListed: true,
  promptAsyncCount: 1,
};

function successResult(overrides = {}) {
  return {
    jobId: "job_1",
    sessionId: "ses_1",
    requestMessageID: "msg_1",
    directory: "/tmp/scratch",
    state: "succeeded",
    submissionState: "accepted",
    terminal: true,
    mayStillBeRunning: false,
    safeToResubmit: false,
    requestedModel: {
      providerID: PAIR.requestedProvider,
      modelID: PAIR.requestedModel,
    },
    observedModel: {
      providerID: PAIR.requestedProvider,
      modelID: PAIR.requestedModel,
    },
    error: null,
    content: `ok ${PAIR.nonce}`,
    waitOutcome: "completed",
    pendingRequests: [],
    ...overrides,
  };
}

describe("FUP-059 live result validator", () => {
  it("passes a matching terminal control", () => {
    const evaluated = evaluateLiveTaskResult({
      ...PAIR,
      result: successResult(),
      text: `ok ${PAIR.nonce}`,
    });
    expect(evaluated.ok).toBe(true);
    expect(evaluated.failures).toEqual([]);
  });

  it("fails a wrong observed model", () => {
    const evaluated = evaluateLiveTaskResult({
      ...PAIR,
      result: successResult({
        observedModel: { providerID: "openai", modelID: "gpt-4o" },
      }),
    });
    expect(evaluated.ok).toBe(false);
    expect(evaluated.failures.join(" ")).toMatch(/observedModel/);
  });

  it("fails a typed assistant error", () => {
    const evaluated = evaluateLiveTaskResult({
      ...PAIR,
      isError: true,
      result: successResult({
        state: "failed",
        terminal: true,
        error: "ProviderAuthError: not authorized. Origin: assistant.",
        content: "partial",
      }),
    });
    expect(evaluated.ok).toBe(false);
    expect(evaluated.failures.join(" ")).toMatch(/typed task error|isError|succeeded/i);
  });

  it("fails an unfinished assistant", () => {
    const evaluated = evaluateLiveTaskResult({
      ...PAIR,
      result: successResult({
        state: "queued",
        terminal: false,
        mayStillBeRunning: true,
        waitOutcome: "timed_out",
        content: "",
      }),
    });
    expect(evaluated.ok).toBe(false);
    expect(evaluated.failures.join(" ")).toMatch(/timed_out|still be running|succeeded/i);
  });

  it("fails HTML and empty-body stand-ins (no TaskResult JSON)", () => {
    expect(parseTaskJsonBlock("<html>ok</html>")).toBeNull();
    expect(parseTaskJsonBlock("")).toBeNull();
    const html = evaluateLiveTaskResult({ ...PAIR, result: null, text: "<html>ok</html>" });
    const empty = evaluateLiveTaskResult({ ...PAIR, result: null, text: "" });
    expect(html.ok).toBe(false);
    expect(empty.ok).toBe(false);
  });
});
