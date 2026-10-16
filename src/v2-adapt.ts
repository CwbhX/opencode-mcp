/**
 * Pure translations between the OpenCode v2 wire shapes and the internal
 * shapes the bridge's tools, task manager, and formatters consume.
 *
 * The bridge speaks v2 on the wire only (see client.ts). These helpers keep
 * the rest of the codebase working with one stable internal message/session
 * model: `{ info, parts }` messages, sessions carrying `directory`, and a
 * provider catalog grouped by provider with per-model variant keys.
 */

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Unwrap a v2 `{ data, ... }` success envelope. Bare payloads pass through. */
export function unwrapV2(payload: unknown): unknown {
  if (isRecord(payload) && "data" in payload) {
    const keys = Object.keys(payload);
    const envelopeOnly = keys.every(
      (k) => k === "data" || k === "location" || k === "cursor",
    );
    if (envelopeOnly) return payload.data;
  }
  return payload;
}

/** v2 Session.Info -> internal session shape (adds `directory`, timestamps). */
export function translateSession(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const out: Rec = { ...raw };
  const location = isRecord(raw.location) ? raw.location : undefined;
  const directory = asString(location?.directory) ?? asString(raw.directory);
  if (directory) out.directory = directory;
  const time = isRecord(raw.time) ? raw.time : undefined;
  if (time) {
    if (typeof time.created === "number") {
      out.createdAt = new Date(time.created).toISOString();
    }
    if (typeof time.updated === "number") {
      out.updatedAt = new Date(time.updated).toISOString();
    }
  }
  return out;
}

export function translateSessionList(raw: unknown): unknown {
  const list = Array.isArray(raw) ? raw : [];
  return list.map((item) => translateSession(item));
}

function translateToolContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (typeof item.text === "string") texts.push(item.text);
    else if (typeof item.content === "string") texts.push(item.content);
  }
  return texts.join("\n");
}

function translateAssistantPart(part: Rec): Rec {
  if (part.type === "text") {
    return { type: "text", text: typeof part.text === "string" ? part.text : "" };
  }
  if (part.type === "reasoning") {
    return {
      type: "reasoning",
      text: typeof part.text === "string" ? part.text : "",
    };
  }
  if (part.type === "tool") {
    const state = isRecord(part.state) ? part.state : {};
    const output = translateToolContent(state.content);
    const error = isRecord(state.error)
      ? asString(state.error.message) ?? "tool error"
      : undefined;
    return {
      type: "tool",
      toolName: asString(part.name) ?? "unknown",
      tool: asString(part.name) ?? "unknown",
      state: asString(state.status),
      input: state.input,
      ...(output ? { output } : {}),
      ...(error ? { error } : {}),
    };
  }
  return { ...part };
}

/**
 * Normalize a v2 structured error `{type, message, status?}` to the named
 * error shape `normalizeNamedError` understands.
 */
function translateError(raw: unknown): Rec | undefined {
  if (!isRecord(raw)) return undefined;
  const name = asString(raw.name) ?? asString(raw.type) ?? asString(raw._tag);
  const message = asString(raw.message) ?? "";
  if (!name && !message) return undefined;
  return {
    name: name ?? "Error",
    message,
    ...(typeof raw.status === "number" ? { status: raw.status } : {}),
    ...(typeof raw.statusCode === "number" ? { statusCode: raw.statusCode } : {}),
  };
}

/**
 * Translate a full v2 message list (ascending) to internal `{info, parts}`
 * messages. Assistant messages get `parentID` = the most recent preceding
 * user message id, which is how v2 turns are ordered; this preserves the
 * bridge's request/assistant correlation. Failed/interrupted `idle`
 * markers become error assistant messages so a failed turn is never read
 * as an empty success. Succeeded idle markers and bookkeeping messages
 * (agent/model/location switches) are dropped.
 */
