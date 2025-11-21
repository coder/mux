import type { ModelMessage, Tool } from "ai";

/**
 * Check if a model supports Anthropic cache control
 */
export function supportsAnthropicCache(modelString: string): boolean {
  return modelString.startsWith("anthropic:");
}

/**
 * Apply cache control to messages for Anthropic models.
 * Caches all messages except the last user message for optimal cache hits.
 */
export function applyCacheControl(messages: ModelMessage[], modelString: string): ModelMessage[] {
  // Only apply cache control for Anthropic models
  if (!supportsAnthropicCache(modelString)) {
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
            },
          },
        },
      };
    }
    return msg;
  });
}

/**
 * Create a system message with cache control for Anthropic models.
 * System messages rarely change and should always be cached.
 */
export function createCachedSystemMessage(
  systemContent: string,
  modelString: string
): ModelMessage | null {
  if (!systemContent || !supportsAnthropicCache(modelString)) {
    return null;
  }

  return {
    role: "system" as const,
    content: systemContent,
    providerOptions: {
      anthropic: {
        cacheControl: {
          type: "ephemeral" as const,
        },
      },
    },
  };
}

/**
 * Apply cache control to tool definitions for Anthropic models.
 * Tools are static per model and should always be cached.
 *
 * IMPORTANT: Anthropic has a 4 cache breakpoint limit. We use:
 * 1. System message (1 breakpoint)
 * 2. Conversation history (1 breakpoint)
 * 3. Last tool only (1 breakpoint) - caches all tools up to and including this one
 * = 3 total, leaving 1 for future use
 */
export function applyCacheControlToTools<T extends Record<string, Tool>>(
  tools: T,
  modelString: string
): T {
  // Only apply cache control for Anthropic models
  if (!supportsAnthropicCache(modelString) || !tools || Object.keys(tools).length === 0) {
    return tools;
  }

  // Get the last tool key (tools are ordered, last one gets cached)
  const toolKeys = Object.keys(tools);
  const lastToolKey = toolKeys[toolKeys.length - 1];

  // Clone tools and add cache control ONLY to the last tool
  // Anthropic caches everything up to the cache breakpoint, so marking
  // only the last tool will cache all tools
  const cachedTools = {} as unknown as T;
  for (const [key, tool] of Object.entries(tools)) {
    if (key === lastToolKey) {
      // Last tool gets cache control
      const cachedTool = {
        ...tool,
        providerOptions: {
          anthropic: {
            cacheControl: {
              type: "ephemeral" as const,
            },
          },
        },
      };
      cachedTools[key as keyof T] = cachedTool as unknown as T[keyof T];
    } else {
      // Other tools are copied as-is (use unknown for type safety)
      cachedTools[key as keyof T] = tool as unknown as T[keyof T];
    }
  }

  return cachedTools;
}
