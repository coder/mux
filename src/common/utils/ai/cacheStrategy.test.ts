import { describe, it, expect } from "bun:test";
import type { ModelMessage, Tool } from "ai";
import { tool } from "ai";
import { z } from "zod";
import {
  supportsAnthropicCache,
  applyCacheControl,
  createCachedSystemMessage,
  applyCacheControlToTools,
} from "./cacheStrategy";

describe("cacheStrategy", () => {
  describe("supportsAnthropicCache", () => {
    it("should return true for Anthropic models", () => {
      expect(supportsAnthropicCache("anthropic:claude-3-5-sonnet-20241022")).toBe(true);
      expect(supportsAnthropicCache("anthropic:claude-3-5-haiku-20241022")).toBe(true);
    });

    it("should return false for non-Anthropic models", () => {
      expect(supportsAnthropicCache("openai:gpt-4")).toBe(false);
      expect(supportsAnthropicCache("google:gemini-2.0")).toBe(false);
      expect(supportsAnthropicCache("openrouter:meta-llama/llama-3.1")).toBe(false);
    });
  });

  describe("applyCacheControl", () => {
    it("should not modify messages for non-Anthropic models", () => {
      const messages: ModelMessage[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "How are you?" },
      ];
      const result = applyCacheControl(messages, "openai:gpt-4");
      expect(result).toEqual(messages);
    });

    it("should not modify messages if less than 2 messages", () => {
      const messages: ModelMessage[] = [{ role: "user", content: "Hello" }];
      const result = applyCacheControl(messages, "anthropic:claude-3-5-sonnet");
      expect(result).toEqual(messages);
    });

    it("should add cache control to second-to-last message for Anthropic models", () => {
      const messages: ModelMessage[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "How are you?" },
      ];
      const result = applyCacheControl(messages, "anthropic:claude-3-5-sonnet");

      expect(result[0]).toEqual(messages[0]); // First message unchanged
      expect(result[1]).toEqual({
        // Second message has cache control
        ...messages[1],
        providerOptions: {
          anthropic: {
            cacheControl: {
              type: "ephemeral",
            },
          },
        },
      });
      expect(result[2]).toEqual(messages[2]); // Last message unchanged
    });

    it("should work with exactly 2 messages", () => {
      const messages: ModelMessage[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ];
      const result = applyCacheControl(messages, "anthropic:claude-3-5-sonnet");

      expect(result[0]).toEqual({
        // First message gets cache control
        ...messages[0],
        providerOptions: {
          anthropic: {
            cacheControl: {
              type: "ephemeral",
            },
          },
        },
      });
      expect(result[1]).toEqual(messages[1]); // Last message unchanged
    });
  });

  describe("createCachedSystemMessage", () => {
    describe("integration with streamText parameters", () => {
      it("should handle empty system message correctly", () => {
        // When system message is converted to cached message, the system parameter
        // should be undefined, not empty string, to avoid Anthropic API error
        const systemContent = "You are a helpful assistant";
        const cachedMessage = createCachedSystemMessage(
          systemContent,
          "anthropic:claude-3-5-sonnet"
        );

        expect(cachedMessage).toBeDefined();
        expect(cachedMessage?.role).toBe("system");
        expect(cachedMessage?.content).toBe(systemContent);

        // When using this cached message, system parameter should be set to undefined
        // Example: system: cachedMessage ? undefined : originalSystem
      });
    });

    it("should return null for non-Anthropic models", () => {
      const result = createCachedSystemMessage("You are a helpful assistant", "openai:gpt-4");
      expect(result).toBeNull();
    });

    it("should return null for empty system content", () => {
      const result = createCachedSystemMessage("", "anthropic:claude-3-5-sonnet");
      expect(result).toBeNull();
    });

    it("should create cached system message for Anthropic models", () => {
      const systemContent = "You are a helpful assistant";
      const result = createCachedSystemMessage(systemContent, "anthropic:claude-3-5-sonnet");

      expect(result).toEqual({
        role: "system",
        content: systemContent,
        providerOptions: {
          anthropic: {
            cacheControl: {
              type: "ephemeral",
            },
          },
        },
      });
    });
  });

  describe("applyCacheControlToTools", () => {
    const mockTools: Record<string, Tool> = {
      readFile: tool({
        description: "Read a file",
        inputSchema: z.object({
          path: z.string(),
        }),
        execute: () => Promise.resolve({ success: true }),
      }),
      writeFile: tool({
        description: "Write a file",
        inputSchema: z.object({
          path: z.string(),
          content: z.string(),
        }),
        execute: () => Promise.resolve({ success: true }),
      }),
    };

    it("should not modify tools for non-Anthropic models", () => {
      const result = applyCacheControlToTools(mockTools, "openai:gpt-4");
      expect(result).toEqual(mockTools);
    });

    it("should return empty object for empty tools", () => {
      const result = applyCacheControlToTools({}, "anthropic:claude-3-5-sonnet");
      expect(result).toEqual({});
    });

    it("should add cache control only to the last tool for Anthropic models", () => {
      const result = applyCacheControlToTools(mockTools, "anthropic:claude-3-5-sonnet");

      // Get the keys to identify first and last tools
      const keys = Object.keys(mockTools);
      const lastKey = keys[keys.length - 1];

      // Check that only the last tool has cache control
      for (const [key, tool] of Object.entries(result)) {
        if (key === lastKey) {
          // Last tool should have cache control
          expect(tool).toEqual({
            ...mockTools[key],
            providerOptions: {
              anthropic: {
                cacheControl: {
                  type: "ephemeral",
                },
              },
            },
          });
        } else {
          // Other tools should be unchanged
          expect(tool).toEqual(mockTools[key]);
        }
      }

      // Verify all tools are present
      expect(Object.keys(result)).toEqual(Object.keys(mockTools));
    });

    it("should not modify original tools object", () => {
      const originalTools = { ...mockTools };
      applyCacheControlToTools(mockTools, "anthropic:claude-3-5-sonnet");
      expect(mockTools).toEqual(originalTools);
    });
  });
});
