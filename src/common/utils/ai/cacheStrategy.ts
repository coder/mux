import type { ModelMessage } from "ai";

/**
 * Apply cache control to messages for Anthropic models
 * MVP: Single cache breakpoint before the last message
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

  // Add cache breakpoint at the second-to-last message
  // This caches everything up to (but not including) the current user message
  const cacheIndex = messages.length - 2;

  return messages.map((msg, index) => {
    if (index === cacheIndex) {
      return {
        ...msg,
        providerOptions: {
          anthropic: {
            cacheControl: {
              type: "ephemeral" as const,
              ttl: "5m",
            },
          },
        },
      };
    }
    return msg;
  });
}
