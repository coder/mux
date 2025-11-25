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

/**
 * Thinking policy is simply the set of allowed thinking levels for a model.
 * Pure subset design - no wrapper object, no discriminated union.
 */
export type ThinkingPolicy = readonly ThinkingLevel[];

/**
 * Returns the thinking policy for a given model.
 *
 * Rules:
 * - openai:gpt-5-pro → ["high"] (only supported level)
 * - anthropic:claude-opus-4-5 → ["low", "medium", "high"] (effort parameter only)
 * - gemini-3 → ["low", "high"] (thinking level only)
 * - default → ["off", "low", "medium", "high"] (all levels selectable)
 *
 * Tolerates version suffixes (e.g., gpt-5-pro-2025-10-06).
 * Does NOT match gpt-5-pro-mini (uses negative lookahead).
 */
export function getThinkingPolicyForModel(modelString: string): ThinkingPolicy {
  // Match "openai:" followed by optional whitespace and "gpt-5-pro"
  // Allow version suffixes like "-2025-10-06" but NOT "-mini" or other text suffixes
  if (/^openai:\s*gpt-5-pro(?!-[a-z])/.test(modelString)) {
    return ["high"];
  }

  // Claude Opus 4.5 only supports effort parameter: low, medium, high (no "off")
  // Match "anthropic:" followed by "claude-opus-4-5" with optional version suffix
  if (modelString.includes("opus-4-5")) {
    return ["low", "medium", "high"];
  }

  // Gemini 3 Pro only supports "low" and "high" reasoning levels
  if (modelString.includes("gemini-3")) {
    return ["low", "high"];
  }

  // Default policy: all levels selectable
  return ["off", "low", "medium", "high"];
}

/**
 * Enforce thinking policy by clamping requested level to allowed set.
 *
 * Fallback strategy:
 * 1. If requested level is allowed, use it
 * 2. For Opus 4.5: prefer "high" (best experience for reasoning model)
 * 3. Otherwise: prefer "medium" if allowed, else use first allowed level
 */
export function enforceThinkingPolicy(
  modelString: string,
  requested: ThinkingLevel
): ThinkingLevel {
  const allowed = getThinkingPolicyForModel(modelString);

  if (allowed.includes(requested)) {
    return requested;
  }

  // Special case: Opus 4.5 defaults to "high" for best experience
  if (modelString.includes("opus-4-5") && allowed.includes("high")) {
    return "high";
  }

  // Fallback: prefer "medium" if allowed, else use first allowed level
  return allowed.includes("medium") ? "medium" : allowed[0];
}
