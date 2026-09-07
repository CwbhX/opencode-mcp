import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionDirectoryMismatchError, type Clock } from "../src/bridge-types.js";
import {
  assertSessionDirectory,
  createDeadline,
  defaultClock,
  directoriesMatch,
  encodeDirectoryHeader,
  isUnsupportedLiteralPercentPath,
  remainingBudgetMs,
  validateDirectory,
  validateDurationSeconds,
  validateIntervalMs,
} from "../src/request-context.js";

describe("validateDirectory", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = realpathSync(await mkdtemp(path.join(tmpdir(), "req-ctx-")));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("returns undefined when the caller omitted directory", () => {
    expect(validateDirectory(undefined)).toBeUndefined();
    expect(validateDirectory("")).toBeUndefined();
  });

  describe("DIR-01: ASCII, spaces, Unicode", () => {
    it("accepts an ASCII absolute directory and cleans trailing slashes", async () => {
      const ascii = path.join(scratch, "project-ascii");
      await mkdir(ascii);
      expect(validateDirectory(ascii)).toBe(path.resolve(ascii));
      expect(validateDirectory(`${ascii}/`)).toBe(path.resolve(ascii));
    });

    it("accepts a directory whose name contains spaces", async () => {
      const spaced = path.join(scratch, "project with spaces");
      await mkdir(spaced);
      expect(validateDirectory(spaced)).toBe(path.resolve(spaced));
    });

    it("accepts Unicode directory names without lowercasing or NFC/NFD folding", async () => {
      const chinese = path.join(scratch, "项目");
      const cafe = path.join(scratch, "café");
      await mkdir(chinese);
      await mkdir(cafe);
      expect(validateDirectory(chinese)).toBe(path.resolve(chinese));
      expect(validateDirectory(cafe)).toBe(path.resolve(cafe));
    });

    it("returns the lexical path, not a realpath-collapsed symlink", async () => {
      const target = path.join(scratch, "real-project");
      const link = path.join(scratch, "alias-project");
      await mkdir(target);
      await symlink(target, link);
      expect(validateDirectory(link)).toBe(path.resolve(link));
      expect(validateDirectory(link)).not.toBe(realpathSync(link));
    });
  });

  describe("DIR-04: relative, tilde, control bytes, file-as-directory", () => {
    it("rejects relative paths without resolving them against process.cwd()", () => {
      expect(() => validateDirectory(".")).toThrow(/absolute|relative/i);
      expect(() => validateDirectory("./src")).toThrow(/absolute|relative/i);
      expect(() => validateDirectory("src")).toThrow(/absolute|relative/i);
      expect(() => validateDirectory("foo/bar")).toThrow(/absolute|relative/i);
    });

    it("does not treat an existing cwd-relative directory as valid", () => {
      // If the helper resolved against process.cwd(), "src" would become this
      // repository's src/ and pass mustExist. That is the bug being fixed.
      expect(() => validateDirectory("src")).toThrow();
    });

    it("rejects tilde home shorthand", () => {
      expect(() => validateDirectory("~")).toThrow(/~/);
      expect(() => validateDirectory("~/Documents")).toThrow(/~/);
      expect(() => validateDirectory("~user/project")).toThrow(/~/);
    });

    it.each([
      ["NUL", "/tmp\0/x"],
      ["CR", "/tmp\rfoo"],
      ["LF", "/tmp\nfoo"],
      ["CRLF", "/tmp\r\nfoo"],
      ["TAB", "/tmp\tfoo"],
      ["other C0", "/tmp\x01foo"],
      ["DEL", "/tmp\x7ffoo"],
    ])("rejects paths containing %s", (_label, badPath) => {
      expect(() => validateDirectory(badPath)).toThrow(/control|NUL|CR|LF/i);
    });

    it("rejects an existing file that is not a directory", async () => {
      const filePath = path.join(scratch, "not-a-dir");
      await writeFile(filePath, "contents");
      expect(() => validateDirectory(filePath)).toThrow(/not a directory/i);
    });

    it("rejects a missing path when mustExist is true (default)", () => {
      const missing = path.join(scratch, "does-not-exist");
      expect(() => validateDirectory(missing)).toThrow(/not exist/i);
    });

    it("returns the resolved absolute path when mustExist is false and the path is missing", () => {
      const missing = path.join(scratch, "not-created-yet", "..", "not-created-yet");
      expect(validateDirectory(missing, { mustExist: false })).toBe(
        path.resolve(path.join(scratch, "not-created-yet")),
      );
    });

    it("still rejects an existing file when mustExist is false", async () => {
      const filePath = path.join(scratch, "still-a-file");
      await writeFile(filePath, "x");
      expect(() => validateDirectory(filePath, { mustExist: false })).toThrow(
        /not a directory/i,
      );
    });

    it("does not resolve a relative path against cwd when requireAbsolute is disabled", () => {
      const result = validateDirectory("relative/path", {
        requireAbsolute: false,
        mustExist: false,
      });
      expect(result).toBe("relative/path");
      expect(result).not.toBe(path.resolve("relative/path"));
    });
  });
});

