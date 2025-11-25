/**
 * Thinking/Reasoning level types and mappings for AI models
 *
 * This module provides a unified interface for controlling reasoning across
 * different AI providers (Anthropic, OpenAI, etc.)
 */

export type ThinkingLevel = "off" | "low" | "medium" | "high";

/**
 * Active thinking levels (excludes "off")
 * Used for storing/restoring the last-used thinking level per model
 */
export type ThinkingLevelOn = Exclude<ThinkingLevel, "off">;

/**
 * Anthropic effort level mapping
 *
 * Maps our unified thinking levels to Anthropic's effort parameter:
 * - off: No effort specified (undefined)
 * - low: Most efficient - significant token savings
 * - medium: Balanced approach with moderate token savings
 * - high: Maximum capability (default behavior)
 *
 * The effort parameter controls all token spend including thinking,
 * text responses, and tool calls. Unlike budget_tokens, it doesn't require
 * thinking to be explicitly enabled.
 */
export const ANTHROPIC_EFFORT: Record<ThinkingLevel, "low" | "medium" | "high" | undefined> = {
  off: undefined,
  low: "low",
  medium: "medium",
  high: "high",
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
} as const;
export const OPENROUTER_REASONING_EFFORT: Record<
  ThinkingLevel,
  "low" | "medium" | "high" | undefined
> = {
  off: undefined,
  low: "low",
  medium: "medium",
  high: "high",
};
