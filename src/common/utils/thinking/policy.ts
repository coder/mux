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
 * - openai:gpt-5.1-codex-max → ["off", "low", "medium", "high", "xhigh"] (5 levels including xhigh)
 * - openai:gpt-5.2 → ["off", "low", "medium", "high", "xhigh"] (5 levels including xhigh)
 * - openai:gpt-5.2-pro → ["medium", "high", "xhigh"] (3 levels)
 * - openai:gpt-5-pro → ["high"] (only supported level, legacy)
 * - gemini-3 → ["low", "high"] (thinking level only)
 * - default → ["off", "low", "medium", "high"] (standard 4 levels; xhigh is opt-in per model)
 *
 * Tolerates version suffixes (e.g., gpt-5-pro-2025-10-06).
 * Does NOT match gpt-5-pro-mini (uses negative lookahead).
 */
export function getThinkingPolicyForModel(modelString: string): ThinkingPolicy {
  // Normalize to be robust to provider prefixes, whitespace, gateway wrappers, and version suffixes
  const normalized = modelString.trim().toLowerCase();
  const withoutPrefix = normalized.replace(/^[a-z0-9_-]+:\s*/, "");

  // Many providers/proxies encode the upstream provider as a path segment:
  //   mux-gateway:openai/gpt-5.2-pro -> openai/gpt-5.2-pro -> gpt-5.2-pro
  const withoutProviderNamespace = withoutPrefix.replace(/^[a-z0-9_-]+\//, "");

  // GPT-5.1-Codex-Max supports 5 reasoning levels including xhigh (Extra High)
  if (
    withoutProviderNamespace.startsWith("gpt-5.1-codex-max") ||
    withoutProviderNamespace.startsWith("codex-max")
  ) {
    return ["off", "low", "medium", "high", "xhigh"];
  }

  // gpt-5.2-pro supports medium, high, xhigh reasoning levels
  if (/^gpt-5\.2-pro(?!-[a-z])/.test(withoutProviderNamespace)) {
    return ["medium", "high", "xhigh"];
  }

  // gpt-5.2 supports 5 reasoning levels including xhigh (Extra High)
  if (/^gpt-5\.2(?!-[a-z])/.test(withoutProviderNamespace)) {
    return ["off", "low", "medium", "high", "xhigh"];
  }

  // gpt-5-pro (legacy) only supports high
  if (/^gpt-5-pro(?!-[a-z])/.test(withoutProviderNamespace)) {
    return ["high"];
  }

  // Gemini 3 Flash supports 4 levels: off (minimal), low, medium, high
  if (withoutProviderNamespace.includes("gemini-3-flash")) {
    return ["off", "low", "medium", "high"];
  }

  // Gemini 3 Pro only supports "low" and "high" reasoning levels
  if (withoutProviderNamespace.includes("gemini-3")) {
    return ["low", "high"];
  }

  // Default policy: standard 4 levels (off/low/medium/high). Models with xhigh must opt in above.
  return ["off", "low", "medium", "high"];
}

/**
 * Enforce thinking policy by clamping requested level to allowed set.
 *
 * Fallback strategy:
 * 1. If requested level is allowed, use it
 * 2. Otherwise: prefer "medium" if allowed, else use first allowed level
 */
export function enforceThinkingPolicy(
  modelString: string,
  requested: ThinkingLevel
): ThinkingLevel {
  const allowed = getThinkingPolicyForModel(modelString);

  if (allowed.includes(requested)) {
    return requested;
  }

  // Fallback: prefer "medium" if allowed, else use first allowed level
  return allowed.includes("medium") ? "medium" : allowed[0];
}
