import { describe, it, expect } from "bun:test";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
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
    it("should return true for direct Anthropic models", () => {
      expect(supportsAnthropicCache("anthropic:claude-3-5-sonnet-20241022")).toBe(true);
      expect(supportsAnthropicCache("anthropic:claude-3-5-haiku-20241022")).toBe(true);
    });

    it("should return true for gateway providers routing to Anthropic", () => {
      expect(supportsAnthropicCache("mux-gateway:anthropic/claude-opus-4-5")).toBe(true);
      expect(supportsAnthropicCache("mux-gateway:anthropic/claude-sonnet-4-5-20250514")).toBe(true);
      expect(supportsAnthropicCache("openrouter:anthropic/claude-3.5-sonnet")).toBe(true);
    });

    it("should return false for non-Anthropic models", () => {
      expect(supportsAnthropicCache("openai:gpt-4")).toBe(false);
      expect(supportsAnthropicCache("google:gemini-2.0")).toBe(false);
      expect(supportsAnthropicCache("openrouter:meta-llama/llama-3.1")).toBe(false);
      expect(supportsAnthropicCache("mux-gateway:openai/gpt-5.2")).toBe(false);
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

    it("should add cache control to single message for Anthropic models", () => {
      const messages: ModelMessage[] = [{ role: "user", content: "Hello" }];
      const result = applyCacheControl(messages, "anthropic:claude-3-5-sonnet");
      expect(result[0]).toEqual({
        ...messages[0],
        providerOptions: {
          anthropic: {
            cacheControl: {
              type: "ephemeral",
            },
          },
        },
      });
    });

    it("should add cache control to last message for Anthropic models", () => {
      const messages: ModelMessage[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "How are you?" },
      ];
      const result = applyCacheControl(messages, "anthropic:claude-3-5-sonnet");

      expect(result[0]).toEqual(messages[0]); // First message unchanged
      expect(result[1]).toEqual(messages[1]); // Second message unchanged
      expect(result[2]).toEqual({
        // Last message has cache control
        ...messages[2],
        providerOptions: {
          anthropic: {
            cacheControl: {
              type: "ephemeral",
            },
          },
        },
      });
    });

    it("should work with exactly 2 messages", () => {
      const messages: ModelMessage[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ];
      const result = applyCacheControl(messages, "anthropic:claude-3-5-sonnet");

      expect(result[0]).toEqual(messages[0]); // First message unchanged
      expect(result[1]).toEqual({
        // Last message gets cache control
        ...messages[1],
        providerOptions: {
          anthropic: {
            cacheControl: {
              type: "ephemeral",
            },
          },
        },
      });
    });

    it("should add cache control to last content part for array content", () => {
      // Messages with array content (typical for user/assistant with multiple parts)
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "Hello" },
            { type: "text", text: "World" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Hi there!" },
            { type: "text", text: "How can I help?" },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Final" },
            { type: "text", text: "question" },
          ],
        },
      ];
      const result = applyCacheControl(messages, "anthropic:claude-3-5-sonnet");

      expect(result[0]).toEqual(messages[0]); // First message unchanged
      expect(result[1]).toEqual(messages[1]); // Second message unchanged

      // Last message (array content): cache control on LAST content part only
      const lastMsg = result[2];
      expect(lastMsg.role).toBe("user");
      expect(Array.isArray(lastMsg.content)).toBe(true);
      const content = lastMsg.content as Array<{
        type: string;
        text: string;
        providerOptions?: unknown;
      }>;
      expect(content[0].providerOptions).toBeUndefined(); // First part unchanged
      expect(content[1].providerOptions).toEqual({
        anthropic: { cacheControl: { type: "ephemeral" } },
      }); // Last part has cache control
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

    const expectProviderToolToRemainProviderNative = (cachedTool: Tool, originalTool: Tool) => {
      const cachedProviderTool = cachedTool as Extract<Tool, { type: "provider" }>;
      const originalProviderTool = originalTool as Extract<Tool, { type: "provider" }>;

      expect(cachedProviderTool.type).toBe("provider");
      expect(cachedProviderTool.id).toBe(originalProviderTool.id);
      expect(cachedProviderTool.args).toEqual(originalProviderTool.args);
      expect(cachedProviderTool.providerOptions).toEqual({
        anthropic: { cacheControl: { type: "ephemeral" } },
      });
      // Regression guard: if this ever becomes a createTool() result, execute will be defined.
      expect((cachedProviderTool as { execute?: unknown }).execute).toBeUndefined();
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

    it("should keep Anthropic provider-native tools as provider tools", () => {
      const providerTool = anthropic.tools.webSearch_20250305({ maxUses: 1000 }) as unknown as Tool;
      const toolsWithProviderTool: Record<string, Tool> = {
        readFile: mockTools.readFile,
        web_search: providerTool,
      };

      const result = applyCacheControlToTools(toolsWithProviderTool, "anthropic:claude-3-5-sonnet");

      // Verify all tools are present and non-provider tools are unchanged.
      expect(Object.keys(result)).toEqual(Object.keys(toolsWithProviderTool));
      expect(result.readFile).toEqual(toolsWithProviderTool.readFile);

      expectProviderToolToRemainProviderNative(result.web_search, providerTool);
    });

    it("should avoid createTool fallback for any provider-native tool", () => {
      const providerTool = openai.tools.webSearch({ searchContextSize: "high" }) as unknown as Tool;
      const toolsWithProviderTool: Record<string, Tool> = {
        readFile: mockTools.readFile,
        web_search: providerTool,
      };

      const result = applyCacheControlToTools(toolsWithProviderTool, "anthropic:claude-3-5-sonnet");

      expect(Object.keys(result)).toEqual(Object.keys(toolsWithProviderTool));
      expectProviderToolToRemainProviderNative(result.web_search, providerTool);
    });

    it("should handle execute-less dynamic tools without throwing", () => {
      const dynamicToolWithoutExecute = {
        type: "dynamic" as const,
        description: "MCP dynamic tool",
        inputSchema: z.object({ query: z.string() }),
      } as unknown as Tool;

      const toolsWithDynamicTool: Record<string, Tool> = {
        readFile: mockTools.readFile,
        mcp_dynamic_tool: dynamicToolWithoutExecute,
      };

      const result = applyCacheControlToTools(toolsWithDynamicTool, "anthropic:claude-3-5-sonnet");

      const cachedDynamicTool = result.mcp_dynamic_tool as {
        type?: string;
        execute?: unknown;
        providerOptions?: unknown;
      };
      expect(cachedDynamicTool.type).toBe("dynamic");
      expect(cachedDynamicTool.execute).toBeUndefined();
      expect(cachedDynamicTool.providerOptions).toEqual({
        anthropic: { cacheControl: { type: "ephemeral" } },
      });
      expect(result.readFile).toEqual(toolsWithDynamicTool.readFile);
    });
  });
});
