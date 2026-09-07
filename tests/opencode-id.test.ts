import { describe, expect, it } from "vitest";
import {
  createAscendingId,
  createBridgeJobId,
  isValidMessageId,
} from "../src/opencode-id.js";

const MSG_GENERATED = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const SES_GENERATED = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const JOB_GENERATED = /^job_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

describe("createAscendingId (OpenCode Identifier.ascending)", () => {
  it("generates message IDs as msg_ + 12 hex + 14 base62", () => {
    const id = createAscendingId("msg");
    expect(id).toMatch(MSG_GENERATED);
    expect(id.length).toBe(30);
  });

  it("generates session IDs as ses_ + 12 hex + 14 base62", () => {
    expect(createAscendingId("ses")).toMatch(SES_GENERATED);
  });

  it("generates bridge job IDs in the same ascending layout with a job_ prefix", () => {
    expect(createAscendingId("job")).toMatch(JOB_GENERATED);
  });

  it("uses the optional timestamp in the 6-byte hex field", () => {
    const earlier = createAscendingId("msg", 1_000);
    const later = createAscendingId("msg", 2_000);
    expect(earlier).toMatch(MSG_GENERATED);
    expect(later).toMatch(MSG_GENERATED);
    expect(earlier.slice(4, 16) < later.slice(4, 16)).toBe(true);
    expect(earlier < later).toBe(true);
  });

  it("produces distinct IDs on successive calls", () => {
    const ids = new Set(Array.from({ length: 20 }, () => createAscendingId("msg")));
    expect(ids.size).toBe(20);
  });
});

describe("isValidMessageId", () => {
  it("accepts any string that starts with msg, matching OpenCode Schema.isStartsWith", () => {
    expect(isValidMessageId("msg")).toBe(true);
    expect(isValidMessageId("msg_not-the-generated-shape")).toBe(true);
    expect(isValidMessageId(createAscendingId("msg"))).toBe(true);
  });

  it("rejects session, job, and empty identifiers", () => {
    expect(isValidMessageId("")).toBe(false);
    expect(isValidMessageId("ses_00aabbccddeeABCDEFGHIjk1")).toBe(false);
    expect(isValidMessageId(createAscendingId("ses"))).toBe(false);
    expect(isValidMessageId(createAscendingId("job"))).toBe(false);
    expect(isValidMessageId("MSG_00aabbccddeeABCDEFGHIjk1")).toBe(false);
  });
});

describe("createBridgeJobId", () => {
  it("returns a unique job_ handle that is not an OpenCode message ID", () => {
    const a = createBridgeJobId();
    const b = createBridgeJobId();
    expect(a.startsWith("job_")).toBe(true);
    expect(b.startsWith("job_")).toBe(true);
    expect(a).not.toBe(b);
    expect(isValidMessageId(a)).toBe(false);
  });
});