describe("isUnsupportedLiteralPercentPath / encodeDirectoryHeader (DIR-01, DIR-02)", () => {
  it("DIR-02: flags any path segment that contains % as unsupported", () => {
    expect(isUnsupportedLiteralPercentPath("/tmp/literal%20name")).toBe(true);
    expect(isUnsupportedLiteralPercentPath("/tmp/literal%2Fname")).toBe(true);
    expect(isUnsupportedLiteralPercentPath("/tmp/literal%25name")).toBe(true);
    expect(isUnsupportedLiteralPercentPath("/tmp/literal%zzname")).toBe(true);
    expect(isUnsupportedLiteralPercentPath("/tmp/dir%2e%2e/secret")).toBe(true);
  });

  it("DIR-01: ASCII, spaces, and Unicode without % remain supported", () => {
    expect(isUnsupportedLiteralPercentPath("/tmp/project-ascii")).toBe(false);
    expect(isUnsupportedLiteralPercentPath("/tmp/project with spaces")).toBe(false);
    expect(isUnsupportedLiteralPercentPath("/tmp/项目")).toBe(false);
    expect(isUnsupportedLiteralPercentPath("/tmp/café")).toBe(false);
  });

  it("leaves ASCII paths including spaces unchanged", () => {
    expect(encodeDirectoryHeader("/tmp/project-ascii")).toBe("/tmp/project-ascii");
    expect(encodeDirectoryHeader("/tmp/project with spaces")).toBe(
      "/tmp/project with spaces",
    );
  });

  it("URI-encodes the full non-ASCII path so the server can decode it back", () => {
    expect(encodeDirectoryHeader("/tmp/项目")).toBe(encodeURIComponent("/tmp/项目"));
    expect(encodeDirectoryHeader("/tmp/café")).toBe(encodeURIComponent("/tmp/café"));
  });

  it("does not double-encode an already percent-escaped ASCII path", () => {
    const alreadyEncoded = encodeURIComponent("/tmp/项目");
    expect(encodeDirectoryHeader(alreadyEncoded)).toBe(alreadyEncoded);
    expect(encodeDirectoryHeader("/tmp/literal%20name")).toBe("/tmp/literal%20name");
  });
});

