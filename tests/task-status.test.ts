import { describe, it, expect } from "vitest";
import type { TaskObservations } from "../src/bridge-types.js";
import {
  normalizeRawSessionState,
  isTerminalAssistant,
  correlateAssistants,
  classifyTask,
} from "../src/task-status.js";

// ─── OpenCode v1.18.29-shaped fixtures ───────────────────────────────────

const SESSION = "ses_job";
const REQUEST = "usr_this_turn";
const OLD_REQUEST = "usr_previous_turn";
const MODEL = {
  providerID: "opencode",
  modelID: "muse-spark-1.3-contributor-free",
} as const;

function userMessage(id: string, text = "do the work") {
  return {
    info: {
      id,
      role: "user",
      time: { created: 1_700_000_000_000 },
    },
    parts: [{ type: "text", text }],
  };
}

function assistantMessage(opts: {
  id?: string;
  parentID: string;
  role?: string;
  finish?: string;
  completed?: number | null;
  created?: number;
  error?: { name: string; message?: string };
  providerID?: string;
  modelID?: string;
  parts?: unknown[];
  text?: string;
}) {
  const time: { created: number; completed?: number } = {
    created: opts.created ?? 1_700_000_001_000,
  };
  if (opts.completed !== undefined && opts.completed !== null) {
    time.completed = opts.completed;
  } else if (opts.completed === undefined) {
    time.completed = 1_700_000_002_000;
  }

  const info: Record<string, unknown> = {
    id: opts.id ?? "msg_assistant",
    role: opts.role ?? "assistant",
    parentID: opts.parentID,
    providerID: opts.providerID ?? MODEL.providerID,
    modelID: opts.modelID ?? MODEL.modelID,
    time,
  };
  if (opts.finish !== undefined) info.finish = opts.finish;
  if (opts.error) info.error = opts.error;

  const parts =
    opts.parts ??
    (opts.text !== undefined
      ? opts.text === ""
        ? []
        : [{ type: "text", text: opts.text }]
      : [{ type: "text", text: "done" }]);

  return { info, parts };
}

function obs(partial: Partial<TaskObservations> = {}): TaskObservations {
  return {
    sessionId: SESSION,
    requestMessageID: REQUEST,
    expectedModel: MODEL,
    userMessage: userMessage(REQUEST),
    assistantMessages: [],
    rawStatus: {},
    pendingPermissions: [],
    pendingQuestions: [],
    events: [],
    observationGap: false,
    ...partial,
  };
}

// ─── normalizeRawSessionState ────────────────────────────────────────────

describe("normalizeRawSessionState", () => {
  it("maps null and undefined to absent, never idle", () => {
    expect(normalizeRawSessionState(null)).toBe("absent");
    expect(normalizeRawSessionState(undefined)).toBe("absent");
    expect(normalizeRawSessionState(null)).not.toBe("idle");
  });

  it("accepts idle, busy, and retry strings", () => {
    expect(normalizeRawSessionState("idle")).toBe("idle");
    expect(normalizeRawSessionState("busy")).toBe("busy");
    expect(normalizeRawSessionState("retry")).toBe("retry");
  });

  it("maps unknown future status strings to unknown", () => {
    expect(normalizeRawSessionState("draining")).toBe("unknown");
    expect(normalizeRawSessionState("completed")).toBe("unknown");
  });

  it("reads type, status, or state when the value is idle|busy|retry", () => {
    expect(normalizeRawSessionState({ type: "busy" })).toBe("busy");
    expect(normalizeRawSessionState({ status: "retry" })).toBe("retry");
    expect(normalizeRawSessionState({ state: "idle" })).toBe("idle");
  });

  it("maps a status object with an unknown type/status/state to unknown", () => {
    expect(normalizeRawSessionState({ type: "draining" })).toBe("unknown");
  });

  it("looks up sessionId in a server status map and treats a missing key as absent", () => {
    const map = {
      ses_other: "busy",
      [SESSION]: { type: "retry" },
    };
    expect(normalizeRawSessionState(map, SESSION)).toBe("retry");
    expect(normalizeRawSessionState(map, "ses_missing")).toBe("absent");
    expect(normalizeRawSessionState({}, SESSION)).toBe("absent");
  });

  it("treats a null map entry as absent because the server removes idle rows", () => {
    expect(normalizeRawSessionState({ [SESSION]: null }, SESSION)).toBe("absent");
    expect(normalizeRawSessionState({ [SESSION]: undefined }, SESSION)).toBe(
      "absent",
    );
  });

  it("maps non-object, non-string values to unknown", () => {
    expect(normalizeRawSessionState(42)).toBe("unknown");
    expect(normalizeRawSessionState(true)).toBe("unknown");
  });
});

