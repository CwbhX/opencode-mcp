import {
  AmbiguousAcceptanceError,
  SessionBusyError,
  type Clock,
  type ModelSelection,
  type PendingRequestInfo,
  type TaskRecord,
  type TaskResult,
  type TaskObservations,
  type TrackingMode,
  type WaitOutcome,
} from "./bridge-types.js";
import { OpenCodeError } from "./http-transport.js";
import {
  acquireEventMonitor,
  type EventMonitor,
} from "./event-monitor.js";
import {
  buildPromptBody,
  resolveConfiguredModel,
} from "./model-selection.js";
import { createAscendingId, createBridgeJobId, isValidMessageId } from "./opencode-id.js";
import {
  assertSessionDirectory,
  canonicalDirectoryIdentity,
  defaultClock,
  directoriesMatch,
  isUnsupportedLiteralPercentPath,
  remainingBudgetMs,
  validateDirectory,
  validateIntervalMs,
} from "./request-context.js";
import {
  classifyTask,
  correlateAssistants,
  type ClassifiedTask,
} from "./task-status.js";

export interface TaskManagerDeps {
  client: {
    getBaseUrl(): string;
    get<T = unknown>(
      path: string,
      query?: Record<string, string>,
      directory?: string,
      opts?: { deadlineAt?: number; signal?: AbortSignal },
    ): Promise<T>;
    post<T = unknown>(
      path: string,
      body?: unknown,
      opts?: {
        directory?: string;
        deadlineAt?: number;
        signal?: AbortSignal;
        retryClass?: "read" | "mutation";
      },
    ): Promise<T>;
  };
  clock?: Clock;
}

export interface SubmitPromptInput {
  prompt: string;
  sessionId?: string;
  title?: string;
  providerID?: string;
  modelID?: string;
  variant?: string;
  agent?: string;
  system?: string;
  directory?: string;
  deadlineAt: number;
  signal?: AbortSignal;
  /** default: create new session if sessionId omitted */
}

export interface TaskManager {
  submitAsync(input: SubmitPromptInput): Promise<TaskResult>;
  /** Wait until terminal/blocked/timeout/cancel. Does NOT abort server work on timeout/cancel. */
  wait(
    selector: TaskSelector,
    opts: { deadlineAt: number; signal?: AbortSignal; pollIntervalMs?: number },
  ): Promise<TaskResult>;
  check(
    selector: TaskSelector,
    opts?: { deadlineAt?: number; signal?: AbortSignal },
  ): Promise<TaskResult>;
  getRecord(jobId: string): TaskRecord | undefined;
  assertSessionTurnAvailable(sessionId: string, directory?: string): void;
  withSessionTurn<T>(
    params: { sessionId: string; directory?: string },
    fn: () => Promise<T>,
  ): Promise<T>;
  /** Test/reset helper */
  reset(): void;
}

export type TaskSelector =
  | { jobId: string; sessionId?: string; requestMessageID?: string; directory?: string }
  | { sessionId: string; requestMessageID: string; directory?: string }
  | { sessionId: string; directory?: string };

type Client = TaskManagerDeps["client"];
type EventClient = Parameters<typeof acquireEventMonitor>[0];

interface JobRuntime {
  events: unknown[];
  unsubscribe?: () => void;
  monitor?: EventMonitor;
  wakeup?: () => void;
  stickyClassified?: ClassifiedTask;
  stickyObservations?: TaskObservations;
}

type ResolvedSelector =
  | { kind: "missing-job"; jobId: string }
  | { kind: "record"; record: TaskRecord }
  | {
      kind: "anonymous";
      jobId: string;
      sessionId: string;
      requestMessageID?: string;
      directory?: string;
      tracking: TrackingMode;
    };

interface ResultExtras {
  classified?: ClassifiedTask;
  observations?: TaskObservations;
  waitOutcome?: WaitOutcome;
  error?: string | null;
  nextAction?: string;
  tracking?: TrackingMode;
  safeToResubmit?: boolean;
  mayStillBeRunning?: boolean;
  terminal?: boolean | null;
}

function stripBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asListOrFail(
  value: unknown,
  label: string,
): { items: unknown[]; error?: string } {
  if (value === null || value === undefined) return { items: [] };
  if (Array.isArray(value)) return { items: value };
  if (!isRecord(value)) {
    return { items: [], error: `Malformed ${label} payload.` };
  }
  for (const key of ["data", "messages", "permissions", "questions", "items"]) {
    const entry = value[key];
    if (Array.isArray(entry)) return { items: entry };
  }
  if (Object.keys(value).length === 0) return { items: [] };
  return { items: [], error: `Malformed ${label} payload.` };
}

function messageInfo(message: unknown): Record<string, unknown> | null {
  if (!isRecord(message)) return null;
  if (isRecord(message.info)) return message.info;
  return message;
}

