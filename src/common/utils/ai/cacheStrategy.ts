import { tool as createTool, type ModelMessage, type Tool } from "ai";
import { normalizeGatewayModel } from "./models";

/**
 * Check if a model supports Anthropic cache control.
 * Matches:
 * - Direct Anthropic provider: "anthropic:claude-opus-4-5"
 * - Gateway providers routing to Anthropic: "mux-gateway:anthropic/claude-opus-4-5"
 * - OpenRouter Anthropic models: "openrouter:anthropic/claude-3.5-sonnet"
 */
export function supportsAnthropicCache(modelString: string): boolean {
  const normalized = normalizeGatewayModel(modelString);
  // Direct Anthropic provider (or normalized gateway model)
  if (normalized.startsWith("anthropic:")) {
    return true;
  }
  // Other gateway/router providers routing to Anthropic (format: "provider:anthropic/model")
  const [, modelId] = normalized.split(":");
  if (modelId?.startsWith("anthropic/")) {
    return true;
  }
  return false;
}

/** Cache control providerOptions for Anthropic */
const ANTHROPIC_CACHE_CONTROL = {
  anthropic: {
    cacheControl: { type: "ephemeral" as const },
  },
};

/**
 * Add providerOptions to the last content part of a message.
 * The SDK requires providerOptions on content parts, not on the message itself.
 *
 * For system messages with string content, we use message-level providerOptions
 * (which the SDK handles correctly). For user/assistant messages with array
 * content, we add providerOptions to the last content part.
 */
function addCacheControlToLastContentPart(msg: ModelMessage): ModelMessage {
  const content = msg.content;

  // String content (typically system messages): use message-level providerOptions
  // The SDK correctly translates this for system messages
  if (typeof content === "string") {
    return {
      ...msg,
      providerOptions: ANTHROPIC_CACHE_CONTROL,
    };
  }

  // Array content: add providerOptions to the last part
  // Use type assertion since we're adding providerOptions which is valid but not in base types
  if (Array.isArray(content) && content.length > 0) {
    const lastIndex = content.length - 1;
    const newContent = content.map((part, i) =>
      i === lastIndex ? { ...part, providerOptions: ANTHROPIC_CACHE_CONTROL } : part
    );
    // Type assertion needed: ModelMessage types are strict unions but providerOptions
    // on content parts is valid per SDK docs
    const result = { ...msg, content: newContent };
    return result as ModelMessage;
  }

  // Empty or unexpected content: return as-is
  return msg;
}

/**
 * Apply cache control to messages for Anthropic models.
 * Adds a cache marker to the last message so the entire conversation is cached.
 *
 * NOTE: The SDK requires providerOptions on content parts, not on the message.
 * We add cache_control to the last content part of the last message.
 */
export function applyCacheControl(messages: ModelMessage[], modelString: string): ModelMessage[] {
  // Only apply cache control for Anthropic models
  if (!supportsAnthropicCache(modelString)) {
    return messages;
  }

  // Need at least 1 message to add a cache breakpoint
  if (messages.length < 1) {
    return messages;
  }

  // Add cache breakpoint at the last message
  const cacheIndex = messages.length - 1;

  return messages.map((msg, index) => {
    if (index === cacheIndex) {
      return addCacheControlToLastContentPart(msg);
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
 *
 * NOTE: The SDK requires providerOptions to be passed during tool() creation,
 * not added afterwards. We re-create the last tool with providerOptions included.
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
  for (const [key, existingTool] of Object.entries(tools)) {
    if (key === lastToolKey) {
      // For provider-defined tools (like Anthropic's webSearch), we cannot recreate them
      // with createTool() - they have special properties. Instead, spread providerOptions
      // directly onto the tool object. While this doesn't work for regular tools (SDK
      // requires providerOptions at creation time), provider-defined tools handle it.
      const isProviderDefinedTool = (existingTool as { type?: string }).type === "provider-defined";

      if (isProviderDefinedTool) {
        // Provider-defined tools: add providerOptions directly (SDK handles it differently)
        cachedTools[key as keyof T] = {
          ...existingTool,
          providerOptions: {
            anthropic: {
              cacheControl: { type: "ephemeral" },
            },
          },
        } as unknown as T[keyof T];
      } else {
        // Regular tools: re-create with providerOptions (SDK requires this at creation time)
        const cachedTool = createTool({
          description: existingTool.description,
          inputSchema: existingTool.inputSchema,
          execute: existingTool.execute,
          providerOptions: {
            anthropic: {
              cacheControl: { type: "ephemeral" },
            },
          },
        });
        cachedTools[key as keyof T] = cachedTool as unknown as T[keyof T];
      }
    } else {
      // Other tools are copied as-is
      cachedTools[key as keyof T] = existingTool as unknown as T[keyof T];
    }
  }

  return cachedTools;
}
