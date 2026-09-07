import { describe, it, expect } from "vitest";
import {
  IncompleteModelSelectionError,
  UnsupportedParameterError,
} from "../src/bridge-types.js";
import {
  resolveModelSelection,
  parseAllowedModels,
  formatProviderQualified,
  buildPromptBody,
  buildCommandBody,
  buildShellBody,
  buildSummarizeBody,
} from "../src/model-selection.js";

describe("resolveModelSelection", () => {
  it("uses the caller pair when both identifiers are supplied", () => {
    expect(
      resolveModelSelection({
        providerID: "anthropic",
        modelID: "claude-opus-4-6",
        defaults: { providerID: "openai", modelID: "gpt-4o" },
      }),
    ).toEqual({ providerID: "anthropic", modelID: "claude-opus-4-6" });
  });

  it("preserves slashes inside modelID and does not split on every slash", () => {
    const selected = resolveModelSelection({
      providerID: "opencode",
      modelID: "org/muse-spark-1.3-contributor-free",
    });
    expect(selected).toEqual({
      providerID: "opencode",
      modelID: "org/muse-spark-1.3-contributor-free",
    });
    expect(formatProviderQualified(selected!)).toBe(
      "opencode/org/muse-spark-1.3-contributor-free",
    );
  });

  it("uses a complete default pair when the caller supplies neither identifier", () => {
    expect(
      resolveModelSelection({
        defaults: { providerID: "openai", modelID: "gpt-4o" },
      }),
    ).toEqual({ providerID: "openai", modelID: "gpt-4o" });
  });

  it("returns undefined when neither a caller pair nor complete defaults exist", () => {
    expect(resolveModelSelection({})).toBeUndefined();
    expect(resolveModelSelection({ defaults: {} })).toBeUndefined();
  });

  it("throws IncompleteModelSelectionError when the caller supplies only providerID", () => {
    expect(() =>
      resolveModelSelection({ providerID: "anthropic" }),
    ).toThrow(IncompleteModelSelectionError);
  });

  it("throws IncompleteModelSelectionError when the caller supplies only modelID", () => {
    expect(() =>
      resolveModelSelection({ modelID: "claude-opus-4-6" }),
    ).toThrow(IncompleteModelSelectionError);
  });

  it("does not merge a single caller identifier with defaults", () => {
    expect(() =>
      resolveModelSelection({
        providerID: "anthropic",
        defaults: { providerID: "openai", modelID: "gpt-4o" },
      }),
    ).toThrow(IncompleteModelSelectionError);

    expect(() =>
      resolveModelSelection({
        modelID: "claude-opus-4-6",
        defaults: { providerID: "openai", modelID: "gpt-4o" },
      }),
    ).toThrow(IncompleteModelSelectionError);
  });

  it("throws when configuration supplies only one default identifier", () => {
    expect(() =>
      resolveModelSelection({ defaults: { providerID: "openai" } }),
    ).toThrow(IncompleteModelSelectionError);

    expect(() =>
      resolveModelSelection({ defaults: { modelID: "gpt-4o" } }),
    ).toThrow(IncompleteModelSelectionError);
  });

  it("throws when requireExplicit is true and no complete pair is available", () => {
    expect(() => resolveModelSelection({ requireExplicit: true })).toThrow(
      IncompleteModelSelectionError,
    );
  });

  it("accepts a complete default pair when requireExplicit is true", () => {
    expect(
      resolveModelSelection({
        requireExplicit: true,
        defaults: { providerID: "opencode", modelID: "muse-spark-1.3-contributor-free" },
      }),
    ).toEqual({
      providerID: "opencode",
      modelID: "muse-spark-1.3-contributor-free",
    });
  });

  it("accepts a resolved pair that is on the allowlist", () => {
    expect(
      resolveModelSelection({
        providerID: "opencode",
        modelID: "muse-spark-1.3-contributor-free",
        allowedModels: ["opencode/muse-spark-1.3-contributor-free"],
      }),
    ).toEqual({
      providerID: "opencode",
      modelID: "muse-spark-1.3-contributor-free",
    });
  });

  it("matches allowlist entries that contain slashes inside modelID", () => {
    expect(
      resolveModelSelection({
        providerID: "opencode",
        modelID: "org/nested/model",
        allowedModels: ["opencode/org/nested/model"],
      }),
    ).toEqual({ providerID: "opencode", modelID: "org/nested/model" });
  });

  it("throws when a resolved pair is not on the allowlist", () => {
    expect(() =>
      resolveModelSelection({
        providerID: "anthropic",
        modelID: "claude-opus-4-6",
        allowedModels: ["opencode/muse-spark-1.3-contributor-free"],
      }),
    ).toThrow(Error);
  });

  it("does not apply an empty allowlist as a restriction", () => {
    expect(
      resolveModelSelection({
        providerID: "anthropic",
        modelID: "claude-opus-4-6",
        allowedModels: [],
      }),
    ).toEqual({ providerID: "anthropic", modelID: "claude-opus-4-6" });
  });
});

