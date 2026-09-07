import { randomBytes } from "node:crypto";

/**
 * OpenCode Identifier.ascending layout from v1.18.29:
 *   prefix + "_" + 12-char hex (6 timestamp bytes) + 14-char base62
 *
 * Message IDs use prefix `msg`. The persisted schema only checks
 * Schema.isStartsWith("msg"); generated IDs still use the full layout.
 */

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const RANDOM_LEN = 14;

let lastTimestamp = Number.NaN;
let counter = 0;

function randomBase62(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += BASE62[bytes[i]! % 62];
  }
  return out;
}

export function createAscendingId(
  prefix: "msg" | "ses" | "job",
  timestamp?: number,
): string {
  const currentTimestamp = timestamp ?? Date.now();

  if (currentTimestamp !== lastTimestamp) {
    lastTimestamp = currentTimestamp;
    counter = 0;
  }
  counter += 1;

  const encoded =
    BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter);

  const timeBytes = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) {
    timeBytes[i] = Number((encoded >> BigInt(40 - 8 * i)) & BigInt(0xff));
  }

  return `${prefix}_${timeBytes.toString("hex")}${randomBase62(RANDOM_LEN)}`;
}

export function isValidMessageId(id: string): boolean {
  return id.startsWith("msg");
}

export function createBridgeJobId(): string {
  return createAscendingId("job");
}
