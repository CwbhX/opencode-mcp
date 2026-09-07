import type { TaskResult } from "./bridge-types.js";

export function taskResultJson(result: TaskResult): Record<string, unknown> {
  const json: Record<string, unknown> = {
    jobId: result.jobId,
    sessionId: result.sessionId ?? null,
    requestMessageID: result.requestMessageID ?? null,
    directory: result.directory ?? null,
    state: result.state,
    submissionState: result.submissionState,
    mayStillBeRunning: result.mayStillBeRunning,
    safeToResubmit: result.safeToResubmit,
    nextAction: result.nextAction,
    tracking: result.tracking,
    error: result.error,
  };
  if (result.waitOutcome) json.waitOutcome = result.waitOutcome;
  if (result.rawSessionState) json.rawSessionState = result.rawSessionState;
  if (result.pendingRequests.length > 0) {
    json.pendingRequests = result.pendingRequests;
  }
  return json;
}

export function formatTaskResult(summary: string, result: TaskResult): string {
  return `${summary}\n\n\`\`\`json\n${JSON.stringify(taskResultJson(result), null, 2)}\n\`\`\``;
}

export function fireToolIsError(result: TaskResult): boolean {
  if (result.submissionState === "accepted") return false;
  if (
    result.submissionState === "not_sent" ||
    result.submissionState === "rejected"
  ) {
    return true;
  }
  if (result.state === "failed") return true;
  return result.submissionState === "unknown";
}

export function runToolIsError(result: TaskResult): boolean {
  if (
    result.waitOutcome === "blocked" ||
    result.state === "blocked_permission" ||
    result.state === "blocked_question"
  ) {
    return false;
  }
  if (result.waitOutcome === "completed" && result.state === "succeeded") {
    return false;
  }
  if (result.waitOutcome === "timed_out") return true;
  if (result.state === "failed" || result.state === "aborted") return true;
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
  if (
    result.waitOutcome === "blocked" ||
    result.state === "blocked_permission" ||
    result.state === "blocked_question"
  ) {
    return false;
  }
  if (result.waitOutcome === "completed" && result.state === "succeeded") {
    return false;
  }
  if (result.waitOutcome === "timed_out") return true;
  if (result.state === "failed" || result.state === "aborted") return true;
  if (result.waitOutcome === "observation_failed") return true;
  return result.waitOutcome !== "completed";
}

export function checkToolIsError(result: TaskResult): boolean {
  return result.state === "failed" || result.state === "aborted";
}
