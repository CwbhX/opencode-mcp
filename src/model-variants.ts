import { z } from "zod";

/**
 * Shared `variant` tool text. MCP schemas are static, so clients cannot be
 * given a global enum of thinking levels. Discover keys per model via
 * `opencode_provider_models`.
 */
export const VARIANT_PARAM_DESCRIPTION =
  "Top-level OpenCode thinking/effort variant for the selected model. " +
  "Keys are per-model — call opencode_provider_models and pass one listed " +
  "key. Omit for the model's default. Do not nest inside model.";

export const variantParam = z
  .string()
  .optional()
  .describe(VARIANT_PARAM_DESCRIPTION);

export const unsupportedVariantParam = z
  .string()
  .optional()
  .describe("Unsupported on this tool; omit variant.");

export function enabledVariantKeys(
  model: Record<string, unknown>,
): string[] {
  const variants = model.variants;
  if (!variants || typeof variants !== "object" || Array.isArray(variants)) {
    return [];
  }
  return Object.entries(variants as Record<string, unknown>)
    .filter(([, value]) => {
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as { disabled?: unknown }).disabled === true
      ) {
        return false;
      }
      return true;
    })
    .map(([key]) => key);
}

export function formatModelCatalogLine(
  model: Record<string, unknown>,
): string {
  const id = String(model.id ?? model.name ?? "?");
  const name = model.name && model.name !== model.id ? ` — ${model.name}` : "";
  const keys = enabledVariantKeys(model);
  const variantNote =
    keys.length > 0
      ? ` (variants: ${keys.join(", ")}; omit variant for default)`
      : "";
  return `- ${id}${name}${variantNote}`;
}
