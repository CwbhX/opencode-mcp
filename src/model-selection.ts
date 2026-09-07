import {
  type ModelSelection,
  IncompleteModelSelectionError,
  UnsupportedParameterError,
} from "./bridge-types.js";
import { isValidMessageId } from "./opencode-id.js";

export type { ModelSelection };

export interface ModelDefaults {
  providerID?: string;
  modelID?: string;
}

export interface ResolveModelOptions {
  providerID?: string;
  modelID?: string;
  defaults?: ModelDefaults;
  requireExplicit?: boolean;
  allowedModels?: readonly string[];
}

type IdentifierKind = "omitted" | "invalid" | "present";

function identifierKind(value?: string): IdentifierKind {
  if (value === undefined) return "omitted";
  if (typeof value !== "string" || value.trim().length === 0) return "invalid";
  return "present";
}

function assertAllowed(
  selection: ModelSelection,
  allowedModels?: readonly string[],
): ModelSelection {
  if (!allowedModels || allowedModels.length === 0) {
    return selection;
  }
  const qualified = formatProviderQualified(selection);
  if (!allowedModels.includes(qualified)) {
    throw new Error(
      `Model "${qualified}" is not in the allowed models list.`,
    );
  }
  return selection;
}

function resolvePair(
  providerID: string | undefined,
  modelID: string | undefined,
  label: string,
): ModelSelection {
  const providerKind = identifierKind(providerID);
  const modelKind = identifierKind(modelID);

  if (providerKind === "invalid" || modelKind === "invalid") {
    throw new IncompleteModelSelectionError(
      `Empty or whitespace-only ${label} identifiers are invalid. ` +
        "They are not treated as a request to use defaults.",
    );
  }
  if (providerKind === "present" && modelKind === "present") {
    return { providerID: providerID!, modelID: modelID! };
  }
  if (providerKind === "present" || modelKind === "present") {
    throw new IncompleteModelSelectionError(
      `Both providerID and modelID are required when selecting a model (${label}). ` +
        "A single identifier is not merged with defaults.",
    );
  }
  throw new IncompleteModelSelectionError(
    `No ${label} providerID/modelID pair was provided.`,
  );
}

export function resolveModelSelection(
  opts: ResolveModelOptions,
): ModelSelection | undefined {
  const callerProviderKind = identifierKind(opts.providerID);
  const callerModelKind = identifierKind(opts.modelID);

  if (callerProviderKind === "invalid" || callerModelKind === "invalid") {
    throw new IncompleteModelSelectionError(
      "Empty or whitespace-only identifiers are invalid. " +
        "They are not treated as a request to use defaults.",
    );
  }

  if (callerProviderKind === "present" && callerModelKind === "present") {
    return assertAllowed(
      { providerID: opts.providerID!, modelID: opts.modelID! },
      opts.allowedModels,
    );
  }
  if (callerProviderKind === "present" || callerModelKind === "present") {
    throw new IncompleteModelSelectionError(
      "Both providerID and modelID are required when selecting a model. " +
        "A single identifier is not merged with defaults.",
    );
  }

  const defaultProviderKind = identifierKind(opts.defaults?.providerID);
  const defaultModelKind = identifierKind(opts.defaults?.modelID);

  if (defaultProviderKind === "invalid" || defaultModelKind === "invalid") {
    throw new IncompleteModelSelectionError(
      "Model defaults must be nonempty strings; whitespace-only values are invalid.",
    );
  }

  if (defaultProviderKind === "present" && defaultModelKind === "present") {
    return assertAllowed(
      {
        providerID: opts.defaults!.providerID!,
        modelID: opts.defaults!.modelID!,
      },
      opts.allowedModels,
    );
  }
  if (defaultProviderKind === "present" || defaultModelKind === "present") {
    throw new IncompleteModelSelectionError(
      "Model defaults must include both providerID and modelID.",
    );
  }

  const allowed = opts.allowedModels ?? [];
  if (allowed.length > 0) {
    throw new IncompleteModelSelectionError(
      "A nonempty allowlist requires an explicit or configured providerID/modelID pair. " +
        "Omitting the pair does not permit server-default selection, and the first allowlist entry is not substituted.",
    );
  }

  if (opts.requireExplicit) {
    throw new IncompleteModelSelectionError(
      "An explicit providerID and modelID pair is required.",
    );
  }

  return undefined;
}

export function parseAllowedModels(raw?: string): string[] {
  if (raw === undefined || raw.trim() === "") {
    return [];
  }

  const parsed: unknown = JSON.parse(raw);
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry) => typeof entry === "string")
  ) {
    throw new Error(
      "OPENCODE_ALLOWED_MODELS must be a JSON array of strings.",
    );
  }
  return parsed;
}

export function configuredModelOptions(): ResolveModelOptions {
  return {
    defaults: {
      providerID: process.env.OPENCODE_DEFAULT_PROVIDER,
      modelID: process.env.OPENCODE_DEFAULT_MODEL,
    },
    requireExplicit: process.env.OPENCODE_REQUIRE_EXPLICIT_MODEL === "true",
    allowedModels: parseAllowedModels(process.env.OPENCODE_ALLOWED_MODELS),
  };
}

export function resolveConfiguredModel(opts: {
  providerID?: string;
  modelID?: string;
}): ModelSelection | undefined {
  return resolveModelSelection({
    ...configuredModelOptions(),
    providerID: opts.providerID,
    modelID: opts.modelID,
  });
}

