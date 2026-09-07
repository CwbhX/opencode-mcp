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
  parseAllowedModels,
  resolveModelSelection,
} from "./model-selection.js";
import { createAscendingId, createBridgeJobId, isValidMessageId } from "./opencode-id.js";
import {
  assertSessionDirectory,
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
  check(selector: TaskSelector): Promise<TaskResult>;
  getRecord(jobId: string): TaskRecord | undefined;
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

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of ["data", "messages", "permissions", "questions", "items"]) {
    const entry = value[key];
    if (Array.isArray(entry)) return entry;
  }
  return [];
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
  return resolveModelSelection({
    providerID: input.providerID,
    modelID: input.modelID,
    defaults: {
      providerID: process.env.OPENCODE_DEFAULT_PROVIDER,
      modelID: process.env.OPENCODE_DEFAULT_MODEL,
    },
    requireExplicit: process.env.OPENCODE_REQUIRE_EXPLICIT_MODEL === "true",
    allowedModels: parseAllowedModels(process.env.OPENCODE_ALLOWED_MODELS),
  });
}

function shouldReleaseGate(classified: ClassifiedTask, sessionMissing?: boolean): boolean {
  return (
    sessionMissing === true ||
    classified.state === "succeeded" ||
    classified.state === "failed" ||
    classified.state === "aborted"
  );
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
    return `${serverBaseUrl()}\0${directory ?? ""}\0${sessionId}`;
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
  ): void {
    record.observationGap = observations.observationGap;
    rememberAssistants(record, observations);
    record.state = classified.state;
    if (shouldReleaseGate(classified, observations.sessionMissing)) {
      releaseGate(record);
      const runtime = runtimes.get(record.jobId);
      runtime?.unsubscribe?.();
      runtime && (runtime.unsubscribe = undefined);
    }
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
  ): Promise<unknown[]> {
    try {
      return asList(await client.get(pathName, undefined, directory, opts));
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
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
  }): Promise<TaskObservations> {
    const opts = { deadlineAt: params.deadlineAt, signal: params.signal };
    let rawStatus: unknown;
    let messages: unknown[] = [];
    let sessionMissing = false;
    let pendingPermissions: unknown[] = [];
    let pendingQuestions: unknown[] = [];

    if (params.sessionId) {
      try {
        rawStatus = await client.get("/session/status", undefined, params.directory, opts);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        rawStatus = {};
      }

      try {
        const page = await client.get(
          `/session/${params.sessionId}/message`,
          undefined,
          params.directory,
          opts,
        );
        messages = asList(page);
      } catch (error) {
        if (isNotFound(error)) sessionMissing = true;
        else throw error;
      }

      pendingPermissions = await readOptionalList("/permission", params.directory, opts);
      pendingQuestions = await readOptionalList("/question", params.directory, opts);
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
      events: params.events ?? [],
      observationGap: params.observationGap ?? false,
      sessionMissing,
    };
  }

  function observationGapOf(record?: TaskRecord): boolean {
    if (!record) return false;
    const runtime = runtimes.get(record.jobId);
    return record.observationGap || Boolean(runtime?.monitor?.observationGap);
  }

  async function gather(
    resolved: Exclude<ResolvedSelector, { kind: "missing-job" }>,
    opts?: { deadlineAt?: number; signal?: AbortSignal },
  ): Promise<TaskObservations> {
    if (resolved.kind === "record") {
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
      });
    }
    const directory = resolved.directory
      ? validateDirectory(resolved.directory)
      : undefined;
    return observe({
      sessionId: resolved.sessionId,
      requestMessageID: resolved.requestMessageID,
      directory,
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
    const monitor = acquireEventMonitor(client as unknown as EventClient, {
      serverBaseUrl: record.serverBaseUrl,
      directory: record.directory,
    });
    runtime.monitor = monitor;
    runtime.unsubscribe = monitor.on({ sessionId: record.sessionId }, (event) => {
      runtime.events.push(event);
    });
    await monitor.waitUntilReady(input.deadlineAt, input.signal);
    record.observationGap = monitor.observationGap;
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
    const readOpts = { deadlineAt: input.deadlineAt, signal: input.signal };

    if (input.sessionId) {
      try {
        const session = await client.get(
          `/session/${input.sessionId}`,
          undefined,
          directory,
          readOpts,
        );
        record.sessionId = sessionIdOf(session) ?? input.sessionId;
        assertSessionDirectory({
          requestedDirectory: directory,
          sessionDirectory: sessionDirectoryOf(session),
        });
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
        directory,
        deadlineAt: input.deadlineAt,
        signal: input.signal,
        retryClass: "mutation",
      });
      record.submissionState = "accepted";
      record.state = "queued";
      return toResult(record);
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
        const classified = classifyTask(observations);
        if (resolved.kind === "record") {
          applyClassification(resolved.record, observations, classified);
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
        await clock.sleep(Math.min(pollIntervalMs, remaining), opts.signal);
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

  async function check(selector: TaskSelector): Promise<TaskResult> {
    const resolved = resolveSelector(selector);
    if (resolved.kind === "missing-job") return untrackedJob(resolved.jobId);
    const observations = await gather(resolved);
    const classified = classifyTask(
      resolved.kind === "anonymous" && resolved.tracking === "untracked"
        ? { ...observations, requestMessageID: undefined }
        : observations,
    );
    if (resolved.kind === "record") {
      applyClassification(resolved.record, observations, classified);
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

  return { submitAsync, wait, check, getRecord, reset };
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
