import type { ModelMessage, Tool } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";

/**
 * Check if a model supports Anthropic cache control
 */
export function supportsAnthropicCache(modelString: string): boolean {
  return modelString.startsWith("anthropic:");
}

/**
 * Merge cache control into existing providerOptions without overwriting other settings.
 * This preserves any existing provider-specific metadata (e.g., reasoning signatures).
 */
function mergeAnthropicCacheControl(existing: ProviderOptions | undefined): ProviderOptions {
  const existingAnthropic =
    existing && typeof existing === "object" && "anthropic" in existing
      ? (existing.anthropic as Record<string, unknown>)
      : {};

  return {
    ...existing,
    anthropic: {
      ...existingAnthropic,
      cacheControl: {
        type: "ephemeral" as const,
      },
    },
  };
}

/**
 * Apply cache control to messages for Anthropic models.
 *
 * Strategy: Place cache breakpoint at the second-to-last message to cache
 * the conversation history up to (but not including) the current user query.
 *
 * Combined with the system message and tools cache breakpoints set elsewhere,
 * this creates an optimal caching pattern:
 * - System message: cached (rarely changes)
 * - Tools: cached (static per model)
 * - Conversation history: cached up to current turn
 *
 * Note: The cache breakpoint position moves with each turn, but this is correct
 * because we want to cache the growing conversation prefix. Each turn's cache
 * includes all previous turns, and subsequent requests with the same prefix
 * will hit the cache.
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
        providerOptions: mergeAnthropicCacheControl(msg.providerOptions),
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
 * Check if a tool is a function tool (not provider-defined).
 * Provider-defined tools (like web_search) have a 'type' property set to 'provider-defined'.
 * Function tools either have no 'type' or have type 'function'.
 */
function isFunctionTool(tool: Tool): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toolType = (tool as any).type;
  return toolType === undefined || toolType === "function" || toolType === "dynamic";
}

/**
 * Apply cache control to tool definitions for Anthropic models.
 * Tools are static per model and should always be cached.
 *
 * IMPORTANT: Anthropic has a 4 cache breakpoint limit. We use:
 * 1. System message (1 breakpoint)
 * 2. Conversation history (1 breakpoint)
 * 3. Last cacheable tool (1 breakpoint) - caches all tools up to and including this one
 * = 3 total, leaving 1 for future use
 *
 * NOTE: Provider-defined tools (like web_search) don't support cache_control through
 * providerOptions - the SDK hardcodes cache_control to undefined for them. So we find
 * the last FUNCTION tool to add the cache breakpoint.
 */
export function applyCacheControlToTools<T extends Record<string, Tool>>(
  tools: T,
  modelString: string
): T {
  // Only apply cache control for Anthropic models
  if (!supportsAnthropicCache(modelString) || !tools || Object.keys(tools).length === 0) {
    return tools;
  }

  // Find the last FUNCTION tool (provider-defined tools don't support cache control)
  const toolEntries = Object.entries(tools);
  let lastFunctionToolKey: string | null = null;
  for (let i = toolEntries.length - 1; i >= 0; i--) {
    const [key, tool] = toolEntries[i];
    if (isFunctionTool(tool)) {
      lastFunctionToolKey = key;
      break;
    }
  }

  // If no function tools, return unchanged
  if (!lastFunctionToolKey) {
    return tools;
  }

  // Clone tools and add cache control to the last function tool
  const cachedTools = {} as unknown as T;
  for (const [key, tool] of toolEntries) {
    if (key === lastFunctionToolKey) {
      // Last function tool gets cache control
      const cachedTool = {
        ...tool,
        providerOptions: mergeAnthropicCacheControl(
          tool.providerOptions as ProviderOptions | undefined
        ),
      };
      cachedTools[key as keyof T] = cachedTool as unknown as T[keyof T];
    } else {
      cachedTools[key as keyof T] = tool as unknown as T[keyof T];
    }
  }

  return cachedTools;
}
