/**
 * Thinking/Reasoning level types and mappings for AI models
 *
 * This module provides a unified interface for controlling reasoning across
 * different AI providers (Anthropic, OpenAI, etc.)
 */

export type ThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh";

/**
 * Active thinking levels (excludes "off")
 * Used for storing/restoring the last-used thinking level per model
 */
export type ThinkingLevelOn = Exclude<ThinkingLevel, "off">;

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    value === "off" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  );
}

export function coerceThinkingLevel(value: unknown): ThinkingLevel | undefined {
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
  xhigh: 20000, // Same as high - Anthropic doesn't support xhigh
};

/**
 * Anthropic Opus 4.5 effort parameter mapping
 *
 * The effort parameter is a new feature ONLY available for Claude Opus 4.5.
 * It controls how much computational work the model applies to each task.
 *
 * Other Anthropic models must use the thinking.budgetTokens approach instead.
 *
 * @see https://www.anthropic.com/news/claude-opus-4-5
 */
export const ANTHROPIC_EFFORT: Record<ThinkingLevel, "low" | "medium" | "high"> = {
  off: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high", // Fallback to high - Anthropic doesn't support xhigh
};

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
  xhigh: "xhigh", // Extra High - supported by models that expose xhigh (e.g., gpt-5.1-codex-max, gpt-5.2)
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
};