export function translateMessages(raw: unknown): Rec[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: Rec[] = [];
  let lastUserId: string | undefined;

  for (const item of list) {
    if (!isRecord(item)) continue;
    const type = asString(item.type);
    const id = asString(item.id) ?? "?";
    const time = isRecord(item.time) ? item.time : {};

    if (type === "user") {
      lastUserId = id;
      out.push({
        info: { id, role: "user", time },
        parts: [{ type: "text", text: typeof item.text === "string" ? item.text : "" }],
      });
      continue;
    }

    if (type === "assistant") {
      const model = isRecord(item.model) ? item.model : {};
      const content = Array.isArray(item.content) ? item.content : [];
      const error = translateError(item.error);
      out.push({
        info: {
          id,
          role: "assistant",
          ...(lastUserId ? { parentID: lastUserId } : {}),
          ...(asString(model.providerID) ? { providerID: model.providerID } : {}),
          ...(asString(model.id) ? { modelID: model.id } : {}),
          ...(asString(item.agent) ? { agent: item.agent } : {}),
          ...(asString(item.finish) ? { finish: item.finish } : {}),
          time,
          ...(error ? { error } : {}),
          ...(typeof item.cost === "number" ? { cost: item.cost } : {}),
          ...(isRecord(item.tokens) ? { tokens: item.tokens } : {}),
        },
        parts: content.filter(isRecord).map(translateAssistantPart),
      });
      continue;
    }

    if (type === "idle") {
      const outcome = asString(item.outcome);
      if (outcome && outcome !== "succeeded") {
        const error =
          translateError(item.error) ??
          ({ name: "SessionIdleError", message: `Session turn ended: ${outcome}.` } as Rec);
        out.push({
          info: {
            id,
            role: "assistant",
            ...(lastUserId ? { parentID: lastUserId } : {}),
            finish: "error",
            time: { ...time, completed: time.created },
            error,
          },
          parts: [],
        });
      }
      continue;
    }

    if (type === "shell") {
      const output = isRecord(item.output) ? asString(item.output.output) : undefined;
      out.push({
        info: { id, role: "shell", time },
        parts: [
          { type: "text", text: output ?? "" },
        ],
        command: item.command,
        status: item.status,
        ...(item.exit !== undefined ? { exit: item.exit } : {}),
      });
      continue;
    }

    if (type === "synthetic" || type === "system" || type === "skill" || type === "compaction") {
      out.push({
        info: { id, role: type, time },
        parts: [{ type: "text", text: typeof item.text === "string" ? item.text : "" }],
      });
      continue;
    }
    // agent-switched / model-switched / location-switched and unknown
    // bookkeeping messages are not conversation content.
  }
  return out;
}

/** Translate one v2 message without list context (no parentID synthesis). */
export function translateMessage(raw: unknown): Rec {
  const [first] = translateMessages([raw]);
  if (first) return first;
  return { info: { id: "?", role: "unknown" }, parts: [] };
}

/** v2 model catalog entry -> internal model shape with variant-key record. */
export function translateModel(raw: Rec): Rec {
  const variants: Rec = {};
  if (Array.isArray(raw.variants)) {
    for (const v of raw.variants) {
      if (isRecord(v) && typeof v.id === "string") variants[v.id] = v.settings ?? {};
    }
  } else if (isRecord(raw.variants)) {
    Object.assign(variants, raw.variants);
  }
  const costArr = Array.isArray(raw.cost) ? raw.cost : [];
  const firstCost = isRecord(costArr[0]) ? costArr[0] : undefined;
  return {
    ...raw,
    id: asString(raw.modelID) ?? asString(raw.id) ?? "?",
    variants,
    ...(firstCost
      ? {
          cost: {
            input: typeof firstCost.input === "number" ? firstCost.input : 0,
            output: typeof firstCost.output === "number" ? firstCost.output : 0,
          },
        }
      : {}),
  };
}

export interface ProviderCatalogParts {
  models: unknown;
  providers: unknown;
  integrations: unknown;
  defaultModel: unknown;
}

/**
 * Synthesize the internal provider catalog from v2's split endpoints:
 * models carry `providerID`; integrations say which providers have live
 * connections; `/api/provider` lists explicitly configured providers.
 * A provider is marked `source: "api"` (configured) when it has an
 * integration connection or an explicit provider entry, else `"custom"`.
 */
export function synthesizeProviderCatalog(parts: ProviderCatalogParts): Rec {
  const models = Array.isArray(parts.models) ? parts.models.filter(isRecord) : [];
  const providers = Array.isArray(parts.providers)
    ? parts.providers.filter(isRecord)
    : [];
  const integrations = Array.isArray(parts.integrations)
    ? parts.integrations.filter(isRecord)
    : [];

  const connected = new Set<string>();
  const names = new Map<string, string>();
  const envNames = new Map<string, string[]>();
  for (const integration of integrations) {
    const id = asString(integration.id);
    if (!id) continue;
    if (asString(integration.name)) names.set(id, integration.name as string);
    const connections = integration.connections;
    if (Array.isArray(connections) && connections.length > 0) connected.add(id);
    const methods = Array.isArray(integration.methods) ? integration.methods : [];
    const envs: string[] = [];
    for (const method of methods) {
      if (isRecord(method) && method.type === "env" && Array.isArray(method.names)) {
        for (const n of method.names) if (typeof n === "string") envs.push(n);
      }
    }
    if (envs.length > 0) envNames.set(id, envs);
  }
  for (const provider of providers) {
    const id = asString(provider.id);
    if (!id) continue;
    connected.add(id);
    if (asString(provider.name)) names.set(id, provider.name as string);
  }

  const byProvider = new Map<string, Rec>();
  const ensure = (id: string): Rec => {
    let entry = byProvider.get(id);
    if (!entry) {
      entry = {
        id,
        name: names.get(id) ?? id,
        source: connected.has(id) ? "api" : "custom",
        env: envNames.get(id) ?? [],
        models: {} as Rec,
      };
      byProvider.set(id, entry);
    }
    return entry;
  };

  for (const provider of providers) {
    const id = asString(provider.id);
    if (id) ensure(id);
  }
  for (const model of models) {
    const providerID = asString(model.providerID);
    if (!providerID) continue;
    const translated = translateModel(model);
    const entry = ensure(providerID);
    (entry.models as Rec)[translated.id as string] = translated;
  }

  const all = [...byProvider.values()];
  const defaults: Rec = {};
  if (isRecord(parts.defaultModel)) {
    const pid = asString(parts.defaultModel.providerID);
    const mid = asString(parts.defaultModel.modelID) ?? asString(parts.defaultModel.id);
    if (pid && mid) defaults[pid] = mid;
  }
  return { all, default: defaults, connected: [...connected] };
}

