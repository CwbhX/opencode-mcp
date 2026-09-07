/**
 * Shared contracts for the OpenCode MCP bridge repair.
 *
 * These types are the integration seam. Implementers must not invent
 * competing names for the same concept. See
 * `dev/opencode-mcp-agent-patch-plan.md`.
 */

export type ModelSelection = Readonly<{
  providerID: string;
  modelID: string;
}>;

export type SubmissionState = "not_sent" | "accepted" | "rejected" | "unknown";

export type TaskState =
  | "created"
  | "submitting"
  | "queued"
  | "running"
  | "retrying"
  | "blocked_permission"
  | "blocked_question"
  | "succeeded"
  | "failed"
  | "aborted"
  | "indeterminate";

export type WaitOutcome =
  | "completed"
  | "blocked"
  | "timed_out"
  | "cancelled"
  | "observation_failed";

export type TrackingMode = "correlated" | "untracked" | "recovery";

export type RetryClass = "read" | "mutation";

export type RawSessionState = "idle" | "busy" | "retry" | "absent" | "unknown";

export interface TaskRecord {
  jobId: string;
  serverBaseUrl: string;
  directory?: string;
  sessionId?: string;
  requestMessageID?: string;
  expectedModel?: ModelSelection;
  requestedVariant?: string;
  createdAt: number;
  submissionState: SubmissionState;
  state: TaskState;
  observedAssistantMessageIDs: string[];
  observationGap: boolean;
}

export interface PendingRequestInfo {
  kind: "permission" | "question";
  requestId: string;
  sessionId: string;
  summary: string;
}

export interface TaskResult {
  jobId: string;
  sessionId?: string;
  requestMessageID?: string;
  directory?: string;
  state: TaskState;
  submissionState: SubmissionState;
  rawSessionState?: RawSessionState | string;
  waitOutcome?: WaitOutcome;
  terminal: boolean | null;
  mayStillBeRunning: boolean;
  safeToResubmit: boolean;
  tracking: TrackingMode;
  requestedModel?: ModelSelection;
  observedModel?: ModelSelection | null;
  pendingRequests: PendingRequestInfo[];
  error: string | null;
  nextAction: string;
  content?: string;
}

export interface RequestOptions {
  query?: Record<string, string>;
  body?: unknown;
  directory?: string;
  timeout?: number;
  deadlineAt?: number;
  signal?: AbortSignal;
  retryClass?: RetryClass;
}

export type HealthClassification =
  | "healthy"
  | "authentication_failed"
  | "connection_refused"
  | "probe_timed_out"
  | "incompatible_response"
  | "reachable_but_unhealthy";

export class IncompleteModelSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompleteModelSelectionError";
  }
}

export class SessionDirectoryMismatchError extends Error {
  constructor(
    message: string,
    public readonly requestedDirectory: string,
    public readonly sessionDirectory: string,
  ) {
    super(message);
    this.name = "SessionDirectoryMismatchError";
  }
}

export class SessionBusyError extends Error {
  constructor(message: string, public readonly sessionId: string) {
    super(message);
    this.name = "SessionBusyError";
  }
}

export class UnsupportedParameterError extends Error {
  constructor(
    message: string,
    public readonly parameter: string,
    public readonly operation: string,
  ) {
    super(message);
    this.name = "UnsupportedParameterError";
  }
}

export class AmbiguousAcceptanceError extends Error {
  constructor(
    message: string,
    public readonly details: {
      operation: string;
      submissionState: "unknown";
      jobId?: string;
      sessionId?: string;
      requestMessageID?: string;
      mayStillBeRunning: true;
      safeToResubmit: false;
      nextAction: string;
    },
  ) {
    super(message);
    this.name = "AmbiguousAcceptanceError";
  }
}

export interface TaskObservations {
  sessionId?: string;
  requestMessageID?: string;
  directory?: string;
  expectedModel?: ModelSelection;
  userMessage?: unknown;
  assistantMessages: unknown[];
  rawStatus?: unknown;
  pendingPermissions: unknown[];
  pendingQuestions: unknown[];
  events: unknown[];
  observationGap: boolean;
  sessionMissing?: boolean;
  noReply?: boolean;
}

export interface Clock {
  now(): number;
  monotonic(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
