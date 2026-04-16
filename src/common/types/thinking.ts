/**
 * Thinking/Reasoning level types and mappings for AI models
 *
 * This module provides a unified interface for controlling reasoning across
 * different AI providers (Anthropic, OpenAI, etc.)
 */

import { z } from "zod";

export const THINKING_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const ThinkingLevelSchema = z.enum(THINKING_LEVELS);

/**
 * User-facing display labels for thinking levels.
 * Used in CLI help text and UI display.
 */
export const THINKING_DISPLAY_LABELS: Record<ThinkingLevel, string> = {
  off: "OFF",
  low: "LOW",
  medium: "MED",
  high: "HIGH",
  xhigh: "MAX",
  max: "MAX",
};

/**
 * Display label for thinking levels, with provider-aware xhigh labeling.
 *
 * Models with a native "xhigh" effort level (OpenAI, Anthropic Opus 4.7+) show
 * "XHIGH" for the xhigh ThinkingLevel; on those providers xhigh and max are
 * distinct. On Opus 4.6 (where xhigh maps to max effort), it shows "MAX".
 * Medium always displays as "MED".
 */
export function getThinkingDisplayLabel(level: ThinkingLevel, modelString?: string): string {
  if ((level === "xhigh" || level === "max") && modelString) {
    const normalized = modelString.trim().toLowerCase();
    const withoutPrefix = normalized.replace(/^[a-z0-9_-]+:\s*/, "");

    // OpenAI: both xhigh and max resolve to "xhigh" reasoning effort
    if (normalized.startsWith("openai:") || withoutPrefix.startsWith("openai/")) return "XHIGH";

    // Anthropic Opus 4.7+: xhigh is a distinct effort level from max
    if (level === "xhigh" && anthropicSupportsNativeXhigh(modelString)) return "XHIGH";
  }
  return THINKING_DISPLAY_LABELS[level];
}

/**
 * UI option label for thinking levels.
 *
 * Settings dropdowns use lowercase labels for most levels, but xhigh/max should
 * remain provider-aware to match the model's terminology.
 */
export function getThinkingOptionLabel(level: ThinkingLevel, modelString?: string): string {
  if (level !== "xhigh" && level !== "max") {
    return level;
  }

  return getThinkingDisplayLabel(level, modelString) === "XHIGH" ? "xhigh" : "max";
}

/**
 * Reverse mapping from display labels/aliases to internal ThinkingLevel values.
 * Accepts both canonical names and shorthand aliases (e.g., "med" → "medium").
 */
const DISPLAY_LABEL_TO_LEVEL: Record<string, ThinkingLevel> = {
  off: "off",
  low: "low",
  med: "medium",
  high: "high",
  max: "max",
  xhigh: "xhigh",
  medium: "medium",
};

/**
 * Result of parsing a thinking level input. Named levels resolve to a
 * ThinkingLevel string immediately; numeric indices are deferred and
 * resolved against the target model's thinking policy at send time
 * (since different models have different allowed level sets).
 */
export type ParsedThinkingInput = ThinkingLevel | number;

/**
 * Maximum numeric thinking index (inclusive). Indices 0–N map to
 * the model's allowed levels sorted from lowest to highest.
 * Kept generous — out-of-range indices are clamped to the model's max.
 */
export const MAX_THINKING_INDEX = 9;

/**
 * Parse a thinking level from user input — accepts both named levels
 * ("off", "low", "med", "medium", "high", "max", "xhigh") and numeric
 * indices (0–N). Named levels resolve immediately; numeric indices are
 * returned as numbers for model-aware resolution later via
 * `resolveThinkingInput()` in policy.ts.
 *
 * Used by both `mux run --thinking` and `/model+level` oneshot.
 */
export function parseThinkingInput(value: string): ParsedThinkingInput | undefined {
  const normalized = value.trim().toLowerCase();

  // Named level first (e.g., "off", "low", "med", "high", "max", "xhigh")
  const named = DISPLAY_LABEL_TO_LEVEL[normalized];
  if (named) return named;

  // Numeric index — resolved later against the model's thinking policy
  // (e.g., 0 = lowest allowed level, which is "medium" for gpt-5.4-pro)
  const num = parseInt(normalized, 10);
  if (!Number.isNaN(num) && String(num) === normalized && num >= 0 && num <= MAX_THINKING_INDEX) {
    return num;
  }

  return undefined;
}

/**
 * Active thinking levels (excludes "off")
 * Used for storing/restoring the last-used thinking level per model
 */
export type ThinkingLevelOn = Exclude<ThinkingLevel, "off">;

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

/**
 * Synonym aliases for CLI/UI input: "med" → "medium".
 * "xhigh" and "max" are both first-class ThinkingLevel values (not synonyms).
 */
export const THINKING_LEVEL_SYNONYMS: Readonly<Record<string, ThinkingLevel>> = {
  med: "medium",
};

export function coerceThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (typeof value !== "string") return undefined;
  const synonym = THINKING_LEVEL_SYNONYMS[value];
  if (synonym) return synonym;
  return isThinkingLevel(value) ? value : undefined;
}

