import type { TaskResult } from "./bridge-types.js";

const BLOCKED_STATES = new Set(["blocked_permission", "blocked_question"]);

export function taskResultJson(result: TaskResult): Record<string, unknown> {
  return {
    jobId: result.jobId,
    sessionId: result.sessionId ?? null,
    requestMessageID: result.requestMessageID ?? null,
    directory: result.directory ?? null,
    state: result.state,
    submissionState: result.submissionState,
    terminal: result.terminal,
    mayStillBeRunning: result.mayStillBeRunning,
    safeToResubmit: result.safeToResubmit,
    tracking: result.tracking,
    rawSessionState: result.rawSessionState ?? null,
    waitOutcome: result.waitOutcome ?? null,
    requestedModel: result.requestedModel ?? null,
    observedModel: result.observedModel ?? null,
    pendingRequests: result.pendingRequests,
    error: result.error,
    nextAction: result.nextAction,
    content: result.content ?? null,
  };
}

export function formatTaskResult(summary: string, result: TaskResult): string {
  return `${summary}\n\n\`\`\`json\n${JSON.stringify(taskResultJson(result), null, 2)}\n\`\`\``;
}

function isKnownFailure(result: TaskResult): boolean {
  return result.state === "failed" || result.state === "aborted";
}

function isBlocked(result: TaskResult): boolean {
  return (
    result.waitOutcome === "blocked" ||
    BLOCKED_STATES.has(result.state)
  );
}

function isUnsuccessfulTerminal(result: TaskResult): boolean {
  return (
    result.terminal === true &&
    result.state !== "succeeded" &&
    !isBlocked(result)
  );
}

export function fireToolIsError(result: TaskResult): boolean {
  if (isKnownFailure(result) || isUnsuccessfulTerminal(result)) {
    return true;
  }
  if (result.submissionState === "accepted") return false;
  if (
    result.submissionState === "not_sent" ||
    result.submissionState === "rejected" ||
    result.submissionState === "unknown"
  ) {
    return true;
  }
  return result.state === "failed";
}

export function runToolIsError(result: TaskResult): boolean {
  if (isBlocked(result)) return false;
  if (result.waitOutcome === "completed" && result.state === "succeeded") {
    return false;
  }
  if (result.waitOutcome === "timed_out") return true;
  if (isKnownFailure(result) || isUnsuccessfulTerminal(result)) return true;
  if (
    result.submissionState === "not_sent" ||
    result.submissionState === "rejected" ||
    result.submissionState === "unknown"
  ) {
    return true;
  }
  return result.state !== "succeeded";
}

export function waitToolIsError(result: TaskResult): boolean {
  if (isBlocked(result)) return false;
  if (result.waitOutcome === "completed" && result.state === "succeeded") {
    return false;
  }
  if (result.waitOutcome === "timed_out") return true;
  if (isKnownFailure(result) || isUnsuccessfulTerminal(result)) return true;
  if (result.waitOutcome === "observation_failed") return true;
  return result.waitOutcome !== "completed";
}

export function checkToolIsError(result: TaskResult): boolean {
  return isKnownFailure(result);
}