describe("directoriesMatch / assertSessionDirectory", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = realpathSync(await mkdtemp(path.join(tmpdir(), "req-ctx-match-")));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("matches the same directory and trailing-slash variants", async () => {
    const dir = path.join(scratch, "proj");
    await mkdir(dir);
    expect(directoriesMatch(dir, dir)).toBe(true);
    expect(directoriesMatch(dir, `${dir}/`)).toBe(true);
  });

  it("DIR-06: matches a symlink to the same directory via realpath", async () => {
    const target = path.join(scratch, "worktree-a");
    const link = path.join(scratch, "worktree-a-link");
    await mkdir(target);
    await symlink(target, link);
    expect(directoriesMatch(target, link)).toBe(true);
  });

  it("DIR-06: distinct sibling worktrees do not match", async () => {
    const a = path.join(scratch, "worktree-a");
    const b = path.join(scratch, "worktree-b");
    await mkdir(a);
    await mkdir(b);
    expect(directoriesMatch(a, b)).toBe(false);
  });

  it("does not lowercase for comparison when paths are not both on disk", () => {
    expect(
      directoriesMatch("/tmp/DoesNotExistFoo", "/tmp/doesnotexistfoo"),
    ).toBe(false);
  });

  it("does not throw when either directory is missing", () => {
    expect(() => assertSessionDirectory({})).not.toThrow();
    expect(() =>
      assertSessionDirectory({ requestedDirectory: scratch }),
    ).not.toThrow();
    expect(() =>
      assertSessionDirectory({ sessionDirectory: scratch }),
    ).not.toThrow();
  });

  it("does not throw when both directories refer to the same place", async () => {
    const dir = path.join(scratch, "same");
    await mkdir(dir);
    expect(() =>
      assertSessionDirectory({
        requestedDirectory: dir,
        sessionDirectory: `${dir}/`,
      }),
    ).not.toThrow();
  });

  it("DIR-03: throws SessionDirectoryMismatchError mentioning SESSION_DIRECTORY_MISMATCH", async () => {
    const requested = path.join(scratch, "project-a");
    const session = path.join(scratch, "project-b");
    await mkdir(requested);
    await mkdir(session);

    try {
      assertSessionDirectory({
        requestedDirectory: requested,
        sessionDirectory: session,
      });
      expect.fail("expected SessionDirectoryMismatchError");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionDirectoryMismatchError);
      const mismatch = error as SessionDirectoryMismatchError;
      expect(mismatch.message).toContain("SESSION_DIRECTORY_MISMATCH");
      expect(mismatch.requestedDirectory).toBe(requested);
      expect(mismatch.sessionDirectory).toBe(session);
    }
  });
});

describe("DEADLINE-05: duration and interval validation", () => {
  it.each([
    ["zero", 0],
    ["negative", -5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["non-number string", "30"],
    ["null", null],
  ])("validateDurationSeconds rejects %s", (_label, value) => {
    expect(() => validateDurationSeconds(value, 30, 3600)).toThrow();
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["above max", 10_001],
  ])("validateIntervalMs rejects %s", (_label, value) => {
    expect(() => validateIntervalMs(value, 250, 10_000)).toThrow();
  });

  it("returns the fallback when the value is omitted", () => {
    expect(validateDurationSeconds(undefined, 30, 3600)).toBe(30);
    expect(validateIntervalMs(undefined, 250, 10_000)).toBe(250);
  });

  it("accepts finite positive values at or below max", () => {
    expect(validateDurationSeconds(45, 30, 3600)).toBe(45);
    expect(validateDurationSeconds(3600, 30, 3600)).toBe(3600);
    expect(validateDurationSeconds(0.5, 30, 3600)).toBe(0.5);
    expect(validateIntervalMs(100, 250, 10_000)).toBe(100);
  });

  it("rejects values above max", () => {
    expect(() => validateDurationSeconds(3601, 30, 3600)).toThrow();
  });
});

describe("monotonic deadlines", () => {
  const clock: Clock = {
    now: () => 0,
    monotonic: () => 1_000,
    sleep: async () => undefined,
  };

  it("createDeadline is monotonic() + durationMs", () => {
    expect(createDeadline(250, clock)).toBe(1_250);
  });

  it("remainingBudgetMs is the unused monotonic budget, floored at 0", () => {
    expect(remainingBudgetMs(1_250, clock)).toBe(250);
    expect(remainingBudgetMs(800, clock)).toBe(0);
  });

  it("defaultClock uses Date.now and performance.now", async () => {
    const c = defaultClock();
    expect(Math.abs(c.now() - Date.now())).toBeLessThan(50);
    const started = c.monotonic();
    expect(started).toBeGreaterThanOrEqual(0);
    await c.sleep(0);
    expect(c.monotonic()).toBeGreaterThanOrEqual(started);
  });

  it("defaultClock.sleep rejects when the signal is already aborted", async () => {
    const c = defaultClock();
    const ac = new AbortController();
    ac.abort();
    await expect(c.sleep(1_000, ac.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("defaultClock.sleep stops when aborted during the wait", async () => {
    const c = defaultClock();
    const ac = new AbortController();
    const pending = c.sleep(5_000, ac.signal);
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
