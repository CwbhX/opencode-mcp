import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  SessionDirectoryMismatchError,
  type Clock,
} from "./bridge-types.js";

export interface DirectoryPolicy {
  /** Default true for this local-Mac deployment. */
  requireAbsolute?: boolean;
  /** If true (default), verify path exists and is a directory (not a file). */
  mustExist?: boolean;
}

const CONTROL_BYTES = /[\u0000-\u001F\u007F]/;

function pathKind(directory: string): "missing" | "directory" | "other" {
  try {
    if (!existsSync(directory)) {
      return "missing";
    }
    return statSync(directory).isDirectory() ? "directory" : "other";
  } catch {
    return "missing";
  }
}

export function validateDirectory(
  directory: string | undefined,
  policy?: DirectoryPolicy,
): string | undefined {
  if (directory === undefined || directory === "") {
    return undefined;
  }

  if (CONTROL_BYTES.test(directory)) {
    throw new Error(
      "Invalid directory: path must not contain NUL, CR/LF, or other control characters.",
    );
  }

  if (directory.startsWith("~")) {
    throw new Error(
      `Invalid directory: "~" home shorthand is not expanded. Provide an absolute path instead of "${directory}".`,
    );
  }

  const requireAbsolute = policy?.requireAbsolute !== false;
  const mustExist = policy?.mustExist !== false;

  if (!isAbsolute(directory)) {
    if (requireAbsolute) {
      throw new Error(
        `Invalid directory: relative paths are not resolved against process.cwd(). Provide an absolute path, not "${directory}".`,
      );
    }
    const kind = pathKind(directory);
    if (kind === "other") {
      throw new Error(
        `Invalid directory: "${directory}" exists but is not a directory.`,
      );
    }
    if (mustExist && kind === "missing") {
      throw new Error(`Directory not found: "${directory}" does not exist.`);
    }
    return directory;
  }

  const resolved = resolve(directory);
  const kind = pathKind(resolved);
  if (kind === "other") {
    throw new Error(
      `Invalid directory: "${resolved}" exists but is not a directory.`,
    );
  }
  if (mustExist && kind === "missing") {
    throw new Error(`Directory not found: "${resolved}" does not exist.`);
  }
  return resolved;
}

export function directoriesMatch(a: string, b: string): boolean {
  if (pathKind(a) !== "missing" && pathKind(b) !== "missing") {
    try {
      return realpathSync(a) === realpathSync(b);
    } catch {
      // Fall through to lexical identity when realpath cannot be resolved.
    }
  }
  return resolve(a) === resolve(b);
}

export function assertSessionDirectory(params: {
  requestedDirectory?: string;
  sessionDirectory?: string;
}): void {
  const { requestedDirectory, sessionDirectory } = params;
  if (!requestedDirectory || !sessionDirectory) {
    return;
  }
  if (!directoriesMatch(requestedDirectory, sessionDirectory)) {
    throw new SessionDirectoryMismatchError(
      `SESSION_DIRECTORY_MISMATCH: requested directory "${requestedDirectory}" does not match session directory "${sessionDirectory}".`,
      requestedDirectory,
      sessionDirectory,
    );
  }
}

function validatePositiveBound(
  value: unknown,
  fallback: number,
  max: number,
  label: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > max
  ) {
    throw new Error(
      `Invalid ${label}: expected a finite number greater than 0 and at most ${max}.`,
    );
  }
  return value;
}

export function validateDurationSeconds(
  value: unknown,
  fallback: number,
  max: number,
): number {
  return validatePositiveBound(value, fallback, max, "durationSeconds");
}

export function validateIntervalMs(
  value: unknown,
  fallback: number,
  max: number,
): number {
  return validatePositiveBound(value, fallback, max, "intervalMs");
}

export function remainingBudgetMs(
  deadlineAt: number,
  clock: Clock = defaultClock(),
): number {
  return Math.max(0, deadlineAt - clock.monotonic());
}

export function createDeadline(
  durationMs: number,
  clock: Clock = defaultClock(),
): number {
  return clock.monotonic() + durationMs;
}

function abortReason(signal?: AbortSignal): unknown {
  if (signal?.reason !== undefined) {
    return signal.reason;
  }
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

export function defaultClock(): Clock {
  return {
    now: () => Date.now(),
    monotonic: () => performance.now(),
    sleep(ms: number, signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) {
        return Promise.reject(abortReason(signal));
      }
      if (ms <= 0) {
        return Promise.resolve();
      }
      return new Promise((resolveSleep, rejectSleep) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => {
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          signal?.removeEventListener("abort", onAbort);
          rejectSleep(abortReason(signal));
        };
        timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolveSleep();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
          onAbort();
        }
      });
    },
  };
}

export function encodeDirectoryHeader(directory: string): string {
  // ASCII (including spaces and %HH sequences) is returned unchanged so we
  // never double-encode a percent-escaped path. Non-ASCII uses
  // encodeURIComponent of the FULL path; OpenCode URI-decodes the header.
  // Literal percent paths are rejected separately by
  // isUnsupportedLiteralPercentPath before dispatch.
  for (let i = 0; i < directory.length; i++) {
    if (directory.charCodeAt(i) > 0x7f) {
      return encodeURIComponent(directory);
    }
  }
  return directory;
}

export function isUnsupportedLiteralPercentPath(directory: string): boolean {
  return directory.includes("%");
}
