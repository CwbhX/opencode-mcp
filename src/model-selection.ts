import {
  type ModelSelection,
  IncompleteModelSelectionError,
  UnsupportedParameterError,
} from "./bridge-types.js";

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

function isPresent(value?: string): value is string {
  return typeof value === "string" && value.length > 0;
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

export function resolveModelSelection(
  opts: ResolveModelOptions,
): ModelSelection | undefined {
  const callerProvider = opts.providerID;
  const callerModel = opts.modelID;

  if (isPresent(callerProvider) && isPresent(callerModel)) {
    return assertAllowed(
      { providerID: callerProvider, modelID: callerModel },
      opts.allowedModels,
    );
  }
  if (isPresent(callerProvider) || isPresent(callerModel)) {
    throw new IncompleteModelSelectionError(
      "Both providerID and modelID are required when selecting a model. " +
        "A single identifier is not merged with defaults.",
    );
  }

  const defaultProvider = opts.defaults?.providerID;
  const defaultModel = opts.defaults?.modelID;

  if (isPresent(defaultProvider) && isPresent(defaultModel)) {
    return assertAllowed(
      { providerID: defaultProvider, modelID: defaultModel },
      opts.allowedModels,
    );
  }
  if (isPresent(defaultProvider) || isPresent(defaultModel)) {
    throw new IncompleteModelSelectionError(
      "Model defaults must include both providerID and modelID.",
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

export function formatProviderQualified(model: ModelSelection): string {
  return `${model.providerID}/${model.modelID}`;
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
  if (input.variant) {
    body.variant = input.variant;
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
  const body: Record<string, unknown> = {
    command: input.command,
  };

  if (input.arguments !== undefined) {
    body.arguments = input.arguments;
  }
  if (input.model) {
    body.model = formatProviderQualified(input.model);
  }
  if (input.variant) {
    body.variant = input.variant;
  }
  if (input.agent !== undefined) {
    body.agent = input.agent;
  }
  if (input.messageID !== undefined) {
    body.messageID = input.messageID;
  }

  return body;
}

function rejectVariant(variant: string | undefined, operation: string): void {
  if (variant) {
    throw new UnsupportedParameterError(
      `variant is not supported for ${operation}`,
      "variant",
      operation,
    );
  }
}

export function buildShellBody(input: {
  command: string;
  agent: string;
  model?: ModelSelection;
  variant?: string;
}): Record<string, unknown> {
  rejectVariant(input.variant, "shell");

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
  rejectVariant(input.variant, "summarize");

  const body: Record<string, unknown> = {
    providerID: input.providerID,
    modelID: input.modelID,
  };
  if (input.auto !== undefined) {
    body.auto = input.auto;
  }
  return body;
}
