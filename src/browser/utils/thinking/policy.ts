/**
 * Thinking policy per model
 *
 * Represents allowed thinking levels for a model as a simple subset.
 * The policy naturally expresses model capabilities:
 * - ["high"] = Fixed policy (e.g., gpt-5-pro only supports HIGH)
 * - ["off"] = No reasoning capability
 * - ["off", "low", "medium", "high"] = Fully selectable
 *
 * UI behavior derives from the subset:
 * - Single element = Non-interactive display
 * - Multiple elements = User can select from options
 */

import type { ThinkingLevel } from "@/common/types/thinking";
import modelsData from "@/common/utils/tokens/models.json";

/**
 * Thinking policy is simply the set of allowed thinking levels for a model.
 * Pure subset design - no wrapper object, no discriminated union.
 */
export type ThinkingPolicy = readonly ThinkingLevel[];

/**
 * Helper to look up model metadata from models.json
 */
function getModelMetadata(modelString: string): Record<string, unknown> | null {
  const colonIndex = modelString.indexOf(":");
  const provider = colonIndex !== -1 ? modelString.slice(0, colonIndex) : "";
  const modelName = colonIndex !== -1 ? modelString.slice(colonIndex + 1) : modelString;

  const lookupKeys: string[] = [modelName];
  if (provider) {
    lookupKeys.push(`${provider}/${modelName}`);
  }

  for (const key of lookupKeys) {
    const data = (modelsData as Record<string, Record<string, unknown>>)[key];
    if (data) {
      return data;
    }
  }

  return null;
}

/**
 * Returns the thinking policy for a given model.
 */
export function getThinkingPolicyForModel(modelString: string): ThinkingPolicy {
  // GPT-5 Pro: always high (but not gpt-5-pro-mini)
  if (modelString.startsWith("openai:gpt-5-pro") && !modelString.includes("-mini")) {
    return ["high"];
  }

  // Gemini 3: limited levels
  if (modelString.includes("gemini-3")) {
    return ["low", "high"];
  }

  // Grok: binary on/off (but not grok-code)
  if (modelString.startsWith("xai:grok-") && !modelString.includes("grok-code")) {
    return ["off", "high"];
  }

  // Check models.json for no reasoning support
  const metadata = getModelMetadata(modelString);
  if (metadata?.supports_reasoning === false) {
    return ["off"];
  }

  // Default: all levels
  return ["off", "low", "medium", "high"];
}

/**
 * Enforce thinking policy by clamping requested level to allowed set.
 *
 * If the requested level isn't allowed:
 * - If user wanted reasoning (non-"off"), pick the highest available non-"off" level
 * - Otherwise return the first allowed level
 */
export function enforceThinkingPolicy(
  modelString: string,
  requested: ThinkingLevel
): ThinkingLevel {
  const allowed = getThinkingPolicyForModel(modelString);

  if (allowed.includes(requested)) {
    return requested;
  }

  // If user wanted reasoning, keep it on with the best available level
  if (requested !== "off") {
    if (allowed.includes("high")) return "high";
    if (allowed.includes("medium")) return "medium";
    if (allowed.includes("low")) return "low";
  }

  return allowed[0];
}
