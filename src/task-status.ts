import type {
  ModelSelection,
  RawSessionState,
  TaskObservations,
  TaskState,
  TrackingMode,
} from "./bridge-types.js";
import {
  formatNormalizedError,
  normalizeNamedError,
} from "./typed-outcome.js";

const KNOWN_RAW: ReadonlySet<string> = new Set(["idle", "busy", "retry"]);
const FINAL_TURN_FINISH: ReadonlySet<string> = new Set(["stop", "end_turn"]);
const CONTINUE_FINISH: ReadonlySet<string> = new Set(["tool-calls", "tool_calls"]);
const FILTER_FINISH: ReadonlySet<string> = new Set([
  "content-filter",
  "content_filter",
  "filter",
]);

export interface ClassifiedTask {
  state: TaskState;
  rawSessionState: RawSessionState;
  terminal: boolean | null;
  mayStillBeRunning: boolean;
  safeToResubmit: boolean;
  tracking: TrackingMode;
  observedModel: { providerID: string; modelID: string } | null;
  error: string | null;
  nextAction: string;
}

type FinishKind =
  | "final"
  | "continue"
  | "filter"
  | "truncated"
  | "unknown"
  | "missing";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function messageInfo(message: unknown): Record<string, unknown> | null {
  if (!isRecord(message)) return null;
  if (isRecord(message.info)) return message.info;
  return message;
}

function asKnownRaw(value: string): RawSessionState {
  return KNOWN_RAW.has(value) ? (value as RawSessionState) : "unknown";
}

/**
 * Normalize GET /session/status payloads.
 *
 * The v1.18 server map uses idle | busy | retry and *removes* idle entries.
 * Absence is therefore "absent", not idle and not success.
 */
export function normalizeRawSessionState(
  raw: unknown,
  sessionId?: string,
): RawSessionState {
  if (raw === null || raw === undefined) return "absent";
  if (typeof raw === "string") return asKnownRaw(raw);
  if (!isRecord(raw)) return "unknown";

  for (const key of ["type", "status", "state"] as const) {
    const field = raw[key];
    if (typeof field === "string") return asKnownRaw(field);
  }

  if (sessionId !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(raw, sessionId)) return "absent";
    return normalizeRawSessionState(raw[sessionId]);
  }

  return Object.keys(raw).length === 0 ? "absent" : "unknown";
}

function hasCompletedTime(info: Record<string, unknown>): boolean {
  if (!isRecord(info.time)) return false;
  return info.time.completed != null;
}

function finishOf(info: Record<string, unknown>): string | undefined {
  return typeof info.finish === "string" ? info.finish : undefined;
}

function finishKind(finish: string | undefined): FinishKind {
  if (finish === undefined || finish === "") return "missing";
  if (FINAL_TURN_FINISH.has(finish)) return "final";
  if (CONTINUE_FINISH.has(finish)) return "continue";
  if (finish === "length") return "truncated";
  if (FILTER_FINISH.has(finish)) return "filter";
  return "unknown";
}

/**
 * A completed model step vs a tool-calls continuation.
 *
 * `stop` / `end_turn` / `length` are terminal-ish. `tool-calls` / `tool_calls`
 * are not — the turn continues. An unknown finish with `time.completed` is a
 * completed step here; classifyTask still refuses success for that case.
 */
export function isTerminalAssistant(info: unknown): boolean {
  const obj = messageInfo(info);
  if (!obj || obj.role !== "assistant") return false;
  if (!hasCompletedTime(obj)) return false;
  return finishKind(finishOf(obj)) !== "continue";
}

export function correlateAssistants(params: {
  requestMessageID: string;
  messages: unknown[];
}): unknown[] {
  const matched: unknown[] = [];
  for (const message of params.messages) {
    const info = messageInfo(message);
    if (!info) continue;
    if (info.role !== "assistant") continue;
    if (info.parentID !== params.requestMessageID) continue;
    matched.push(message);
  }
  return matched;
}

function eventRecord(event: unknown): Record<string, unknown> | null {
  if (!isRecord(event)) return null;
  return event;
}