describe("parseAllowedModels", () => {
  it("returns an empty array for undefined or empty input", () => {
    expect(parseAllowedModels(undefined)).toEqual([]);
    expect(parseAllowedModels("")).toEqual([]);
    expect(parseAllowedModels("   ")).toEqual([]);
  });

  it("parses a JSON array of provider-qualified models", () => {
    expect(
      parseAllowedModels(
        '["opencode/muse-spark-1.3-contributor-free","anthropic/claude-opus-4-6"]',
      ),
    ).toEqual([
      "opencode/muse-spark-1.3-contributor-free",
      "anthropic/claude-opus-4-6",
    ]);
  });

  it("preserves slashes inside model IDs", () => {
    expect(parseAllowedModels('["opencode/org/nested/model"]')).toEqual([
      "opencode/org/nested/model",
    ]);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseAllowedModels("not-json")).toThrow();
  });

  it("throws when JSON is not an array of strings", () => {
    expect(() => parseAllowedModels("{}")).toThrow();
    expect(() => parseAllowedModels('["ok", 1]')).toThrow();
  });
});

describe("formatProviderQualified", () => {
  it("joins providerID and modelID with a single slash", () => {
    expect(
      formatProviderQualified({
        providerID: "anthropic",
        modelID: "claude-opus-4-6",
      }),
    ).toBe("anthropic/claude-opus-4-6");
  });

  it("keeps slashes that already exist inside modelID", () => {
    expect(
      formatProviderQualified({
        providerID: "opencode",
        modelID: "org/nested/model",
      }),
    ).toBe("opencode/org/nested/model");
  });
});

describe("buildPromptBody", () => {
  it("includes noReply when true and omits unspecified fields", () => {
    const body = buildPromptBody({ prompt: "hello", noReply: true });
    expect(body).toEqual({
      parts: [{ type: "text", text: "hello" }],
      noReply: true,
    });
    expect(body).not.toHaveProperty("model");
    expect(body).not.toHaveProperty("variant");
    expect(body).not.toHaveProperty("agent");
    expect(body).not.toHaveProperty("system");
    expect(body).not.toHaveProperty("messageID");
  });

  it("omits noReply when it is not true", () => {
    expect(buildPromptBody({ prompt: "hello" })).not.toHaveProperty("noReply");
    expect(buildPromptBody({ prompt: "hello", noReply: false })).not.toHaveProperty(
      "noReply",
    );
  });

  it("includes optional prompt fields when they are specified", () => {
    expect(
      buildPromptBody({
        prompt: "hello",
        agent: "build",
        system: "be brief",
        messageID: "msg_1",
      }),
    ).toEqual({
      parts: [{ type: "text", text: "hello" }],
      agent: "build",
      system: "be brief",
      messageID: "msg_1",
    });
  });
});

describe("buildCommandBody", () => {
  it("serializes model as a provider-qualified string with slashes in modelID", () => {
    const body = buildCommandBody({
      command: "test",
      arguments: "--watch",
      model: { providerID: "opencode", modelID: "org/nested/model" },
      variant: "max",
      agent: "build",
      messageID: "msg_1",
    });
    expect(body.model).toBe("opencode/org/nested/model");
    expect(body.variant).toBe("max");
    expect(body.command).toBe("test");
    expect(body.arguments).toBe("--watch");
    expect(body.agent).toBe("build");
    expect(body.messageID).toBe("msg_1");
  });

  it("omits unspecified optional fields", () => {
    expect(buildCommandBody({ command: "init" })).toEqual({ command: "init" });
  });
});

describe("buildShellBody", () => {
  it("includes a model object and never a variant field", () => {
    const body = buildShellBody({
      command: "ls",
      agent: "build",
      model: { providerID: "opencode", modelID: "muse-spark-1.3-contributor-free" },
    });
    expect(body).toEqual({
      command: "ls",
      agent: "build",
      model: {
        providerID: "opencode",
        modelID: "muse-spark-1.3-contributor-free",
      },
    });
    expect(body).not.toHaveProperty("variant");
  });
});

describe("buildSummarizeBody", () => {
  it("places providerID and modelID at the top level", () => {
    expect(
      buildSummarizeBody({
        providerID: "opencode",
        modelID: "org/nested/model",
        auto: true,
      }),
    ).toEqual({
      providerID: "opencode",
      modelID: "org/nested/model",
      auto: true,
    });
  });

  it("omits auto when it is unspecified", () => {
    expect(
      buildSummarizeBody({
        providerID: "opencode",
        modelID: "muse-spark-1.3-contributor-free",
      }),
    ).toEqual({
      providerID: "opencode",
      modelID: "muse-spark-1.3-contributor-free",
    });
  });
});

describe("unsupported variant", () => {
  it("rejects variant on shell with UnsupportedParameterError", () => {
    expect(() =>
      buildShellBody({
        command: "ls",
        agent: "build",
        variant: "max",
      }),
    ).toThrow(UnsupportedParameterError);

    try {
      buildShellBody({ command: "ls", agent: "build", variant: "max" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedParameterError);
      expect((error as UnsupportedParameterError).parameter).toBe("variant");
      expect((error as UnsupportedParameterError).operation).toBe("shell");
    }
  });

  it("rejects variant on summarize with UnsupportedParameterError", () => {
    try {
      buildSummarizeBody({
        providerID: "opencode",
        modelID: "muse-spark-1.3-contributor-free",
        variant: "max",
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedParameterError);
      expect((error as UnsupportedParameterError).parameter).toBe("variant");
      expect((error as UnsupportedParameterError).operation).toBe("summarize");
    }
  });
});
