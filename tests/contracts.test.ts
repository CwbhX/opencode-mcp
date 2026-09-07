import { describe, it, expect } from "vitest";
import {
  IncompleteModelSelectionError,
  UnsupportedParameterError,
} from "../src/bridge-types.js";
import {
  resolveModelSelection,
  buildPromptBody,
  buildCommandBody,
  buildShellBody,
  buildSummarizeBody,
} from "../src/model-selection.js";

describe("MODEL-01 prompt object + top-level variant", () => {
  it("serializes model as { providerID, modelID } and keeps variant outside the model object", () => {
    const body = buildPromptBody({
      prompt: "Say hello",
      model: {
        providerID: "opencode",
        modelID: "muse-spark-1.3-contributor-free",
      },
      variant: "max",
    });

    expect(body.parts).toEqual([{ type: "text", text: "Say hello" }]);
    expect(body.model).toEqual({
      providerID: "opencode",
      modelID: "muse-spark-1.3-contributor-free",
    });
    expect(Object.keys(body.model as object).sort()).toEqual([
      "modelID",
      "providerID",
    ]);
    expect(body.variant).toBe("max");
    expect(body.model).not.toHaveProperty("variant");
  });
});

describe("MODEL-02 command string model", () => {
  it("serializes an explicit model as a provider-qualified string with top-level variant", () => {
    const body = buildCommandBody({
      command: "test",
      arguments: "",
      model: {
        providerID: "opencode",
        modelID: "muse-spark-1.3-contributor-free",
      },
      variant: "max",
    });

    expect(body.model).toBe("opencode/muse-spark-1.3-contributor-free");
    expect(typeof body.model).toBe("string");
    expect(body.variant).toBe("max");
    expect(body.command).toBe("test");
  });

  it("serializes a default-resolved pair the same way as an explicit pair", () => {
    const model = resolveModelSelection({
      defaults: {
        providerID: "opencode",
        modelID: "muse-spark-1.3-contributor-free",
      },
    });
    const body = buildCommandBody({ command: "init", model });
    expect(body.model).toBe("opencode/muse-spark-1.3-contributor-free");
  });
});

describe("MODEL-03 exactly one identifier rejects", () => {
  it("rejects a lone caller identifier without merging defaults", () => {
    expect(() =>
      resolveModelSelection({
        providerID: "anthropic",
        defaults: { providerID: "openai", modelID: "gpt-4o" },
      }),
    ).toThrow(IncompleteModelSelectionError);
  });

  it("rejects a lone default identifier when the caller supplies no pair", () => {
    expect(() =>
      resolveModelSelection({ defaults: { modelID: "gpt-4o" } }),
    ).toThrow(IncompleteModelSelectionError);
  });
});

describe("MODEL-04 variant-only stays top-level", () => {
  it("keeps variant at the top level when the server selects the model", () => {
    const promptBody = buildPromptBody({
      prompt: "Continue",
      variant: "max",
    });
    expect(promptBody.variant).toBe("max");
    expect(promptBody).not.toHaveProperty("model");
    expect(promptBody.parts).toEqual([{ type: "text", text: "Continue" }]);

    const commandBody = buildCommandBody({
      command: "test",
      variant: "max",
    });
    expect(commandBody.variant).toBe("max");
    expect(commandBody).not.toHaveProperty("model");
  });
});

describe("MODEL-05 shell and summarize reject variant", () => {
  it("rejects variant on shell and does not produce a variant field", () => {
    expect(() =>
      buildShellBody({ command: "ls", agent: "build", variant: "max" }),
    ).toThrow(UnsupportedParameterError);
  });

  it("rejects variant on summarize", () => {
    expect(() =>
      buildSummarizeBody({
        providerID: "opencode",
        modelID: "muse-spark-1.3-contributor-free",
        variant: "max",
      }),
    ).toThrow(UnsupportedParameterError);
  });

  it("serializes shell model as an object without variant when variant is omitted", () => {
    const body = buildShellBody({
      command: "ls",
      agent: "build",
      model: { providerID: "opencode", modelID: "muse-spark-1.3-contributor-free" },
    });
    expect(body.model).toEqual({
      providerID: "opencode",
      modelID: "muse-spark-1.3-contributor-free",
    });
    expect(body).not.toHaveProperty("variant");
  });
});
