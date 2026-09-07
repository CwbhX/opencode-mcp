/**
 * Layer C stub: real tagged OpenCode process.
 *
 * Skips unless OPENCODE_MCP_SERVER_TEST=1. This file does not start OpenCode
 * and must not be treated as a real-server pass.
 */

import { describe, expect, it } from "vitest";

const enabled = process.env.OPENCODE_MCP_SERVER_TEST === "1";

describe("Layer C OpenCode server (opt-in)", () => {
  it.skipIf(!enabled)(
    "placeholder: start a tagged OpenCode and exercise session/prompt_async",
    () => {
      expect.fail(
        "Layer C harness is not implemented. Unset OPENCODE_MCP_SERVER_TEST or implement a disposable OpenCode fixture.",
      );
    },
  );

  it("skips unless OPENCODE_MCP_SERVER_TEST=1", () => {
    if (!enabled) {
      expect(process.env.OPENCODE_MCP_SERVER_TEST ?? "").not.toBe("1");
      return;
    }
    expect(enabled).toBe(true);
  });
});