function sessionIdOf(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.id === "string" && payload.id) return payload.id;
  if (typeof payload.sessionID === "string" && payload.sessionID) {
    return payload.sessionID;
  }
  if (typeof payload.sessionId === "string" && payload.sessionId) {
    return payload.sessionId;
  }
  if (isRecord(payload.session) && typeof payload.session.id === "string") {
    return payload.session.id;
  }
  return undefined;
}

function sessionDirectoryOf(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  return typeof payload.directory === "string" ? payload.directory : undefined;
}

function findUserMessage(
  messages: unknown[],
  requestMessageID?: string,
): unknown {
  if (!requestMessageID) return undefined;
  for (const message of messages) {
    const info = messageInfo(message);
    if (info?.role === "user" && info.id === requestMessageID) return message;
  }
  return undefined;
}

function extractContent(
  messages: unknown[],
  requestMessageID?: string,
): string | undefined {
  if (!requestMessageID) return undefined;
  const correlated = correlateAssistants({ requestMessageID, messages });
  const latest = correlated[correlated.length - 1];
  if (!latest || !isRecord(latest)) return undefined;
  const parts = Array.isArray(latest.parts) ? latest.parts : [];
  const texts: string[] = [];
  for (const part of parts) {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
      texts.push(part.text);
    }
  }
  return texts.length > 0 ? texts.join("") : undefined;
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

