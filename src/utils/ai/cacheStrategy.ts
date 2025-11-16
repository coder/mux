import type { ModelMessage } from "ai";

/**
 * Minimum token counts required for caching different Anthropic models
 * Based on https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 */
const MIN_CACHE_TOKENS = {
  haiku: 2048, // Claude Haiku 3.5 and 3
  default: 1024, // Claude Opus 4.1, Opus 4, Sonnet 4.5, Sonnet 4, Sonnet 3.7, Opus 3
} as const;

/**
 * Maximum number of cache breakpoints allowed by Anthropic
 */
const MAX_CACHE_BREAKPOINTS = 4;

/**
 * Rough estimation of tokens from characters
 * Uses ~4 chars per token as a conservative estimate for Anthropic models
 * This is intentionally conservative - better to cache more than miss opportunities
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate tokens in a ModelMessage including all content
 */
function estimateMessageTokens(message: ModelMessage): number {
  let total = 0;

  // Count text content
  if (typeof message.content === "string") {
    total += estimateTokens(message.content);
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === "text") {
        total += estimateTokens(part.text);
      } else if (part.type === "image") {
        // Images have fixed token cost - conservative estimate
        total += 1000;
      }
    }
  }

  // Add overhead for message structure (role, formatting, etc)
  total += 10;

  return total;
}

/**
 * Get minimum cacheable token count for a model
 */
function getMinCacheTokens(modelString: string): number {
  if (modelString.includes("haiku")) {
    return MIN_CACHE_TOKENS.haiku;
  }
  return MIN_CACHE_TOKENS.default;
}

/**
 * Calculate cumulative token counts for messages from start to each position
 */
function calculateCumulativeTokens(messages: ModelMessage[]): number[] {
  const cumulative: number[] = [];
  let total = 0;

  for (const message of messages) {
    total += estimateMessageTokens(message);
    cumulative.push(total);
  }

  return cumulative;
}

/**
 * Determine optimal cache breakpoint positions using a multi-tier strategy
 *
 * Strategy:
 * 1. System messages (1h TTL) - Most stable, rarely change
 * 2. Tool definitions (1h TTL) - Stable within a session
 * 3. Conversation history excluding last few turns (5m TTL) - Changes gradually
 * 4. Recent history excluding current user message (5m TTL) - Fastest changing
 *
 * Returns array of {index, ttl} for messages to mark with cache control
 */
function determineBreakpoints(
  messages: ModelMessage[],
  minTokens: number
): Array<{ index: number; ttl: "5m" | "1h" }> {
  if (messages.length < 2) {
    return [];
  }

  const breakpoints: Array<{ index: number; ttl: "5m" | "1h" }> = [];
  const cumulative = calculateCumulativeTokens(messages);

  // Find system messages (prefer 1h cache for stability)
  // Use manual loop instead of findLastIndex for ES2021 compatibility
  let lastSystemIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "system") {
      lastSystemIndex = i;
      break;
    }
  }
  if (lastSystemIndex >= 0 && cumulative[lastSystemIndex] >= minTokens) {
    breakpoints.push({ index: lastSystemIndex, ttl: "1h" });
  }

  // If no system message cached yet and we have tools, cache after tools
  // Note: In Anthropic's API, tools appear before system in the hierarchy
  // but in ModelMessage format they're typically in early messages
  if (breakpoints.length === 0) {
    // Find first message with substantial content (likely includes tools/setup)
    for (let i = 0; i < Math.min(3, messages.length - 1); i++) {
      if (cumulative[i] >= minTokens) {
        breakpoints.push({ index: i, ttl: "1h" });
        break;
      }
    }
  }

  // Add mid-conversation breakpoint (5m TTL)
  // Cache conversation history but not the most recent exchanges
  if (messages.length >= 6 && breakpoints.length < MAX_CACHE_BREAKPOINTS) {
    const midPoint = Math.floor((messages.length - 2) * 0.6);
    // Ensure this breakpoint is after any 1h breakpoint and has enough tokens
    const lastBreakpointIndex = breakpoints[breakpoints.length - 1]?.index ?? -1;
    if (midPoint > lastBreakpointIndex && cumulative[midPoint] >= minTokens) {
      breakpoints.push({ index: midPoint, ttl: "5m" });
    }
  }

  // Always try to cache everything except the current user message (5m TTL)
  // This is the most frequently refreshed cache
  const lastCacheIndex = messages.length - 2;
  const lastBreakpointIndex = breakpoints[breakpoints.length - 1]?.index ?? -1;

  if (
    lastCacheIndex > lastBreakpointIndex &&
    cumulative[lastCacheIndex] >= minTokens &&
    breakpoints.length < MAX_CACHE_BREAKPOINTS
  ) {
    breakpoints.push({ index: lastCacheIndex, ttl: "5m" });
  }

  return breakpoints;
}

/**
 * Apply cache control to messages for Anthropic models
 *
 * Uses a multi-tier caching strategy:
 * - System messages and tools: 1h TTL (most stable)
 * - Mid-conversation: 5m TTL (moderate stability)
 * - Recent history: 5m TTL (frequently updated)
 *
 * Respects Anthropic's constraints:
 * - Maximum 4 cache breakpoints
 * - Minimum token thresholds (1024 for Sonnet/Opus, 2048 for Haiku)
 * - 1h segments must appear before 5m segments
 *
 * Benefits:
 * - Up to 90% cost reduction on cached content (10% of base price)
 * - Up to 85% latency reduction for cached prompts
 * - Optimal use of 4 breakpoint limit
 */
export function applyCacheControl(messages: ModelMessage[], modelString: string): ModelMessage[] {
  // Only apply cache control for Anthropic models
  if (!modelString.startsWith("anthropic:")) {
    return messages;
  }

  // Need at least 2 messages to add a cache breakpoint
  if (messages.length < 2) {
    return messages;
  }

  const minTokens = getMinCacheTokens(modelString);
  const breakpoints = determineBreakpoints(messages, minTokens);

  // No valid breakpoints found
  if (breakpoints.length === 0) {
    return messages;
  }

  // Apply cache control at determined breakpoints
  return messages.map((msg, index) => {
    const breakpoint = breakpoints.find((bp) => bp.index === index);
    if (breakpoint) {
      return {
        ...msg,
        providerOptions: {
          ...msg.providerOptions,
          anthropic: {
            ...msg.providerOptions?.anthropic,
            cacheControl: {
              type: "ephemeral" as const,
              ttl: breakpoint.ttl,
            },
          },
        },
      };
    }
    return msg;
  });
}