/** Internal auth-methods map from v2 integrations. */
export function synthesizeAuthMethods(integrations: unknown): Rec {
  const out: Rec = {};
  if (!Array.isArray(integrations)) return out;
  for (const integration of integrations) {
    if (!isRecord(integration)) continue;
    const id = asString(integration.id);
    if (!id) continue;
    const methods = Array.isArray(integration.methods) ? integration.methods : [];
    out[id] = methods.filter(isRecord).map((m) => ({
      type: asString(m.type) ?? "?",
      label: asString(m.label) ?? asString(m.type) ?? "",
      ...(asString(m.id) ? { id: m.id } : {}),
    }));
  }
  return out;
}

/** v2 permission request -> internal pending-request shape. */
export function translatePermissionRequest(raw: unknown): Rec {
  if (!isRecord(raw)) return {};
  return {
    ...raw,
    permission: asString(raw.action) ?? asString(raw.permission) ?? "?",
    patterns: Array.isArray(raw.resources) ? raw.resources : raw.patterns,
    always: Array.isArray(raw.save) ? raw.save : raw.always,
  };
}

export interface TranslatedFormField {
  key: string;
  field: Rec;
}

/** Extract translatable fields (skip hidden) from a v2 form. */
export function formFields(form: Rec): Rec[] {
  const fields = Array.isArray(form.fields) ? form.fields.filter(isRecord) : [];
  return fields.filter((f) => f.hidden !== true);
}

/** v2 form -> internal question-request shape. */
export function translateFormToQuestion(raw: unknown): Rec {
  if (!isRecord(raw)) return {};
  return {
    id: raw.id,
    sessionID: raw.sessionID,
    title: raw.title,
    questions: formFields(raw).map((field) => ({
      question: asString(field.title) ?? asString(field.key) ?? "",
      header: asString(field.key) ?? "",
      description: asString(field.description),
      multiple: field.type === "multiselect",
      options: (Array.isArray(field.options) ? field.options : [])
        .filter(isRecord)
        .map((o) => ({
          label: asString(o.label) ?? asString(o.value) ?? "",
          value: asString(o.value) ?? asString(o.label) ?? "",
          description: asString(o.description),
        })),
    })),
  };
}

/**
 * Map positional `answers: string[][]` (selected labels per question) to a
 * v2 form answer object keyed by field key. Labels are resolved to option
 * values when the field declares options.
 */
export function buildFormAnswer(form: Rec, answers: string[][]): Rec {
  const fields = formFields(form);
  const answer: Rec = {};
  fields.forEach((field, i) => {
    const key = asString(field.key);
    if (!key) return;
    const selected = Array.isArray(answers[i]) ? answers[i] : [];
    const options = (Array.isArray(field.options) ? field.options : []).filter(isRecord);
    const resolve = (label: string): string => {
      const match = options.find(
        (o) => o.label === label || o.value === label,
      );
      return match ? (asString(match.value) ?? label) : label;
    };
    if (field.type === "multiselect") {
      answer[key] = selected.map(resolve);
    } else if (field.type === "boolean") {
      answer[key] = selected[0] === "true" || selected[0] === "yes";
    } else if (field.type === "number" || field.type === "integer") {
      const n = Number(selected[0]);
      answer[key] = Number.isFinite(n) ? n : (selected[0] ?? "");
    } else {
      answer[key] = selected.length > 0 ? resolve(selected[0]!) : "";
    }
  });
  return answer;
}

/** v2 FileDiff entries -> internal diff shape (`path`, `diff` text). */
export function translateDiffs(raw: unknown): Rec[] {
  const list = Array.isArray(raw) ? raw : [];
  return list.filter(isRecord).map((d) => ({
    ...d,
    path: asString(d.file) ?? asString(d.path) ?? "unknown",
    ...(typeof d.patch === "string" ? { diff: d.patch } : {}),
  }));
}

/** v2 project entry -> internal project shape (`worktree`). */
export function translateProject(raw: unknown): Rec {
  if (!isRecord(raw)) return {};
  return {
    ...raw,
    worktree: asString(raw.canonical) ?? asString(raw.directory) ?? asString(raw.worktree),
  };
}