/**
 * Anthropic thinking token budget mapping
 *
 * These heuristics balance thinking depth with response time and cost.
 * Used for models that support extended thinking with budgetTokens
 * (e.g., Sonnet 4.5, Haiku 4.5, Opus 4.1, etc.)
 *
 * - off: No extended thinking
 * - low: Quick thinking for straightforward tasks (4K tokens)
 * - medium: Standard thinking for moderate complexity (10K tokens)
 * - high: Deep thinking for complex problems (20K tokens)
 */
export const ANTHROPIC_THINKING_BUDGETS: Record<ThinkingLevel, number> = {
  off: 0,
  low: 4000,
  medium: 10000,
  high: 20000,
  xhigh: 20000, // Same as high - budget ceiling; effort: "max" controls depth
  max: 20000,
};

/**
 * Anthropic effort type - matches SDK's AnthropicProviderOptions["effort"].
 *
 * Note: Opus 4.7 introduced a native "xhigh" effort level in the API, but the
 * SDK's Zod validator still rejects "xhigh". Mux handles this by sending "max"
 * through the SDK and rewriting `output_config.effort` to "xhigh" in a fetch
 * wrapper for Opus 4.7 when the user selected the xhigh ThinkingLevel.
 * See `wrapFetchWithAnthropicCacheControl` and `buildRequestHeaders`.
 */
export type AnthropicEffortLevel = "low" | "medium" | "high" | "max";

/**
 * Anthropic effort parameter mapping (Opus 4.5+)
 *
 * The effort parameter controls how much computational work the model applies.
 * - Opus 4.5 supports: low, medium, high (policy clamps xhigh → high)
 * - Opus 4.6 supports: low, medium, high, max (xhigh maps to "max" effort)
 * - Opus 4.7 supports: low, medium, high, xhigh, max (xhigh requires wire override)
 *
 * Because the @ai-sdk/anthropic Zod schema doesn't accept "xhigh" yet, we send
 * "max" through the SDK for xhigh-on-4.7 and rewrite `output_config.effort` to
 * "xhigh" in the Anthropic fetch wrapper.
 */
const ANTHROPIC_EFFORT: Record<ThinkingLevel, AnthropicEffortLevel> = {
  off: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max", // SDK placeholder; fetch wrapper rewrites to "xhigh" on Opus 4.7
  max: "max",
};

export function getAnthropicEffort(level: ThinkingLevel): AnthropicEffortLevel {
  return ANTHROPIC_EFFORT[level];
}

/**
 * Whether the given Anthropic model is Opus 4.7 or newer and supports the
 * native "xhigh" API effort level (distinct from "max").
 *
 * Matches `claude-opus-4-7`, `claude-opus-4-8`, ... `claude-opus-4-99`, and
 * any future Opus 5+ (which we assume preserves or exceeds 4.7's capabilities).
 */
export function anthropicSupportsNativeXhigh(modelString: string): boolean {
  const withoutPrefix = modelString
    .trim()
    .toLowerCase()
    .replace(/^[a-z0-9_-]+:\s*/, "")
    .replace(/^[a-z0-9_-]+\//, "");
  // Opus 4.7+ (4-7, 4-8, 4-9, 4-10, 4-11, ...) or any Opus 5+.
  return /claude-opus-(?:4-(?:[7-9]|\d{2,})|[5-9]|\d{2,})/.test(withoutPrefix);
}

/**
 * Default thinking level when no value is set (UI initial state, backend fallback).
 * Semantically different from DEFAULT_THINKING_LEVEL which is the level used
 * when a user opts *into* thinking (e.g., CLI `--thinking` with no explicit level).
 */
export const THINKING_LEVEL_OFF: ThinkingLevel = "off";

/**
 * Default thinking level to use when toggling thinking on
 * if no previous value is stored for the model
 */
export const DEFAULT_THINKING_LEVEL: ThinkingLevelOn = "medium";

/**
 * OpenAI reasoning_effort mapping
 *
 * Maps our unified levels to OpenAI's reasoningEffort parameter
 * (used by o1, o3-mini, gpt-5, etc.)
 */
export const OPENAI_REASONING_EFFORT: Record<ThinkingLevel, string | undefined> = {
  off: undefined,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh", // Maps 1:1 to OpenAI's reasoning effort value
  max: "xhigh",
};

/**
 * OpenRouter reasoning effort mapping
 *
 * Maps our unified levels to OpenRouter's reasoning.effort parameter
 * (used by Claude Sonnet Thinking and other reasoning models via OpenRouter)
 */

/**
 * Thinking budgets for Gemini 2.5 models (in tokens)
 */
export const GEMINI_THINKING_BUDGETS: Record<ThinkingLevel, number> = {
  off: 0,
  low: 2048,
  medium: 8192,
  high: 16384, // Conservative max (some models go to 32k)
  xhigh: 16384, // Same as high - Gemini doesn't support xhigh
  max: 16384,
} as const;
export const OPENROUTER_REASONING_EFFORT: Record<
  ThinkingLevel,
  "low" | "medium" | "high" | undefined
> = {
  off: undefined,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high", // Fallback to high - OpenRouter doesn't support xhigh
  max: "high",
};
