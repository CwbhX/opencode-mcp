/**
 * Shared assertions for the opt-in live MCP smoke (Layer D).
 * These are fake-data checks of the harness, not a live model pass.
 */

export const LIVE_REQUIRED_FIELDS = [
  "jobId",
  "sessionId",
  "requestMessageID",
  "directory",
  "state",
  "submissionState",
  "terminal",
  "mayStillBeRunning",
  "safeToResubmit",
  "requestedModel",
  "observedModel",
  "error",
  "content",
];

/**
 * @param {object} input
 * @param {string} input.requestedProvider
 * @param {string} input.requestedModel
 * @param {string} input.nonce
 * @param {boolean} [input.mcpInitialized]
 * @param {boolean} [input.toolsListed]
 * @param {number} [input.promptAsyncCount]
 * @param {object|null} input.result  parsed TaskResult JSON from MCP
 * @param {boolean} [input.isError]
 * @param {string} [input.text]
 */
export function evaluateLiveTaskResult(input) {
  const failures = [];
  const result = input.result;

  if (input.mcpInitialized !== true) {
    failures.push("MCP was not initialized");
  }
  if (input.toolsListed !== true) {
    failures.push("Intended tools were not listed");
  }
  if ((input.promptAsyncCount ?? 0) !== 1) {
    failures.push(
      `Expected exactly one prompt submission, got ${input.promptAsyncCount ?? 0}`,
    );
  }
  if (!result || typeof result !== "object") {
    failures.push("MCP result JSON is missing");
    return { ok: false, failures };
  }

  for (const field of LIVE_REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(result, field)) {
      failures.push(`Missing result field: ${field}`);
    }
  }

  if (result.state !== "succeeded") {
    failures.push(`state is ${String(result.state)}, not succeeded`);
  }
  if (result.terminal !== true) {
    failures.push("terminal is not true");
  }
  if (result.mayStillBeRunning === true) {
    failures.push("task may still be running");
  }
  if (result.error) {
    failures.push(`typed task error: ${String(result.error)}`);
  }
  if (result.waitOutcome === "timed_out" || result.waitOutcome === "observation_failed") {
    failures.push(`wait ended with ${String(result.waitOutcome)}`);
  }
  if (Array.isArray(result.pendingRequests) && result.pendingRequests.length > 0) {
    failures.push("unresolved permission or question block");
  }
  if (input.isError === true) {
    failures.push("MCP tool result was flagged isError");
  }

  const requested = result.requestedModel;
  const observed = result.observedModel;
  const expectedProvider = input.requestedProvider;
  const expectedModel = input.requestedModel;
  if (
    !requested ||
    requested.providerID !== expectedProvider ||
    requested.modelID !== expectedModel
  ) {
    failures.push("requestedModel does not match the configured pair");
  }
  if (
    !observed ||
    observed.providerID !== expectedProvider ||
    observed.modelID !== expectedModel
  ) {
    failures.push("observedModel does not match the configured pair");
  }

  const content = `${result.content ?? ""}\n${input.text ?? ""}`;
  if (!input.nonce || !content.includes(input.nonce)) {
    failures.push("answer does not contain the expected nonce");
  }

  return { ok: failures.length === 0, failures };
}

export function parseTaskJsonBlock(text) {
  if (typeof text !== "string") return null;
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}