function eventType(event: Record<string, unknown>): string | undefined {
  return typeof event.type === "string" ? event.type : undefined;
}

function eventSeq(event: Record<string, unknown>): number | undefined {
  return typeof event.localSeq === "number" ? event.localSeq : undefined;
}

function eventSessionId(event: Record<string, unknown>): string | undefined {
  if (isRecord(event.properties) && typeof event.properties.sessionID === "string") {
    return event.properties.sessionID;
  }
  if (isRecord(event.properties) && typeof event.properties.sessionId === "string") {
    return event.properties.sessionId;
  }
  return undefined;
}

function eventMessageInfo(event: Record<string, unknown>): Record<string, unknown> | null {
  if (!isRecord(event.properties)) return null;
  if (isRecord(event.properties.info)) return event.properties.info;
  return null;
}

function eventsInWindow(obs: TaskObservations): Record<string, unknown>[] {
  const baseline = obs.eventBaselineSeq ?? -1;
  const out: Record<string, unknown>[] = [];
  for (const event of obs.events) {
    const rec = eventRecord(event);
    if (!rec) continue;
    const seq = eventSeq(rec);
    if (seq !== undefined && seq <= baseline) continue;
    out.push(rec);
  }
  return out;
}

interface EventEvidence {
  attributedError: string | null;
  attributedAbort: boolean;
  uncertainSessionError: string | null;
}

function eventEvidence(obs: TaskObservations): EventEvidence {
  const events = eventsInWindow(obs);
  let attributedError: string | null = null;
  let attributedAbort = false;
  let uncertainSessionError: string | null = null;

  for (const event of events) {
    const type = eventType(event);
    const sessionId = eventSessionId(event);

    if (type === "message.updated") {
      if (obs.sessionId && sessionId && sessionId !== obs.sessionId) continue;
      const info = eventMessageInfo(event);
      if (!info || info.role !== "assistant") continue;
      if (obs.requestMessageID && info.parentID !== obs.requestMessageID) continue;
      const named = normalizeNamedError(info.error, "assistant_message");
      if (named) {
        attributedError = formatNormalizedError(named);
        attributedAbort = named.name === "MessageAbortedError";
      }
      continue;
    }

    if (type === "session.error") {
      const named = normalizeNamedError(
        isRecord(event.properties) ? event.properties.error : undefined,
        "session_event",
      );
      const formatted = named
        ? formatNormalizedError(named)
        : "session.error event without a structured error payload";
      if (!sessionId) {
        uncertainSessionError =
          `Session error without session ID (${formatted}); not attributed to this task.`;
        continue;
      }
      if (obs.sessionId && sessionId !== obs.sessionId) continue;
      if (obs.dedicatedNewSession === true && obs.requestMessageID) {
        attributedError = formatted;
        continue;
      }
      uncertainSessionError =
        `${formatted} A session-only error on a shared session cannot be attributed with certainty.`;
    }
  }

  return { attributedError, attributedAbort, uncertainSessionError };
}

function extractModel(
  info: Record<string, unknown> | null,
): ModelSelection | null {
  if (!info) return null;
  const providerID = info.providerID;
  const modelID = info.modelID;
  if (typeof providerID === "string" && typeof modelID === "string") {
    if (providerID.length > 0 && modelID.length > 0) {
      return { providerID, modelID };
    }
  }
  return null;
}

function modelsMismatch(
  observed: ModelSelection | null,
  expected?: ModelSelection,
): boolean {
  if (!expected || !observed) return false;
  return (
    observed.providerID !== expected.providerID ||
    observed.modelID !== expected.modelID
  );
}

function itemSessionId(item: unknown): string | undefined {
  if (!isRecord(item)) return undefined;
  if (typeof item.sessionID === "string") return item.sessionID;
  if (typeof item.sessionId === "string") return item.sessionId;
  if (isRecord(item.session) && typeof item.session.id === "string") {
    return item.session.id;
  }
  return undefined;
}