// ─── isTerminalAssistant ─────────────────────────────────────────────────

describe("isTerminalAssistant", () => {
  it("is true for a completed assistant with a final-turn finish", () => {
    expect(
      isTerminalAssistant(
        assistantMessage({ parentID: REQUEST, finish: "stop" }).info,
      ),
    ).toBe(true);
    expect(
      isTerminalAssistant(
        assistantMessage({ parentID: REQUEST, finish: "end_turn" }).info,
      ),
    ).toBe(true);
    expect(
      isTerminalAssistant(
        assistantMessage({ parentID: REQUEST, finish: "length" }).info,
      ),
    ).toBe(true);
  });

  it("is false when finish is tool-calls or tool_calls even with time.completed", () => {
    expect(
      isTerminalAssistant(
        assistantMessage({ parentID: REQUEST, finish: "tool-calls" }).info,
      ),
    ).toBe(false);
    expect(
      isTerminalAssistant(
        assistantMessage({ parentID: REQUEST, finish: "tool_calls" }).info,
      ),
    ).toBe(false);
  });

  it("is false for non-assistant roles or missing time.completed", () => {
    expect(
      isTerminalAssistant(
        assistantMessage({ parentID: REQUEST, role: "user", finish: "stop" })
          .info,
      ),
    ).toBe(false);
    expect(
      isTerminalAssistant(
        assistantMessage({
          parentID: REQUEST,
          finish: "stop",
          completed: null,
        }).info,
      ),
    ).toBe(false);
  });

  it("treats an unknown finish with time.completed as a completed model step", () => {
    // classifyTask must still refuse success; this helper only answers
    // "completed model step" vs "tool-calls continue".
    expect(
      isTerminalAssistant(
        assistantMessage({ parentID: REQUEST, finish: "mystery_finish" }).info,
      ),
    ).toBe(true);
  });
});

// ─── correlateAssistants ─────────────────────────────────────────────────

describe("correlateAssistants", () => {
  it("returns only assistants whose parentID equals requestMessageID", () => {
    const matchWrapped = assistantMessage({
      id: "msg_match_wrapped",
      parentID: REQUEST,
      finish: "stop",
    });
    const matchRaw = {
      id: "msg_match_raw",
      role: "assistant",
      parentID: REQUEST,
      time: { created: 1, completed: 2 },
      finish: "stop",
    };
    const stale = assistantMessage({
      id: "msg_stale",
      parentID: OLD_REQUEST,
      finish: "stop",
    });
    const user = userMessage(REQUEST);

    const matched = correlateAssistants({
      requestMessageID: REQUEST,
      messages: [stale, user, matchWrapped, matchRaw],
    });

    expect(matched).toEqual([matchWrapped, matchRaw]);
  });

  it("does not pick the last message or sort by id when parentID does not match", () => {
    const lastUnrelated = assistantMessage({
      id: "zzz_lexicographically_last",
      parentID: OLD_REQUEST,
      finish: "stop",
    });
    expect(
      correlateAssistants({
        requestMessageID: REQUEST,
        messages: [lastUnrelated],
      }),
    ).toEqual([]);
  });
});

// ─── classifyTask ────────────────────────────────────────────────────────

