import { OpenCodeError } from "./http-transport.js";

export type ErrorOrigin =
  | "assistant_message"
  | "session_event"
  | "http_response"
  | "observation";

export type NormalizedErrorKind =
  | "provider_auth"
  | "server_auth"
  | "assistant"
  | "protocol"
  | "other";

export interface NormalizedError {
  name: string;
  message: string;
  origin: ErrorOrigin;
  kind: NormalizedErrorKind;
  statusCode?: number;
  retryable?: boolean;
  providerID?: string;
}

export interface TypedMessageOutcome {
  isEmpty: boolean;
  hasError: boolean;
  hasNonTextContent: boolean;
  warning: string | null;
  error: NormalizedError | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sanitizeText(value: string): string {
  return value.replace(
    /\b(?:sk-|tvly-|ghp_|gho_|xoxb-|whsec_)[A-Za-z0-9_-]{8,}\b/g,
    (match) => `${match.slice(0, 4)}***REDACTED***`,
  );
}

function errorData(error: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(error.data) ? error.data : undefined;
}

export function normalizeNamedError(
  error: unknown,
  origin: ErrorOrigin,
): NormalizedError | null {
  if (error == null) return null;
  if (typeof error === "string") {
    const message = sanitizeText(error);
    return {
      name: "Error",
      message,
      origin,
      kind: "other",
    };
  }
  if (!isRecord(error)) return null;

  const data = errorData(error);
  const name = asString(error.name) ?? "Error";
  const rawMessage =
    asString(data?.message) ??
    asString(error.message) ??
    "";
  const message = sanitizeText(rawMessage);
  const providerID = asString(data?.providerID) ?? asString(error.providerID);
  const retryable =
    typeof error.retryable === "boolean"
      ? error.retryable
      : typeof data?.retryable === "boolean"
        ? data.retryable
        : undefined;
  const statusCode =
    typeof error.statusCode === "number"
      ? error.statusCode
      : typeof error.status === "number"
        ? error.status
        : undefined;

  let kind: NormalizedErrorKind = "assistant";
  if (
    name === "ProviderAuthError" ||
    name === "AuthError" ||
    /provider.?auth/i.test(name)
  ) {
    kind = "provider_auth";
  } else if (origin === "http_response") {
    kind = "other";
  }

  return {
    name,
    message,
    origin,
    kind,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
    ...(providerID ? { providerID } : {}),
  };
}

export function normalizeTransportError(error: unknown): NormalizedError {
  if (error instanceof OpenCodeError) {
    const kind: NormalizedErrorKind = error.isAuth ? "server_auth" : "other";
    return {
      name: error.name,
      message: sanitizeText(error.message),
      origin: "http_response",
      kind,
      statusCode: error.status,
      retryable: error.isTransient,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    name: error instanceof Error ? error.name : "Error",
    message: sanitizeText(message),
    origin: "http_response",
    kind: "other",
  };
}

export function formatNormalizedError(error: NormalizedError): string {
  const detail = error.message ? `: ${error.message}` : "";
  const origin =
    error.origin === "assistant_message"
      ? "assistant"
      : error.origin === "session_event"
        ? "session event"
        : error.origin === "http_response"
          ? "HTTP"
          : "observation";
  if (error.kind === "server_auth") {
    return (
      `${error.name}${detail} (OpenCode server authentication failed; ` +
      `check OPENCODE_SERVER_USERNAME / OPENCODE_SERVER_PASSWORD). Origin: ${origin}.`
    );
  }
  if (error.kind === "provider_auth") {
    const provider = error.providerID ? ` provider=${error.providerID}` : "";
    return (
      `${error.name}${detail}${provider} (cloud provider authentication failed; ` +
      `do not switch models automatically). Origin: ${origin}.`
    );
  }
  return `${error.name}${detail}. Origin: ${origin}.`;
}

function messageInfo(response: unknown): Record<string, unknown> | null {
  if (!isRecord(response)) return null;
  if (isRecord(response.info)) return response.info;
  return response;
}

function partsOf(response: unknown): unknown[] {
  if (!isRecord(response) || !Array.isArray(response.parts)) return [];
  return response.parts;
}

function hasNonTextContent(parts: unknown[]): boolean {
  return parts.some((part) => {
    if (!isRecord(part)) return false;
    const type = part.type;
    return (
      type === "tool" ||
      type === "tool-invocation" ||
      type === "tool-result" ||
      type === "tool-call" ||
      type === "structured_output" ||
      type === "structured-output" ||
      type === "file" ||
      type === "patch"
    );
  });
}

export function analyzeTypedMessage(response: unknown): TypedMessageOutcome {
  if (response === null || response === undefined) {
    return {
      isEmpty: true,
      hasError: true,
      hasNonTextContent: false,
      warning:
        "The response body was absent. This is a protocol/observation failure, not proof that credentials are missing.",
      error: {
        name: "EmptyResponse",
        message: "Response body was null or undefined.",
        origin: "observation",
        kind: "protocol",
      },
    };
  }

  if (typeof response !== "object") {
    return {
      isEmpty: true,
      hasError: true,
      hasNonTextContent: false,
      warning:
        "The response body was malformed. This is a protocol/observation failure, not an authentication diagnosis.",
      error: {
        name: "MalformedResponse",
        message: "Response body was not an object.",
        origin: "observation",
        kind: "protocol",
      },
    };
  }

  const info = messageInfo(response);
  const named = info ? normalizeNamedError(info.error, "assistant_message") : null;
  if (named) {
    return {
      isEmpty: false,
      hasError: true,
      hasNonTextContent: hasNonTextContent(partsOf(response)),
      warning: formatNormalizedError(named),
      error: named,
    };
  }

  const parts = partsOf(response);
  const nonText = hasNonTextContent(parts);
  const textContent = parts
    .filter((part) => isRecord(part) && part.type === "text")
    .map((part) => {
      const rec = part as Record<string, unknown>;
      return typeof rec.text === "string"
        ? rec.text
        : typeof rec.content === "string"
          ? rec.content
          : "";
    })
    .join("")
    .trim();

  if (textContent === "" && !nonText) {
    return {
      isEmpty: true,
      hasError: false,
      hasNonTextContent: false,
      warning:
        "The assistant returned no text content. This is not evidence of missing credentials.",
      error: null,
    };
  }

  return {
    isEmpty: false,
    hasError: false,
    hasNonTextContent: nonText,
    warning: null,
    error: null,
  };
}