function itemRequestId(item: unknown): string | undefined {
  if (!isRecord(item)) return undefined;
  for (const key of ["id", "requestID", "requestId"] as const) {
    const value = item[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function belongingToSession(items: unknown[], sessionId?: string): unknown[] {
  if (!sessionId) return [];
  return items.filter((item) => itemSessionId(item) === sessionId);
}

function lastAssistantInfo(
  messages: unknown[],
): Record<string, unknown> | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messageInfo(messages[i]);
    if (info && info.role === "assistant") return info;
  }
  return null;
}

function trackingOf(obs: TaskObservations): TrackingMode {
  if (!obs.requestMessageID) return "untracked";
  if (obs.observationGap) return "recovery";
  return "correlated";
}

function inProgress(
  state: Extract<TaskState, "queued" | "running" | "retrying">,
  extras: Omit<ClassifiedTask, "state" | "terminal" | "mayStillBeRunning" | "safeToResubmit">,
): ClassifiedTask {
  return {
    ...extras,
    state,
    terminal: false,
    mayStillBeRunning: true,
    safeToResubmit: false,
  };
}

function permissionBlock(
  items: unknown[],
  extras: Pick<ClassifiedTask, "rawSessionState" | "tracking" | "observedModel">,
  sessionId?: string,
): ClassifiedTask {
  const id = itemRequestId(items[0]) ?? "unknown";
  return {
    ...extras,
    state: "blocked_permission",
    terminal: false,
    mayStillBeRunning: true,
    safeToResubmit: false,
    error: null,
    nextAction: `Resolve pending permission ${id} for session ${sessionId ?? "unknown"}; do not auto-approve.`,
  };
}

function questionBlock(
  items: unknown[],
  extras: Pick<ClassifiedTask, "rawSessionState" | "tracking" | "observedModel">,
  sessionId?: string,
): ClassifiedTask {
  const id = itemRequestId(items[0]) ?? "unknown";
  return {
    ...extras,
    state: "blocked_question",
    terminal: false,
    mayStillBeRunning: true,
    safeToResubmit: false,
    error: null,
    nextAction: `Answer pending question ${id} for session ${sessionId ?? "unknown"}.`,
  };
}

function progressFromRaw(
  raw: RawSessionState,
  hasAllocatedRequest: boolean,
  observationGap: boolean,
  extras: Pick<ClassifiedTask, "rawSessionState" | "tracking" | "observedModel">,
): ClassifiedTask {
  if (raw === "busy") {
    return inProgress("running", {
      ...extras,
      error: null,
      nextAction: "Poll session status and messages; the turn is still running.",
    });
  }
  if (raw === "retry") {
    return inProgress("retrying", {
      ...extras,
      error: null,
      nextAction: "Wait for the provider retry to finish.",
    });
  }
  if (raw === "unknown") {
    return {
      ...extras,
      state: "indeterminate",
      terminal: null,
      mayStillBeRunning: true,
      safeToResubmit: false,
      error: "Unknown session status.",
      nextAction: "Unknown session status; do not infer success.",
    };
  }
  if (observationGap) {
    return {
      ...extras,
      state: "indeterminate",
      terminal: null,
      mayStillBeRunning: true,
      safeToResubmit: false,
      error: "Observation gap: insufficient evidence.",
      nextAction:
        "Observation gap: insufficient evidence; do not claim Done or resubmit.",
    };
  }
  if (hasAllocatedRequest) {
    return inProgress("queued", {
      ...extras,
      error: null,
      nextAction:
        "Wait for a correlated terminal assistant for this requestMessageID.",
    });
  }
  return {
    ...extras,
    state: "indeterminate",
    terminal: null,
    mayStillBeRunning: true,
    safeToResubmit: false,
    error: "Insufficient evidence to classify this task.",
    nextAction: "Do not claim Done; gather a correlated terminal assistant.",
  };
}

export function classifyTask(obs: TaskObservations): ClassifiedTask {
  const rawSessionState = normalizeRawSessionState(obs.rawStatus, obs.sessionId);
  const tracking = trackingOf(obs);
  const pendingPermissions = belongingToSession(
    obs.pendingPermissions,
    obs.sessionId,
  );
  const pendingQuestions = belongingToSession(
    obs.pendingQuestions,
    obs.sessionId,
  );
  const correlated = obs.requestMessageID
    ? correlateAssistants({
        requestMessageID: obs.requestMessageID,
        messages: obs.assistantMessages,
      })
    : [];
  const latest = lastAssistantInfo(correlated);
  const observedModel = extractModel(latest);
  const hasUserMessage = obs.userMessage != null;
  const shared = { rawSessionState, tracking, observedModel };
  const evidence = eventEvidence(obs);

  if (obs.sessionMissing) {
    return {
      ...shared,
      state: "failed",
      terminal: true,
      mayStillBeRunning: false,
      safeToResubmit: false,
      error: "Missing session (404 or empty lookup).",
      nextAction:
        "Do not claim Done. The session is missing; treat this as a failed lookup, not a completed task.",
    };
  }

  if (obs.noReply === true) {
    return {
      ...shared,
      state: "indeterminate",
      terminal: true,
      mayStillBeRunning: false,
      safeToResubmit: false,
      error: null,
      nextAction:
        "noReply context injection acknowledged; this is not a generated-task result",
    };
  }

  if (evidence.attributedError) {
    return {
      ...shared,
      state: evidence.attributedAbort ? "aborted" : "failed",
      terminal: true,
      mayStillBeRunning: false,
      safeToResubmit: false,
      error: evidence.attributedError,
      nextAction: evidence.attributedAbort
        ? "The assistant turn was aborted."
        : "Attributed failure evidence arrived via events; do not resubmit automatically.",
    };
  }

  if (!obs.requestMessageID) {
    if (pendingPermissions.length > 0) {
      return permissionBlock(pendingPermissions, shared, obs.sessionId);
    }
    if (pendingQuestions.length > 0) {
      return questionBlock(pendingQuestions, shared, obs.sessionId);
    }
    if (rawSessionState === "busy") {
      return inProgress("running", {
        ...shared,
        error: null,
        nextAction:
          "No requestMessageID; tracking is untracked. Session is busy — do not claim this particular task succeeded.",
      });
    }
    if (rawSessionState === "retry") {
      return inProgress("retrying", {
        ...shared,
        error: null,
        nextAction:
          "No requestMessageID; tracking is untracked. Session is retrying — do not claim this particular task succeeded.",
      });
    }
    return {
      ...shared,
      state: "indeterminate",
      terminal: null,
      mayStillBeRunning: true,
      safeToResubmit: false,
      error: "No requestMessageID; cannot correlate this task.",
      nextAction:
        "No requestMessageID; tracking is untracked. Do not claim this particular task succeeded.",
    };
  }

  if (latest) {
    const named = normalizeNamedError(latest.error, "assistant_message");
    if (named) {
      const formatted = formatNormalizedError(named);
      if (named.name === "MessageAbortedError") {
        return {
          ...shared,
          state: "aborted",
          terminal: true,
          mayStillBeRunning: false,
          safeToResubmit: false,
          error: formatted,
          nextAction: "The assistant turn was aborted (MessageAbortedError).",
        };
      }
      return {
        ...shared,
        state: "failed",
        terminal: true,
        mayStillBeRunning: false,
        safeToResubmit: false,
        error: formatted,
        nextAction: `Assistant ended with ${named.name}; do not treat leftover text as success.`,
      };
    }

    const kind = finishKind(finishOf(latest));
    const completed = hasCompletedTime(latest);

    if (completed && kind === "continue") {
      if (pendingPermissions.length > 0) {
        return permissionBlock(pendingPermissions, shared, obs.sessionId);
      }
      if (pendingQuestions.length > 0) {
        return questionBlock(pendingQuestions, shared, obs.sessionId);
      }
      return progressFromRaw(
        rawSessionState,
        hasUserMessage || Boolean(obs.requestMessageID),
        false,
        shared,
      );
    }

    // JOB-15: content-filter => failed. length (truncated) => indeterminate,
    // not a clean success. Unknown/missing finish => indeterminate even when
    // time.completed is set; isTerminalAssistant may still be true.
    if (completed && kind === "filter") {
      const finish = finishOf(latest) ?? "content-filter";
      return {
        ...shared,
        state: "failed",
        terminal: true,
        mayStillBeRunning: false,
        safeToResubmit: false,
        error: `Assistant finish is ${finish}.`,
        nextAction: `Assistant finish is ${finish}; treat as failed.`,
      };
    }

    if (completed && kind === "truncated") {
      return {
        ...shared,
        state: "indeterminate",
        terminal: true,
        mayStillBeRunning: false,
        safeToResubmit: false,
        error: "Assistant finish is length (truncated).",
        nextAction: "Truncated finish (length); not a clean success.",
      };
    }

    if (completed && (kind === "unknown" || kind === "missing")) {
      return {
        ...shared,
        state: "indeterminate",
        terminal: null,
        mayStillBeRunning: true,
        safeToResubmit: false,
        error: "Unknown finish; not enough evidence for success.",
        nextAction: "Unknown finish; treat as indeterminate, not success.",
      };
    }

    if (completed && kind === "final") {
      if (pendingPermissions.length > 0) {
        return permissionBlock(pendingPermissions, shared, obs.sessionId);
      }
      if (pendingQuestions.length > 0) {
        return questionBlock(pendingQuestions, shared, obs.sessionId);
      }
      if (obs.permissionsObservationError || obs.questionsObservationError) {
        return {
          ...shared,
          state: "indeterminate",
          terminal: true,
          mayStillBeRunning: false,
          safeToResubmit: false,
          error:
            obs.permissionsObservationError ??
            obs.questionsObservationError ??
            "Pending-request observation failed.",
          nextAction:
            "Authoritative pending-request observation failed; do not infer that there are no blocks.",
        };
      }
      if (obs.expectedModel && !observedModel) {
        return {
          ...shared,
          state: "indeterminate",
          terminal: true,
          mayStillBeRunning: false,
          safeToResubmit: false,
          error: `MODEL UNVERIFIED: expected ${obs.expectedModel.providerID}/${obs.expectedModel.modelID}, but the assistant did not include observed providerID/modelID.`,
          nextAction:
            "MODEL UNVERIFIED: missing observed identity is not proof the requested model ran.",
        };
      }
      if (modelsMismatch(observedModel, obs.expectedModel)) {
        return {
          ...shared,
          state: "indeterminate",
          terminal: true,
          mayStillBeRunning: false,
          safeToResubmit: false,
          error: `MODEL MISMATCH: expected ${obs.expectedModel!.providerID}/${obs.expectedModel!.modelID}, observed ${observedModel!.providerID}/${observedModel!.modelID}.`,
          nextAction:
            "MODEL MISMATCH: do not declare this a successful test of the requested model.",
        };
      }
      return {
        ...shared,
        state: "succeeded",
        terminal: true,
        mayStillBeRunning: false,
        safeToResubmit: false,
        error: null,
        nextAction: "Return the correlated terminal assistant result.",
      };
    }
  }

  if (pendingPermissions.length > 0) {
    return permissionBlock(pendingPermissions, shared, obs.sessionId);
  }
  if (pendingQuestions.length > 0) {
    return questionBlock(pendingQuestions, shared, obs.sessionId);
  }

  if (evidence.uncertainSessionError) {
    return {
      ...shared,
      state: "indeterminate",
      terminal: null,
      mayStillBeRunning: true,
      safeToResubmit: false,
      error: evidence.uncertainSessionError,
      nextAction:
        "Session error evidence is available but cannot be attributed with certainty; do not resubmit.",
    };
  }

  if (obs.statusObservationError) {
    return {
      ...shared,
      state: "indeterminate",
      terminal: null,
      mayStillBeRunning: true,
      safeToResubmit: false,
      error: obs.statusObservationError,
      nextAction: "Session status observation failed; do not infer success.",
    };
  }

  return progressFromRaw(
    rawSessionState,
    hasUserMessage || Boolean(obs.requestMessageID),
    obs.observationGap,
    shared,
  );
}