export function assertModelPolicy(selection: ModelSelection): ModelSelection {
  return resolveModelSelection({
    ...configuredModelOptions(),
    providerID: selection.providerID,
    modelID: selection.modelID,
  })!;
}

export function validateStartupModelConfig(): void {
  parseAllowedModels(process.env.OPENCODE_ALLOWED_MODELS);
  const providerKind = identifierKind(process.env.OPENCODE_DEFAULT_PROVIDER);
  const modelKind = identifierKind(process.env.OPENCODE_DEFAULT_MODEL);
  if (providerKind === "invalid" || modelKind === "invalid") {
    throw new IncompleteModelSelectionError(
      "OPENCODE_DEFAULT_PROVIDER and OPENCODE_DEFAULT_MODEL must be nonempty when set.",
    );
  }
  if (providerKind === "present" && modelKind === "present") {
    assertAllowed(
      {
        providerID: process.env.OPENCODE_DEFAULT_PROVIDER!,
        modelID: process.env.OPENCODE_DEFAULT_MODEL!,
      },
      parseAllowedModels(process.env.OPENCODE_ALLOWED_MODELS),
    );
    return;
  }
  if (providerKind === "present" || modelKind === "present") {
    throw new IncompleteModelSelectionError(
      "Model defaults must include both OPENCODE_DEFAULT_PROVIDER and OPENCODE_DEFAULT_MODEL.",
    );
  }
}

export function formatProviderQualified(model: ModelSelection): string {
  return `${model.providerID}/${model.modelID}`;
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  return value;
}

function optionalSupportedVariant(
  variant: string | undefined,
  operation: string,
): string | undefined {
  if (variant === undefined) return undefined;
  const value = assertString(variant, "variant");
  if (value.trim().length === 0) {
    throw new Error(
      `Invalid variant for ${operation}: empty or whitespace-only values are not allowed.`,
    );
  }
  return value;
}

function rejectUnsupportedVariant(
  variant: string | undefined,
  operation: string,
): void {
  if (variant !== undefined) {
    throw new UnsupportedParameterError(
      `variant is not supported for ${operation}`,
      "variant",
      operation,
    );
  }
}

export function buildPromptBody(input: {
  prompt: string;
  model?: ModelSelection;
  variant?: string;
  agent?: string;
  system?: string;
  noReply?: boolean;
  messageID?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    parts: [{ type: "text", text: input.prompt }],
  };

  if (input.model) {
    body.model = {
      providerID: input.model.providerID,
      modelID: input.model.modelID,
    };
  }
  const variant = optionalSupportedVariant(input.variant, "prompt");
  if (variant !== undefined) {
    body.variant = variant;
  }
  if (input.agent !== undefined) {
    body.agent = input.agent;
  }
  if (input.system !== undefined) {
    body.system = input.system;
  }
  if (input.noReply === true) {
    body.noReply = true;
  }
  if (input.messageID !== undefined) {
    body.messageID = input.messageID;
  }

  return body;
}

export function buildCommandBody(input: {
  command: string;
  arguments?: string;
  model?: ModelSelection;
  variant?: string;
  agent?: string;
  messageID?: string;
}): Record<string, unknown> {
  if (input.arguments !== undefined && typeof input.arguments !== "string") {
    throw new Error("command arguments must be a string.");
  }

  const body: Record<string, unknown> = {
    command: input.command,
    arguments: input.arguments ?? "",
  };

  if (input.model) {
    body.model = formatProviderQualified(input.model);
  }
  const variant = optionalSupportedVariant(input.variant, "command");
  if (variant !== undefined) {
    body.variant = variant;
  }
  if (input.agent !== undefined) {
    body.agent = input.agent;
  }
  if (input.messageID !== undefined) {
    body.messageID = input.messageID;
  }

  return body;
}

export function buildShellBody(input: {
  command: string;
  agent: string;
  model?: ModelSelection;
  variant?: string;
}): Record<string, unknown> {
  rejectUnsupportedVariant(input.variant, "shell");

  const body: Record<string, unknown> = {
    command: input.command,
    agent: input.agent,
  };
  if (input.model) {
    body.model = {
      providerID: input.model.providerID,
      modelID: input.model.modelID,
    };
  }
  return body;
}

export function buildSummarizeBody(input: {
  providerID: string;
  modelID: string;
  variant?: string;
  auto?: boolean;
}): Record<string, unknown> {
  rejectUnsupportedVariant(input.variant, "summarize");
  const selected = resolvePair(input.providerID, input.modelID, "summarize");

  const body: Record<string, unknown> = {
    providerID: selected.providerID,
    modelID: selected.modelID,
  };
  if (input.auto !== undefined) {
    body.auto = input.auto;
  }
  return body;
}

export function buildInitBody(input: {
  messageID: string;
  providerID: string;
  modelID: string;
  variant?: string;
}): Record<string, unknown> {
  rejectUnsupportedVariant(input.variant, "init");
  if (typeof input.messageID !== "string" || !isValidMessageId(input.messageID)) {
    throw new Error(
      `Invalid messageID for init: expected an OpenCode message id starting with "msg".`,
    );
  }
  const selected = resolvePair(input.providerID, input.modelID, "init");
  return {
    messageID: input.messageID,
    providerID: selected.providerID,
    modelID: selected.modelID,
  };
}