function itemRequestId(item: unknown): string {
  if (!isRecord(item)) return "unknown";
  for (const key of ["id", "requestID", "requestId"] as const) {
    const value = item[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "unknown";
}

function itemSummary(item: unknown, fallback: string): string {
  if (!isRecord(item)) return fallback;
  for (const key of ["summary", "message", "permission", "title"] as const) {
    const value = item[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return fallback;
}

function pendingRequestsFrom(
  observations: TaskObservations | undefined,
): PendingRequestInfo[] {
  if (!observations) return [];
  const sessionId = observations.sessionId;
  const out: PendingRequestInfo[] = [];
  const take = (kind: PendingRequestInfo["kind"], items: unknown[]) => {
    for (const item of items) {
      const owned = itemSessionId(item);
      if (sessionId && owned && owned !== sessionId) continue;
      if (sessionId && !owned) continue;
      out.push({
        kind,
        requestId: itemRequestId(item),
        sessionId: owned ?? sessionId ?? "unknown",
        summary: itemSummary(item, kind),
      });
    }
  };
  take("permission", observations.pendingPermissions);
  take("question", observations.pendingQuestions);
  return out;
}

function isNotFound(error: unknown): boolean {
  return error instanceof OpenCodeError && error.isNotFound;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: string }).name;
  return name === "AbortError";
}

function rejectPercentPath(directory: string): never {
  throw new Error(
    `Unsupported directory: literal percent characters in paths are not supported ("${directory}").`,
  );
}

function resolveModel(input: SubmitPromptInput): ModelSelection | undefined {
  return resolveConfiguredModel({
    providerID: input.providerID,
    modelID: input.modelID,
  });
}

function shouldReleaseGate(classified: ClassifiedTask, sessionMissing?: boolean): boolean {
  if (sessionMissing === true) return true;
  if (
    classified.state === "blocked_permission" ||
    classified.state === "blocked_question"
  ) {
    return false;
  }
  return classified.terminal === true && classified.mayStillBeRunning === false;
}

export function createTaskManager(deps: TaskManagerDeps): TaskManager {
  const client: Client = deps.client;
  const clock = deps.clock ?? defaultClock();
  const records = new Map<string, TaskRecord>();
  const runtimes = new Map<string, JobRuntime>();
  const gates = new Map<string, string>();

  function serverBaseUrl(): string {
    return stripBaseUrl(client.getBaseUrl());
  }

  function gateKey(sessionId: string, directory?: string): string {
    return `${serverBaseUrl()}\0${canonicalDirectoryIdentity(directory)}\0${sessionId}`;
  }

  function heldByOther(sessionId: string, directory?: string, jobId?: string): string | undefined {
    const key = gateKey(sessionId, directory);
    const holder = gates.get(key);
    if (holder && holder !== jobId) return holder;
    return undefined;
  }

  function acquireGate(record: TaskRecord): void {
    if (!record.sessionId) return;
    const key = gateKey(record.sessionId, record.directory);
    const holder = gates.get(key);
    if (holder && holder !== record.jobId) {
      throw new SessionBusyError(
        `SESSION_BUSY: session ${record.sessionId} already has an active submitting, accepted, or unknown turn.`,
        record.sessionId,
      );
    }
    gates.set(key, record.jobId);
  }

  function assertSessionTurnAvailable(sessionId: string, directory?: string): void {
    const holder = heldByOther(sessionId, directory);
    if (holder) {
      throw new SessionBusyError(
        `SESSION_BUSY: session ${sessionId} already has an active tracked turn (${holder}). Mixed sync/async mutations are rejected.`,
        sessionId,
      );
    }
  }

  async function withSessionTurn<T>(
    params: { sessionId: string; directory?: string },
    fn: () => Promise<T>,
  ): Promise<T> {
    assertSessionTurnAvailable(params.sessionId, params.directory);
    const lease: TaskRecord = {
      jobId: `lease_${createBridgeJobId()}`,
      serverBaseUrl: serverBaseUrl(),
      sessionId: params.sessionId,
      createdAt: clock.now(),
      submissionState: "accepted",
      state: "running",
      observedAssistantMessageIDs: [],
      observationGap: false,
    };
    if (params.directory) lease.directory = params.directory;
    acquireGate(lease);
    try {
      return await fn();
    } finally {
      releaseGate(lease);
    }
  }

  function releaseGate(record: TaskRecord): void {
    if (!record.sessionId) return;
    const key = gateKey(record.sessionId, record.directory);
    if (gates.get(key) === record.jobId) {
      gates.delete(key);
    }
  }

  function runtimeOf(jobId: string): JobRuntime {
    const existing = runtimes.get(jobId);
    if (existing) return existing;
    const created: JobRuntime = { events: [] };
    runtimes.set(jobId, created);
    return created;
  }

  function allocateRecord(input: {
    directory?: string;
    model?: ModelSelection;
    variant?: string;
  }): TaskRecord {
    const record: TaskRecord = {
      jobId: createBridgeJobId(),
      serverBaseUrl: serverBaseUrl(),
      createdAt: clock.now(),
      submissionState: "not_sent",
      state: "created",
      observedAssistantMessageIDs: [],
      observationGap: false,
    };
    if (input.directory) record.directory = input.directory;
    if (input.model) record.expectedModel = input.model;
    if (input.variant) record.requestedVariant = input.variant;
    records.set(record.jobId, record);
    runtimeOf(record.jobId);
    return record;
  }

  function rememberAssistants(record: TaskRecord, observations: TaskObservations): void {
    if (!record.requestMessageID) return;
    const correlated = correlateAssistants({
      requestMessageID: record.requestMessageID,
      messages: observations.assistantMessages,
    });
    for (const message of correlated) {
      const info = messageInfo(message);
      const id = typeof info?.id === "string" ? info.id : undefined;
      if (id && !record.observedAssistantMessageIDs.includes(id)) {
        record.observedAssistantMessageIDs.push(id);
      }
    }
  }

  function applyClassification(
    record: TaskRecord,
    observations: TaskObservations,
    classified: ClassifiedTask,
  ): ClassifiedTask {
    record.observationGap = observations.observationGap;
    rememberAssistants(record, observations);
    if (record.submissionState === "unknown" && observations.userMessage) {
      record.submissionState = "accepted";
    }
    const runtime = runtimeOf(record.jobId);
    let next = classified;
    if (
      runtime.stickyClassified?.terminal === true &&
      classified.terminal !== true &&
      (classified.state === "queued" || classified.state === "running")
    ) {
      next = runtime.stickyClassified;
    } else if (classified.terminal === true) {
      runtime.stickyClassified = classified;
      runtime.stickyObservations = observations;
    }
    record.state = next.state;
    if (shouldReleaseGate(next, observations.sessionMissing)) {
      releaseGate(record);
      runtime.unsubscribe?.();
      runtime.unsubscribe = undefined;
    }
    return next;
  }

  function toResult(record: TaskRecord | undefined, extras: ResultExtras = {}): TaskResult {
    const classified = extras.classified;
    const observations = extras.observations;
    const tracking: TrackingMode =
      extras.tracking ??
      classified?.tracking ??
      (record?.requestMessageID ? "correlated" : "untracked");
    const content = observations
      ? extractContent(observations.assistantMessages, observations.requestMessageID)
      : undefined;

    let terminal: boolean | null;
    if (extras.terminal !== undefined) {
      terminal = extras.terminal;
    } else if (classified) {
      terminal = classified.terminal;
    } else if (
      record?.state === "succeeded" ||
      record?.state === "failed" ||
      record?.state === "aborted"
    ) {
      terminal = true;
    } else if (record?.submissionState === "accepted") {
      terminal = false;
    } else {
      terminal = null;
    }

    let mayStillBeRunning: boolean;
    if (extras.mayStillBeRunning !== undefined) {
      mayStillBeRunning = extras.mayStillBeRunning;
    } else if (classified) {
      mayStillBeRunning = classified.mayStillBeRunning;
    } else {
      mayStillBeRunning = terminal !== true;
    }

    let safeToResubmit: boolean;
    if (extras.safeToResubmit !== undefined) {
      safeToResubmit = extras.safeToResubmit;
    } else if (classified) {
      safeToResubmit = classified.safeToResubmit;
    } else if (record?.submissionState === "unknown") {
      safeToResubmit = false;
    } else if (record?.submissionState === "accepted") {
      safeToResubmit = false;
    } else {
      safeToResubmit = false;
    }

    const nextAction =
      extras.nextAction ??
      classified?.nextAction ??
      (record?.submissionState === "unknown"
        ? "Inspect this job or message; do not resend the prompt automatically."
        : record?.submissionState === "accepted"
          ? "Check this job; do not submit it again."
          : "Inspect this job. Do not claim Done.");

    const result: TaskResult = {
      jobId: record?.jobId ?? "untracked",
      state: classified?.state ?? record?.state ?? "indeterminate",
      submissionState: record?.submissionState ?? "not_sent",
      terminal,
      mayStillBeRunning,
      safeToResubmit,
      tracking,
      pendingRequests: pendingRequestsFrom(observations),
      error: extras.error !== undefined ? extras.error : (classified?.error ?? null),
      nextAction,
    };
    if (record?.sessionId) result.sessionId = record.sessionId;
    if (record?.requestMessageID) result.requestMessageID = record.requestMessageID;
    if (record?.directory) result.directory = record.directory;
    if (classified?.rawSessionState) result.rawSessionState = classified.rawSessionState;
    if (extras.waitOutcome) result.waitOutcome = extras.waitOutcome;
    if (record?.expectedModel) result.requestedModel = record.expectedModel;
    result.observedModel = classified?.observedModel ?? null;
    if (content) result.content = content;
    return result;
  }

  function untrackedJob(jobId: string): TaskResult {
    return {
      jobId,
      state: "indeterminate",
      submissionState: "not_sent",
      terminal: null,
      mayStillBeRunning: true,
      safeToResubmit: false,
      tracking: "untracked",
      pendingRequests: [],
      error: "Unknown job; no in-memory record (bridge restart or never submitted).",
      nextAction:
        "Untracked job after restart. Provide sessionId + requestMessageID + directory to recover. Do not claim this particular task succeeded.",
      observedModel: null,
    };
  }

  function assertSelectorAgrees(record: TaskRecord, selector: TaskSelector): void {
    if ("sessionId" in selector && selector.sessionId !== undefined) {
      if (record.sessionId !== selector.sessionId) {
        throw new Error(
          `JOB-09: selector sessionId "${selector.sessionId}" does not match record sessionId "${record.sessionId ?? ""}".`,
        );
      }
    }
    if ("requestMessageID" in selector && selector.requestMessageID !== undefined) {
      if (record.requestMessageID !== selector.requestMessageID) {
        throw new Error(
          "JOB-09: selector requestMessageID does not match the task record.",
        );
      }
    }
    if ("directory" in selector && selector.directory !== undefined) {
      const requested = validateDirectory(selector.directory);
      if (requested && record.directory && !directoriesMatch(requested, record.directory)) {
        throw new Error("JOB-09: selector directory does not match the task record.");
      }
      if (Boolean(requested) !== Boolean(record.directory) || (requested && !record.directory)) {
        throw new Error("JOB-09: selector directory does not match the task record.");
      }
    }
  }

  function resolveSelector(selector: TaskSelector): ResolvedSelector {
    if ("jobId" in selector) {
      const record = records.get(selector.jobId);
      if (!record) return { kind: "missing-job", jobId: selector.jobId };
      assertSelectorAgrees(record, selector);
      return { kind: "record", record };
    }
    if ("requestMessageID" in selector) {
      const found = [...records.values()].find(
        (record) =>
          record.sessionId === selector.sessionId &&
          record.requestMessageID === selector.requestMessageID,
      );
      if (found) {
        assertSelectorAgrees(found, selector);
        return { kind: "record", record: found };
      }
      return {
        kind: "anonymous",
        jobId: "untracked",
        sessionId: selector.sessionId,
        requestMessageID: selector.requestMessageID,
        directory: selector.directory,
        tracking: "recovery",
      };
    }
    return {
      kind: "anonymous",
      jobId: "untracked",
      sessionId: selector.sessionId,
      directory: selector.directory,
      tracking: "untracked",
    };
  }

  async function readOptionalList(
    pathName: string,
    directory: string | undefined,
    opts?: { deadlineAt?: number; signal?: AbortSignal },
    label = "list",
  ): Promise<{ items: unknown[]; error?: string }> {
    try {
      const raw = await client.get(pathName, undefined, directory, opts);
      return asListOrFail(raw, label);
    } catch (error) {
      if (isNotFound(error)) return { items: [] };
      return {
        items: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function observe(params: {
    sessionId?: string;
    requestMessageID?: string;
    directory?: string;
    expectedModel?: ModelSelection;
    events?: unknown[];
    observationGap?: boolean;
    deadlineAt?: number;
    signal?: AbortSignal;
    eventBaselineSeq?: number;
    dedicatedNewSession?: boolean;
  }): Promise<TaskObservations> {
    const opts = { deadlineAt: params.deadlineAt, signal: params.signal };
    let rawStatus: unknown;
    let messages: unknown[] = [];
    let sessionMissing = false;
    let pendingPermissions: unknown[] = [];
    let pendingQuestions: unknown[] = [];
    let permissionsObservationError: string | undefined;
    let questionsObservationError: string | undefined;
    let statusObservationError: string | undefined;

    if (params.sessionId) {
      try {
        rawStatus = await client.get("/session/status", undefined, params.directory, opts);
      } catch (error) {
        if (!isNotFound(error)) {
          statusObservationError =
            error instanceof Error ? error.message : String(error);
        } else {
          rawStatus = {};
        }
      }

      try {
        const page = await client.get(
          `/session/${params.sessionId}/message`,
          undefined,
          params.directory,
          opts,
        );
        const parsed = asListOrFail(page, "messages");
        messages = parsed.items;
        if (parsed.error) {
          statusObservationError = parsed.error;
        }
      } catch (error) {
        if (isNotFound(error)) sessionMissing = true;
        else throw error;
      }

      const permissions = await readOptionalList(
        "/permission",
        params.directory,
        opts,
        "permissions",
      );
      pendingPermissions = permissions.items;
      permissionsObservationError = permissions.error;
      const questions = await readOptionalList(
        "/question",
        params.directory,
        opts,
        "questions",
      );
      pendingQuestions = questions.items;
      questionsObservationError = questions.error;
    }

    return {
      sessionId: params.sessionId,
      requestMessageID: params.requestMessageID,
      directory: params.directory,
      expectedModel: params.expectedModel,
      userMessage: findUserMessage(messages, params.requestMessageID),
      assistantMessages: messages,
      rawStatus,
      pendingPermissions,
      pendingQuestions,
      events: [...(params.events ?? [])],
      observationGap: params.observationGap ?? false,
      sessionMissing,
      eventBaselineSeq: params.eventBaselineSeq,
      dedicatedNewSession: params.dedicatedNewSession,
      permissionsObservationError,
      questionsObservationError,
      statusObservationError,
    };
  }

  function observationGapOf(record?: TaskRecord): boolean {
    if (!record) return false;
    const runtime = runtimes.get(record.jobId);
    const liveGap = Boolean(runtime?.monitor?.observationGap);
    const generation = runtime?.monitor?.gapGeneration ?? 0;
    if (
      record.gapGenerationAtStart !== undefined &&
      generation > record.gapGenerationAtStart
    ) {
      record.observationGap = true;
    }
    return record.observationGap || liveGap;
  }

  async function gather(
    resolved: Exclude<ResolvedSelector, { kind: "missing-job" }>,
    opts?: { deadlineAt?: number; signal?: AbortSignal },
  ): Promise<TaskObservations> {
    if (resolved.kind === "record") {
      if (stripBaseUrl(client.getBaseUrl()) !== resolved.record.serverBaseUrl) {
        throw new Error(
          "JOB server identity changed; this tracked job is not moved to another OpenCode URL. Recover with the session/message/directory tuple if intended.",
        );
      }
      const runtime = runtimes.get(resolved.record.jobId);
      return observe({
        sessionId: resolved.record.sessionId,
        requestMessageID: resolved.record.requestMessageID,
        directory: resolved.record.directory,
        expectedModel: resolved.record.expectedModel,
        events: runtime?.events,
        observationGap: observationGapOf(resolved.record),
        deadlineAt: opts?.deadlineAt,
        signal: opts?.signal,
        eventBaselineSeq: resolved.record.observationBaselineSeq,
        dedicatedNewSession: resolved.record.dedicatedNewSession,
      });
    }
    const directory = resolved.directory
      ? validateDirectory(resolved.directory)
      : undefined;
    let adopted = directory;
    try {
      const session = await client.get(
        `/session/${resolved.sessionId}`,
        undefined,
        directory,
        opts,
      );
      const returnedId = sessionIdOf(session);
      if (!returnedId || returnedId !== resolved.sessionId) {
        throw new Error("Recovery session identity did not match the requested session.");
      }
      const sessionDirectory = sessionDirectoryOf(session);
      if (directory && sessionDirectory) {
        assertSessionDirectory({
          requestedDirectory: directory,
          sessionDirectory,
        });
      } else if (!directory && sessionDirectory) {
        adopted = validateDirectory(sessionDirectory);
      }
    } catch (error) {
      if (isNotFound(error)) {
        return observe({
          sessionId: resolved.sessionId,
          requestMessageID: resolved.requestMessageID,
          directory: adopted,
          deadlineAt: opts?.deadlineAt,
          signal: opts?.signal,
        }).then((observations) => ({ ...observations, sessionMissing: true }));
      }
      throw error;
    }
    return observe({
      sessionId: resolved.sessionId,
      requestMessageID: resolved.requestMessageID,
      directory: adopted,
      deadlineAt: opts?.deadlineAt,
      signal: opts?.signal,
    });
  }

  function resultForResolved(
    resolved: Exclude<ResolvedSelector, { kind: "missing-job" }>,
    extras: ResultExtras = {},
  ): TaskResult {
    if (resolved.kind === "record") {
      return toResult(resolved.record, extras);
    }
    const result = toResult(undefined, {
      ...extras,
      tracking: extras.tracking ?? resolved.tracking,
    });
    result.jobId = resolved.jobId;
    result.sessionId = resolved.sessionId;
    if (resolved.requestMessageID) result.requestMessageID = resolved.requestMessageID;
    if (resolved.directory) result.directory = resolved.directory;
    return result;
  }

  async function subscribeReady(
    record: TaskRecord,
    input: SubmitPromptInput,
  ): Promise<void> {
    const runtime = runtimeOf(record.jobId);
    const monitor = acquireEventMonitor(
      client as unknown as EventClient,
      {
        serverBaseUrl: record.serverBaseUrl,
        directory: record.directory,
      },
      { clock },
    );
    runtime.monitor = monitor;
    runtime.unsubscribe = monitor.on({ sessionId: record.sessionId }, (event) => {
      runtime.events.push(event);
      if (runtime.events.length > 200) {
        runtime.events.splice(0, runtime.events.length - 200);
      }
      runtime.wakeup?.();
    });
    await monitor.waitUntilReady(input.deadlineAt, input.signal);
    record.observationGap = false;
    record.gapGenerationAtStart = monitor.gapGeneration;
    record.observationBaselineSeq = monitor.currentSeq;
  }

  async function submitAsync(input: SubmitPromptInput): Promise<TaskResult> {
    const model = resolveModel(input);
    if (input.directory && isUnsupportedLiteralPercentPath(input.directory)) {
      rejectPercentPath(input.directory);
    }
    const directory = validateDirectory(input.directory);
    if (directory && isUnsupportedLiteralPercentPath(directory)) {
      rejectPercentPath(directory);
    }

    const record = allocateRecord({
      directory,
      model,
      variant: input.variant,
    });
    if (stripBaseUrl(client.getBaseUrl()) !== record.serverBaseUrl) {
      record.state = "failed";
      return toResult(record, {
        error: "Client server URL changed before submission; the job was not sent.",
        nextAction: "Reconcile the OpenCode server identity before retrying. Do not replay this prompt.",
        safeToResubmit: true,
        mayStillBeRunning: false,
        terminal: true,
      });
    }
    const readOpts = { deadlineAt: input.deadlineAt, signal: input.signal };

    if (input.sessionId) {
      try {
        const session = await client.get(
          `/session/${input.sessionId}`,
          undefined,
          directory,
          readOpts,
        );
        const returnedId = sessionIdOf(session);
        if (!returnedId || returnedId !== input.sessionId) {
          record.state = "failed";
          return toResult(record, {
            error: "Session identity check failed: returned id did not match the requested session.",
            nextAction: "Do not treat this as the requested session; inspect the lookup result.",
            safeToResubmit: false,
            mayStillBeRunning: false,
            terminal: true,
          });
        }
        record.sessionId = returnedId;
        const sessionDirectory = sessionDirectoryOf(session);
        if (!sessionDirectory) {
          record.state = "failed";
          return toResult(record, {
            error: "Session directory metadata is missing; identity cannot be verified.",
            nextAction: "Failed identity check; do not monitor a different project by default.",
            safeToResubmit: false,
            mayStillBeRunning: false,
            terminal: true,
          });
        }
        const validatedSessionDir = validateDirectory(sessionDirectory);
        if (directory) {
          assertSessionDirectory({
            requestedDirectory: directory,
            sessionDirectory: validatedSessionDir,
          });
        } else if (validatedSessionDir) {
          record.directory = validatedSessionDir;
        }
      } catch (error) {
        if (isNotFound(error)) {
          record.sessionId = input.sessionId;
          record.state = "failed";
          const classified = classifyTask({
            sessionId: input.sessionId,
            directory,
            expectedModel: model,
            assistantMessages: [],
            pendingPermissions: [],
            pendingQuestions: [],
            events: [],
            observationGap: false,
            sessionMissing: true,
          });
          return toResult(record, { classified });
        }
        throw error;
      }
    } else {
      try {
        const body = input.title !== undefined ? { title: input.title } : {};
        const created = await client.post("/session", body, {
          directory,
          deadlineAt: input.deadlineAt,
          signal: input.signal,
          retryClass: "mutation",
        });
        const sessionId = sessionIdOf(created);
        if (sessionId) record.sessionId = sessionId;
        const createdDirectory = sessionDirectoryOf(created);
        if (createdDirectory) {
          const adopted = validateDirectory(createdDirectory);
          if (adopted) record.directory = adopted;
        }
        record.dedicatedNewSession = true;
      } catch (error) {
        if (error instanceof AmbiguousAcceptanceError) {
          record.submissionState = "unknown";
          record.state = "indeterminate";
          return toResult(record, {
            error: error.message,
            nextAction: error.details.nextAction,
            mayStillBeRunning: true,
            safeToResubmit: false,
          });
        }
        throw error;
      }
    }

    if (!record.sessionId) {
      record.submissionState = "unknown";
      record.state = "indeterminate";
      return toResult(record, {
        error: "Session ID is unknown after creation.",
        nextAction:
          "Session ID unknown; do not create another session or resend automatically.",
        mayStillBeRunning: true,
        safeToResubmit: false,
      });
    }

    acquireGate(record);

    try {
      await subscribeReady(record, input);
    } catch (error) {
      releaseGate(record);
      runtimeOf(record.jobId).unsubscribe?.();
      record.state = "failed";
      return toResult(record, {
        error: error instanceof Error ? error.message : String(error),
        nextAction:
          "Event monitor was not ready; the prompt was not sent. Inspect before retrying.",
        safeToResubmit: true,
        mayStillBeRunning: false,
        terminal: true,
      });
    }

    if (remainingBudgetMs(input.deadlineAt, clock) <= 0) {
      releaseGate(record);
      runtimeOf(record.jobId).unsubscribe?.();
      record.state = "failed";
      return toResult(record, {
        error: "Deadline elapsed before prompt submission.",
        nextAction: "Deadline elapsed before prompt_async; the prompt was not sent.",
        safeToResubmit: true,
        mayStillBeRunning: false,
        terminal: true,
      });
    }

    const requestMessageID = createAscendingId("msg");
    if (!isValidMessageId(requestMessageID)) {
      releaseGate(record);
      throw new Error("Failed to allocate a valid request message ID.");
    }
    record.requestMessageID = requestMessageID;
    record.state = "submitting";

    const body = buildPromptBody({
      prompt: input.prompt,
      model,
      variant: input.variant,
      agent: input.agent,
      system: input.system,
      messageID: requestMessageID,
    });

    try {
      await client.post(`/session/${record.sessionId}/prompt_async`, body, {
        directory: record.directory,
        deadlineAt: input.deadlineAt,
        signal: input.signal,
        retryClass: "mutation",
      });
      record.submissionState = "accepted";
      const runtime = runtimeOf(record.jobId);
      const observations = await observe({
        sessionId: record.sessionId,
        requestMessageID: record.requestMessageID,
        directory: record.directory,
        expectedModel: model,
        events: [...runtime.events],
        observationGap: observationGapOf(record),
        deadlineAt: input.deadlineAt,
        signal: input.signal,
        eventBaselineSeq: record.observationBaselineSeq,
        dedicatedNewSession: record.dedicatedNewSession,
      });
      const classified = applyClassification(
        record,
        observations,
        classifyTask(observations),
      );
      return toResult(record, { classified, observations });
    } catch (error) {
      if (error instanceof AmbiguousAcceptanceError) {
        record.submissionState = "unknown";
        record.state = "indeterminate";
        return toResult(record, {
          error: error.message,
          nextAction: error.details.nextAction,
          mayStillBeRunning: true,
          safeToResubmit: false,
        });
      }
      if (error instanceof OpenCodeError && error.status >= 400 && error.status < 500) {
        record.submissionState = "rejected";
        record.state = "failed";
        releaseGate(record);
        runtimeOf(record.jobId).unsubscribe?.();
        return toResult(record, {
          error: error.message,
          nextAction:
            error.status === 409
              ? "Session was busy; do not resubmit this turn automatically."
              : error.status === 400
                ? "Validation rejected the prompt; you may correct inputs and resubmit."
                : "Prompt was rejected; inspect the error before retrying.",
          safeToResubmit: error.status === 400,
          mayStillBeRunning: false,
          terminal: true,
        });
      }
      record.submissionState = "unknown";
      record.state = "indeterminate";
      return toResult(record, {
        error: error instanceof Error ? error.message : String(error),
        nextAction: "Inspect this job or message; do not resend the prompt automatically.",
        mayStillBeRunning: true,
        safeToResubmit: false,
      });
    }
  }

  async function wait(
    selector: TaskSelector,
    opts: { deadlineAt: number; signal?: AbortSignal; pollIntervalMs?: number },
  ): Promise<TaskResult> {
    const pollIntervalMs = validateIntervalMs(opts.pollIntervalMs, 250, 60_000);
    const resolved = resolveSelector(selector);
    if (resolved.kind === "missing-job") return untrackedJob(resolved.jobId);

    let last: { observations: TaskObservations; classified: ClassifiedTask } | undefined;

    while (true) {
      if (opts.signal?.aborted) {
        return resultForResolved(resolved, {
          ...waitSnapshot(resolved, last),
          waitOutcome: "cancelled",
          mayStillBeRunning: true,
          terminal: last?.classified.terminal ?? false,
        });
      }
      if (clock.monotonic() >= opts.deadlineAt) {
        return resultForResolved(resolved, {
          ...waitSnapshot(resolved, last),
          waitOutcome: "timed_out",
          mayStillBeRunning: true,
          terminal: last?.classified.terminal ?? false,
        });
      }

      try {
        const observations = await gather(resolved, {
          deadlineAt: opts.deadlineAt,
          signal: opts.signal,
        });
        let classified = classifyTask(observations);
        if (resolved.kind === "record") {
          classified = applyClassification(resolved.record, observations, classified);
        }
        last = { observations, classified };

        if (
          classified.state === "blocked_permission" ||
          classified.state === "blocked_question"
        ) {
          return resultForResolved(resolved, {
            classified,
            observations,
            waitOutcome: "blocked",
          });
        }
        if (classified.terminal === true) {
          return resultForResolved(resolved, {
            classified,
            observations,
            waitOutcome: "completed",
          });
        }
      } catch (error) {
        if (isAbortError(error) || opts.signal?.aborted) {
          return resultForResolved(resolved, {
            ...waitSnapshot(resolved, last),
            waitOutcome: "cancelled",
            mayStillBeRunning: true,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return resultForResolved(resolved, {
          ...waitSnapshot(resolved, last),
          waitOutcome: "observation_failed",
          error: error instanceof Error ? error.message : String(error),
          mayStillBeRunning: true,
        });
      }

      if (clock.monotonic() >= opts.deadlineAt) {
        return resultForResolved(resolved, {
          ...waitSnapshot(resolved, last),
          waitOutcome: "timed_out",
          mayStillBeRunning: true,
          terminal: last?.classified.terminal ?? false,
        });
      }

      const remaining = remainingBudgetMs(opts.deadlineAt, clock);
      if (remaining <= 0) {
        return resultForResolved(resolved, {
          ...waitSnapshot(resolved, last),
          waitOutcome: "timed_out",
          mayStillBeRunning: true,
          terminal: last?.classified.terminal ?? false,
        });
      }

      try {
        const remainingSleep = Math.min(pollIntervalMs, remaining);
        if (resolved.kind === "record") {
          const runtime = runtimeOf(resolved.record.jobId);
          await new Promise<void>((resolveWait, rejectWait) => {
            let settled = false;
            const finish = (fn: () => void) => {
              if (settled) return;
              settled = true;
              if (runtime.wakeup === onWake) runtime.wakeup = undefined;
              fn();
            };
            const onWake = () => finish(resolveWait);
            runtime.wakeup = onWake;
            clock.sleep(remainingSleep, opts.signal).then(
              () => finish(resolveWait),
              (error) => finish(() => rejectWait(error)),
            );
          });
        } else {
          await clock.sleep(remainingSleep, opts.signal);
        }
      } catch (error) {
        if (isAbortError(error) || opts.signal?.aborted) {
          return resultForResolved(resolved, {
            ...waitSnapshot(resolved, last),
            waitOutcome: "cancelled",
            mayStillBeRunning: true,
          });
        }
        throw error;
      }
    }
  }

  function waitSnapshot(
    resolved: Exclude<ResolvedSelector, { kind: "missing-job" }>,
    last?: { observations: TaskObservations; classified: ClassifiedTask },
  ): ResultExtras {
    if (!last) {
      return resolved.kind === "record" ? {} : { tracking: resolved.tracking };
    }
    return {
      classified: last.classified,
      observations: last.observations,
      tracking: resolved.kind === "anonymous" ? resolved.tracking : last.classified.tracking,
    };
  }

  async function check(
    selector: TaskSelector,
    opts?: { deadlineAt?: number; signal?: AbortSignal },
  ): Promise<TaskResult> {
    const resolved = resolveSelector(selector);
    if (resolved.kind === "missing-job") return untrackedJob(resolved.jobId);
    const deadlineAt = opts?.deadlineAt ?? clock.monotonic() + 15_000;
    const observations = await gather(resolved, {
      deadlineAt,
      signal: opts?.signal,
    });
    let classified = classifyTask(
      resolved.kind === "anonymous" && resolved.tracking === "untracked"
        ? { ...observations, requestMessageID: undefined }
        : observations,
    );
    if (resolved.kind === "record") {
      classified = applyClassification(resolved.record, observations, classified);
    }
    return resultForResolved(resolved, { classified, observations });
  }

  function getRecord(jobId: string): TaskRecord | undefined {
    return records.get(jobId);
  }

  function reset(): void {
    for (const runtime of runtimes.values()) {
      runtime.unsubscribe?.();
    }
    records.clear();
    runtimes.clear();
    gates.clear();
  }

  return {
    submitAsync,
    wait,
    check,
    getRecord,
    assertSessionTurnAvailable,
    withSessionTurn,
    reset,
  };
}

const sharedManagers = new WeakMap<object, TaskManager>();

/** One in-process manager per client so fire/run/message share the session gate. */
export function getSharedTaskManager(client: TaskManagerDeps["client"]): TaskManager {
  const existing = sharedManagers.get(client);
  if (existing) return existing;
  const created = createTaskManager({ client });
  sharedManagers.set(client, created);
  return created;
}
