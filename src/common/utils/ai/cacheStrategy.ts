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
 */
export function applyCacheControlToTools<T extends Record<string, Tool>>(
  tools: T,
  modelString: string
): T {
  // Only apply cache control for Anthropic models
  if (!supportsAnthropicCache(modelString) || !tools || Object.keys(tools).length === 0) {
    return tools;
  }

  // Clone tools and add cache control to each tool
  const cachedTools = {} as unknown as T;
  for (const [key, tool] of Object.entries(tools)) {
    // Use unknown as intermediate type for safe casting
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
  }

  return cachedTools;
}
