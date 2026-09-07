import { describe, it, expect } from "vitest";
import {
  VARIANT_PARAM_DESCRIPTION,
  enabledVariantKeys,
  formatModelCatalogLine,
} from "../src/model-variants.js";

describe("enabledVariantKeys", () => {
  it("returns catalog keys in object order", () => {
    expect(
      enabledVariantKeys({
        variants: {
          minimal: { reasoningEffort: "minimal" },
          low: { reasoningEffort: "low" },
          xhigh: { reasoningEffort: "xhigh" },
        },
      }),
    ).toEqual(["minimal", "low", "xhigh"]);
  });

  it("omits variants marked disabled", () => {
    expect(
      enabledVariantKeys({
        variants: {
          fast: { disabled: true },
          smart: { reasoningEffort: "high" },
        },
      }),
    ).toEqual(["smart"]);
  });

  it("returns empty when variants is missing or not an object", () => {
    expect(enabledVariantKeys({})).toEqual([]);
    expect(enabledVariantKeys({ variants: [] })).toEqual([]);
    expect(enabledVariantKeys({ variants: "high" })).toEqual([]);
  });
});

describe("formatModelCatalogLine", () => {
  it("lists Muse Spark thinking variants next to the model id", () => {
    const line = formatModelCatalogLine({
      id: "muse-spark-1.3-contributor-free",
      name: "Muse Spark 1.3 Free",
      variants: {
        minimal: { reasoningEffort: "minimal" },
        low: { reasoningEffort: "low" },
        medium: { reasoningEffort: "medium" },
        high: { reasoningEffort: "high" },
        xhigh: { reasoningEffort: "xhigh" },
      },
    });
    expect(line).toContain("muse-spark-1.3-contributor-free");
    expect(line).toContain("Muse Spark 1.3 Free");
    expect(line).toMatch(/variants: minimal, low, medium, high, xhigh/);
    expect(line).toMatch(/omit variant for default/i);
  });

  it("does not invent a variants suffix when the catalog has none", () => {
    const line = formatModelCatalogLine({ id: "big-pickle", name: "Big Pickle" });
    expect(line).toBe("- big-pickle — Big Pickle");
    expect(line).not.toMatch(/variants:/);
  });
});

describe("VARIANT_PARAM_DESCRIPTION", () => {
  it("points at catalog discovery and does not list family-specific keys", () => {
    expect(VARIANT_PARAM_DESCRIPTION).toMatch(/opencode_provider_models/);
    expect(VARIANT_PARAM_DESCRIPTION).toMatch(/per-model/i);
    expect(VARIANT_PARAM_DESCRIPTION).toMatch(/top-level/i);
    const banned = /fast|smart|minimal|xhigh|anthropic|muse spark/i;
    expect(VARIANT_PARAM_DESCRIPTION).not.toMatch(banned);
  });
});