describe("classifyTask", () => {
  it("JOB-01: sessionMissing / 404 is failed and never Done", () => {
    const result = classifyTask(
      obs({
        sessionMissing: true,
        rawStatus: {},
        assistantMessages: [],
      }),
    );

    expect(result.state).toBe("failed");
    expect(result.state).not.toBe("succeeded");
    expect(result.error).toMatch(/missing session/i);
    expect(result.nextAction).toMatch(/do not claim Done/i);
    expect(result.rawSessionState).toBe("absent");
    expect(result.terminal).toBe(true);
    expect(result.mayStillBeRunning).toBe(false);
    expect(result.safeToResubmit).toBe(false);
  });

  it("JOB-02: a stale assistant with a different parentID cannot satisfy the new job", () => {
    const stale = assistantMessage({
      id: "msg_old",
      parentID: OLD_REQUEST,
      finish: "stop",
      text: "old answer",
    });
    const result = classifyTask(
      obs({
        rawStatus: {},
        assistantMessages: [stale],
      }),
    );

    expect(result.state).not.toBe("succeeded");
    expect(result.tracking).toBe("correlated");
    expect(result.state).toBe("queued");
    expect(result.terminal).toBe(false);
    expect(result.mayStillBeRunning).toBe(true);
  });

  it("JOB-03: a correlated terminal assistant can succeed without observing busy", () => {
    const terminal = assistantMessage({
      id: "msg_fast",
      parentID: REQUEST,
      finish: "stop",
      text: "here you go",
    });
    const result = classifyTask(
      obs({
        rawStatus: {},
        assistantMessages: [terminal],
      }),
    );

    expect(result.state).toBe("succeeded");
    expect(result.terminal).toBe(true);
    expect(result.mayStillBeRunning).toBe(false);
    expect(result.safeToResubmit).toBe(false);
    expect(result.tracking).toBe("correlated");
    expect(result.rawSessionState).toBe("absent");
    expect(result.observedModel).toEqual(MODEL);
    expect(result.error).toBeNull();
  });

  it("JOB-04: tool-calls finish with time.completed is not a terminal success", () => {
    const intermediate = assistantMessage({
      id: "msg_tools",
      parentID: REQUEST,
      finish: "tool-calls",
      text: "",
      parts: [{ type: "tool", tool: "read", state: "completed" }],
    });
    const result = classifyTask(
      obs({
        rawStatus: { [SESSION]: "busy" },
        assistantMessages: [intermediate],
      }),
    );

    expect(result.state).not.toBe("succeeded");
    expect(result.state).toBe("running");
    expect(result.terminal).toBe(false);
    expect(result.mayStillBeRunning).toBe(true);
  });

  it("JOB-04: tool-calls with absent status stays queued, not succeeded", () => {
    const intermediate = assistantMessage({
      id: "msg_tools",
      parentID: REQUEST,
      finish: "tool_calls",
    });
    const result = classifyTask(
      obs({
        rawStatus: {},
        assistantMessages: [intermediate],
      }),
    );

    expect(result.state).toBe("queued");
    expect(result.state).not.toBe("succeeded");
    expect(result.terminal).toBe(false);
  });

  it("JOB-06: ProviderAuthError with partial text is failed, not success", () => {
    const failed = assistantMessage({
      id: "msg_auth",
      parentID: REQUEST,
      finish: "stop",
      text: "partial answer before auth failed",
      error: { name: "ProviderAuthError", message: "not authorized" },
    });
    const result = classifyTask(
      obs({
        assistantMessages: [failed],
      }),
    );

    expect(result.state).toBe("failed");
    expect(result.state).not.toBe("succeeded");
    expect(result.terminal).toBe(true);
    expect(result.error).toMatch(/ProviderAuthError/);
  });

  it("JOB-06: APIError with nonempty text is failed", () => {
    const failed = assistantMessage({
      id: "msg_api",
      parentID: REQUEST,
      finish: "stop",
      text: "looks like an answer",
      error: { name: "APIError", message: "rate limited" },
    });
    const result = classifyTask(obs({ assistantMessages: [failed] }));

    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/APIError/);
  });

  it("JOB-06: MessageAbortedError is aborted even with partial text", () => {
    const aborted = assistantMessage({
      id: "msg_abort",
      parentID: REQUEST,
      finish: "stop",
      text: "partial",
      error: { name: "MessageAbortedError", message: "aborted" },
    });
    const result = classifyTask(obs({ assistantMessages: [aborted] }));

    expect(result.state).toBe("aborted");
    expect(result.state).not.toBe("succeeded");
    expect(result.terminal).toBe(true);
    expect(result.error).toMatch(/MessageAbortedError/);
  });

  it("JOB-08: unknown future status with no matched result is indeterminate", () => {
    const result = classifyTask(
      obs({
        rawStatus: { [SESSION]: "draining" },
        assistantMessages: [],
      }),
    );

    expect(result.state).toBe("indeterminate");
    expect(result.state).not.toBe("succeeded");
    expect(result.rawSessionState).toBe("unknown");
    expect(result.terminal).toBeNull();
    expect(result.nextAction).toMatch(/do not infer success/i);
  });

  it("JOB-08: no requestMessageID is untracked and cannot claim this task succeeded", () => {
    const leftover = assistantMessage({
      id: "msg_leftover",
      parentID: OLD_REQUEST,
      finish: "stop",
    });
    const result = classifyTask(
      obs({
        requestMessageID: undefined,
        rawStatus: {},
        assistantMessages: [leftover],
      }),
    );

    expect(result.tracking).toBe("untracked");
    expect(result.state).not.toBe("succeeded");
    expect(result.state).toBe("indeterminate");
    expect(result.nextAction).toMatch(/untracked/i);
  });

  it("JOB-12: empty text with tool parts and stop finish can succeed", () => {
    const toolOnly = assistantMessage({
      id: "msg_tools_only",
      parentID: REQUEST,
      finish: "stop",
      text: "",
      parts: [
        { type: "tool", tool: "read", state: "completed", output: "{}" },
      ],
    });
    const result = classifyTask(obs({ assistantMessages: [toolOnly] }));

    expect(result.state).toBe("succeeded");
    expect(result.error).toBeNull();
    expect(result.terminal).toBe(true);
  });

  it("JOB-13: noReply is context injection, not a generated-task result", () => {
    const result = classifyTask(obs({ noReply: true }));

    expect(result.state).not.toBe("succeeded");
    expect(result.state).toBe("indeterminate");
    expect(result.error).toBeNull();
    expect(result.nextAction).toBe(
      "noReply context injection acknowledged; this is not a generated-task result",
    );
    expect(result.mayStillBeRunning).toBe(false);
  });

  it("JOB-15: content-filter finish is failed", () => {
    const filtered = assistantMessage({
      id: "msg_filter",
      parentID: REQUEST,
      finish: "content-filter",
      text: "partial",
    });
    const result = classifyTask(obs({ assistantMessages: [filtered] }));

    expect(result.state).toBe("failed");
    expect(result.terminal).toBe(true);
    expect(result.error).toMatch(/content-filter|filter/i);
  });

  it("JOB-15: unknown finish is indeterminate, not success", () => {
    const mystery = assistantMessage({
      id: "msg_mystery",
      parentID: REQUEST,
      finish: "mystery_finish",
      text: "maybe done",
    });
    const result = classifyTask(obs({ assistantMessages: [mystery] }));

    expect(result.state).toBe("indeterminate");
    expect(result.state).not.toBe("succeeded");
    expect(result.error).toMatch(/unknown finish/i);
  });

  it("JOB-15: length/truncated finish is not a clean success", () => {
    const truncated = assistantMessage({
      id: "msg_len",
      parentID: REQUEST,
      finish: "length",
      text: "cut off mid-sent",
    });
    const result = classifyTask(obs({ assistantMessages: [truncated] }));

    expect(result.state).not.toBe("succeeded");
    expect(["failed", "indeterminate"]).toContain(result.state);
    expect(result.error).toMatch(/length|truncat/i);
  });

  it("BLOCK-01: pending permission for this session blocks and does not auto-approve", () => {
    const result = classifyTask(
      obs({
        rawStatus: { [SESSION]: "busy" },
        pendingPermissions: [
          {
            id: "per_1",
            sessionID: SESSION,
            permission: "edit",
            title: "Edit src/app.ts",
          },
        ],
      }),
    );

    expect(result.state).toBe("blocked_permission");
    expect(result.state).not.toBe("succeeded");
    expect(result.terminal).toBe(false);
    expect(result.mayStillBeRunning).toBe(true);
    expect(result.safeToResubmit).toBe(false);
    expect(result.nextAction).toMatch(/per_1/);
    expect(result.nextAction).toMatch(new RegExp(SESSION));
    expect(result.nextAction).toMatch(/do not auto-approve/i);
  });

  it("BLOCK-03: a pending permission for another session does not block this task", () => {
    const result = classifyTask(
      obs({
        rawStatus: { [SESSION]: "busy" },
        pendingPermissions: [
          { id: "per_other", sessionID: "ses_other", permission: "edit" },
        ],
      }),
    );

    expect(result.state).toBe("running");
    expect(result.state).not.toBe("blocked_permission");
  });

  it("MODEL-08: observed model mismatch is surfaced and not declared successful", () => {
    const mismatched = assistantMessage({
      id: "msg_wrong_model",
      parentID: REQUEST,
      finish: "stop",
      providerID: "anthropic",
      modelID: "claude-opus-4-6",
      text: "answered on the wrong model",
    });
    const result = classifyTask(obs({ assistantMessages: [mismatched] }));

    expect(result.state).not.toBe("succeeded");
    expect(result.state).toBe("indeterminate");
    expect(result.error).toMatch(/MODEL MISMATCH/);
    expect(result.observedModel).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-4-6",
    });
  });

  it("reports running when the user message exists, status is busy, and no terminal assistant is present", () => {
    const result = classifyTask(
      obs({
        rawStatus: { [SESSION]: { state: "busy" } },
        assistantMessages: [],
      }),
    );
    expect(result.state).toBe("running");
    expect(result.rawSessionState).toBe("busy");
    expect(result.terminal).toBe(false);
    expect(result.mayStillBeRunning).toBe(true);
  });

  it("reports retrying when the raw session state is retry", () => {
    const result = classifyTask(
      obs({
        rawStatus: { [SESSION]: "retry" },
        assistantMessages: [],
      }),
    );
    expect(result.state).toBe("retrying");
    expect(result.rawSessionState).toBe("retry");
  });

  it("reports blocked_question for a pending question on this session", () => {
    const result = classifyTask(
      obs({
        rawStatus: { [SESSION]: "busy" },
        pendingQuestions: [
          { id: "q_1", sessionId: SESSION, questions: [{ header: "Which?" }] },
        ],
      }),
    );
    expect(result.state).toBe("blocked_question");
    expect(result.nextAction).toMatch(/q_1/);
  });

  it("uses indeterminate with terminal null when observationGap leaves insufficient evidence", () => {
    const result = classifyTask(
      obs({
        observationGap: true,
        rawStatus: {},
        assistantMessages: [],
      }),
    );
    expect(result.state).toBe("indeterminate");
    expect(result.terminal).toBeNull();
    expect(result.tracking).toBe("recovery");
    expect(result.nextAction).toMatch(/observation gap/i);
    expect(result.safeToResubmit).toBe(false);
  });

  it("does not treat idle/absent status as success by itself", () => {
    const result = classifyTask(
      obs({
        rawStatus: "idle",
        assistantMessages: [],
      }),
    );
    expect(result.state).not.toBe("succeeded");
    expect(result.state).toBe("queued");
    expect(result.rawSessionState).toBe("idle");
  });
});
