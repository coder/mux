import { describe, it, expect } from "@jest/globals";
import type { ModelMessage, AssistantModelMessage, ToolModelMessage } from "ai";
import {
  transformModelMessages,
  validateAnthropicCompliance,
  addInterruptedSentinel,
  injectModeTransition,
  filterEmptyAssistantMessages,
  injectFileChangeNotifications,
} from "./modelMessageTransform";
import type { MuxMessage } from "@/common/types/message";

describe("modelMessageTransform", () => {
  describe("transformModelMessages", () => {
    it("should handle assistant messages with string content", () => {
      const assistantMsg: AssistantModelMessage = {
        role: "assistant",
        content: "Hi there!",
      };

      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
        assistantMsg,
      ];

      const result = transformModelMessages(messages, "anthropic");
      expect(result).toEqual(messages);
    });

    it("should split mixed text and tool-call content into ordered segments", () => {
      const assistantMsg: AssistantModelMessage = {
        role: "assistant",
        content: [
          { type: "text", text: "Before" },
          { type: "tool-call", toolCallId: "call1", toolName: "bash", input: { script: "pwd" } },
          { type: "text", text: "After" },
        ],
      };
      const toolMsg: ToolModelMessage = {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call1",
            toolName: "bash",
            output: { type: "json", value: { stdout: "/home/user" } },
          },
        ],
      };

      const result = transformModelMessages([assistantMsg, toolMsg], "anthropic");

      expect(result).toHaveLength(4);
      expect(result[0].role).toBe("assistant");
      expect((result[0] as AssistantModelMessage).content).toEqual([
        { type: "text", text: "Before" },
      ]);
      expect(result[1].role).toBe("assistant");
      expect((result[1] as AssistantModelMessage).content).toEqual([
        { type: "tool-call", toolCallId: "call1", toolName: "bash", input: { script: "pwd" } },
      ]);
      expect(result[2].role).toBe("tool");
      expect((result[2] as ToolModelMessage).content[0]).toEqual({
        type: "tool-result",
        toolCallId: "call1",
        toolName: "bash",
        output: { type: "json", value: { stdout: "/home/user" } },
      });
      expect(result[3].role).toBe("assistant");
      expect((result[3] as AssistantModelMessage).content).toEqual([
        { type: "text", text: "After" },
      ]);
    });

    it("should interleave multiple tool-call groups with their results", () => {
      const assistantMsg: AssistantModelMessage = {
        role: "assistant",
        content: [
          { type: "text", text: "Step 1" },
          { type: "tool-call", toolCallId: "call1", toolName: "bash", input: { script: "pwd" } },
          { type: "text", text: "Step 2" },
          { type: "tool-call", toolCallId: "call2", toolName: "bash", input: { script: "ls" } },
        ],
      };
      const toolMsg: ToolModelMessage = {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call1",
            toolName: "bash",
            output: { type: "json", value: { stdout: "/workspace" } },
          },
          {
            type: "tool-result",
            toolCallId: "call2",
            toolName: "bash",
            output: { type: "json", value: { stdout: "file.txt" } },
          },
        ],
      };

      const result = transformModelMessages([assistantMsg, toolMsg], "anthropic");

      expect(result).toHaveLength(6);
      expect(result[0].role).toBe("assistant");
      expect((result[0] as AssistantModelMessage).content).toEqual([
        { type: "text", text: "Step 1" },
      ]);
      expect(result[1].role).toBe("assistant");
      expect((result[1] as AssistantModelMessage).content[0]).toEqual({
        type: "tool-call",
        toolCallId: "call1",
        toolName: "bash",
        input: { script: "pwd" },
      });
      expect(result[2].role).toBe("tool");
      expect((result[2] as ToolModelMessage).content[0]).toMatchObject({ toolCallId: "call1" });
      expect(result[3].role).toBe("assistant");
      expect((result[3] as AssistantModelMessage).content).toEqual([
        { type: "text", text: "Step 2" },
      ]);
      expect(result[4].role).toBe("assistant");
      expect((result[4] as AssistantModelMessage).content[0]).toEqual({
        type: "tool-call",
        toolCallId: "call2",
        toolName: "bash",
        input: { script: "ls" },
      });
      expect(result[5].role).toBe("tool");
      expect((result[5] as ToolModelMessage).content[0]).toMatchObject({ toolCallId: "call2" });
    });
    it("should keep text-only messages unchanged", () => {
      const assistantMsg1: AssistantModelMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Let me help you with that." }],
      };
      const assistantMsg2: AssistantModelMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Here's the result." }],
      };
      const messages: ModelMessage[] = [assistantMsg1, assistantMsg2];

      const result = transformModelMessages(messages, "anthropic");
      expect(result).toEqual(messages);
    });
  });

  describe("validateAnthropicCompliance", () => {
    it("should validate correct message sequences", () => {
      const assistantMsg1: AssistantModelMessage = {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call1", toolName: "bash", input: {} }],
      };
      const toolMsg: ToolModelMessage = {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call1",
            toolName: "bash",
            output: { type: "json", value: {} },
          },
        ],
      };
      const assistantMsg2: AssistantModelMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Done!" }],
      };
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
        assistantMsg1,
        toolMsg,
        assistantMsg2,
      ];

      const result = validateAnthropicCompliance(messages);
      expect(result.valid).toBe(true);
    });

    it("should detect tool calls without results", () => {
      const assistantMsg1: AssistantModelMessage = {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call1", toolName: "bash", input: {} }],
      };
      const assistantMsg2: AssistantModelMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Something else" }],
      };
      const messages: ModelMessage[] = [assistantMsg1, assistantMsg2];

      const result = validateAnthropicCompliance(messages);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("tool_use blocks found without tool_result");
    });

    it("should detect mismatched tool results", () => {
      const assistantMsg: AssistantModelMessage = {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call1", toolName: "bash", input: {} }],
      };
      const toolMsg: ToolModelMessage = {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call2",
            toolName: "bash",
            output: { type: "json", value: {} },
          },
        ],
      };
      const messages: ModelMessage[] = [assistantMsg, toolMsg];

      const result = validateAnthropicCompliance(messages);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("no corresponding tool_use");
    });

    it("should handle string content in assistant messages", () => {
      const assistantMsg: AssistantModelMessage = {
        role: "assistant",
        content: "Just a string message",
      };
      const messages: ModelMessage[] = [
        assistantMsg,
        {
          role: "user",
          content: [{ type: "text", text: "Reply" }],
        },
      ];

      const result = validateAnthropicCompliance(messages);
      expect(result.valid).toBe(true);
    });
  });

  describe("consecutive user messages", () => {
    it("should keep single user message unchanged", () => {
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
      ];

      const result = transformModelMessages(messages, "anthropic");
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe("user");
      expect((result[0].content as Array<{ type: string; text: string }>)[0].text).toBe("Hello");
    });

    it("should merge two consecutive user messages with newline", () => {
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "World" }],
        },
      ];

      const result = transformModelMessages(messages, "anthropic");
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe("user");
      expect((result[0].content as Array<{ type: string; text: string }>)[0].text).toBe(
        "Hello\nWorld"
      );
    });

    it("should merge three consecutive user messages with newlines", () => {
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "First" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "Second" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "Third" }],
        },
      ];

      const result = transformModelMessages(messages, "anthropic");
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe("user");
      expect((result[0].content as Array<{ type: string; text: string }>)[0].text).toBe(
        "First\nSecond\nThird"
      );
    });

    it("should not merge user messages separated by assistant message", () => {
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Hi there!" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "How are you?" }],
        },
      ];

      const result = transformModelMessages(messages, "anthropic");
      expect(result).toHaveLength(3);
      expect(result[0].role).toBe("user");
      expect((result[0].content as Array<{ type: string; text: string }>)[0].text).toBe("Hello");
      expect(result[1].role).toBe("assistant");
      expect(result[2].role).toBe("user");
      expect((result[2].content as Array<{ type: string; text: string }>)[0].text).toBe(
        "How are you?"
      );
    });
  });

  describe("addInterruptedSentinel", () => {
    it("should insert user message after partial assistant message", () => {
      const messages: MuxMessage[] = [
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "Hello" }],
          metadata: { timestamp: 1000 },
        },
        {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "Let me help..." }],
          metadata: { timestamp: 2000, partial: true },
        },
      ];

      const result = addInterruptedSentinel(messages);

      // Should have 3 messages: user, assistant, [CONTINUE] user
      expect(result).toHaveLength(3);
      expect(result[0].id).toBe("user-1");
      expect(result[1].id).toBe("assistant-1");
      expect(result[2].id).toBe("interrupted-assistant-1");
      expect(result[2].role).toBe("user");
      expect(result[2].parts).toEqual([{ type: "text", text: "[CONTINUE]" }]);
      expect(result[2].metadata?.synthetic).toBe(true);
      expect(result[2].metadata?.timestamp).toBe(2000);
    });

    it("should not insert sentinel for non-partial assistant messages", () => {
      const messages: MuxMessage[] = [
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "Hello" }],
          metadata: { timestamp: 1000 },
        },
        {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "Complete response" }],
          metadata: { timestamp: 2000, partial: false },
        },
      ];

      const result = addInterruptedSentinel(messages);

      // Should remain unchanged (no sentinel)
      expect(result).toHaveLength(2);
      expect(result).toEqual(messages);
    });

    it("should insert sentinel for reasoning-only partial messages", () => {
      const messages: MuxMessage[] = [
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "Calculate something" }],
          metadata: { timestamp: 1000 },
        },
        {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "reasoning", text: "Let me think about this..." }],
          metadata: { timestamp: 2000, partial: true },
        },
      ];

      const result = addInterruptedSentinel(messages);

      // Should have 3 messages: user, assistant (reasoning only), [CONTINUE] user
      expect(result).toHaveLength(3);
      expect(result[2].role).toBe("user");
      expect(result[2].parts).toEqual([{ type: "text", text: "[CONTINUE]" }]);
    });

    it("should handle multiple partial messages", () => {
      const messages: MuxMessage[] = [
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "First" }],
          metadata: { timestamp: 1000 },
        },
        {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "Response 1..." }],
          metadata: { timestamp: 2000, partial: true },
        },
        {
          id: "user-2",
          role: "user",
          parts: [{ type: "text", text: "Second" }],
          metadata: { timestamp: 3000 },
        },
        {
          id: "assistant-2",
          role: "assistant",
          parts: [{ type: "text", text: "Response 2..." }],
          metadata: { timestamp: 4000, partial: true },
        },
      ];

      const result = addInterruptedSentinel(messages);

      // Should have 5 messages:
      // - user-1, assistant-1 (partial), user-2 (NO SENTINEL - user follows), assistant-2 (partial), SENTINEL (last message)
      expect(result).toHaveLength(5);
      expect(result[0].id).toBe("user-1");
      expect(result[1].id).toBe("assistant-1");
      expect(result[2].id).toBe("user-2"); // No sentinel between assistant-1 and user-2
      expect(result[3].id).toBe("assistant-2");
      expect(result[4].id).toBe("interrupted-assistant-2"); // Sentinel after last partial
      expect(result[4].role).toBe("user");
    });

    it("should skip sentinel when user message follows partial", () => {
      const messages: MuxMessage[] = [
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "Question" }],
          metadata: { timestamp: 1000 },
        },
        {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "Starting response..." }],
          metadata: { timestamp: 2000, partial: true },
        },
        {
          id: "user-2",
          role: "user",
          parts: [{ type: "text", text: "Follow-up question" }],
          metadata: { timestamp: 3000 },
        },
      ];

      const result = addInterruptedSentinel(messages);

      // Should have 3 messages (no sentinel added because user-2 follows partial)
      expect(result).toHaveLength(3);
      expect(result[0].id).toBe("user-1");
      expect(result[1].id).toBe("assistant-1");
      expect(result[2].id).toBe("user-2");
      // No synthetic sentinel should exist
      expect(result.every((msg) => !msg.metadata?.synthetic)).toBe(true);
    });
  });

  describe("reasoning part handling for OpenAI", () => {
    it("should preserve reasoning parts for OpenAI provider (managed via previousResponseId)", () => {
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Solve this problem" }],
        },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "Let me think about this..." },
            { type: "text", text: "Here's the solution" },
          ],
        },
      ];

      const result = transformModelMessages(messages, "openai");

      // Should have 2 messages, assistant message should keep reasoning + text
      expect(result).toHaveLength(2);
      expect(result[1].role).toBe("assistant");
      expect((result[1] as AssistantModelMessage).content).toEqual([
        { type: "reasoning", text: "Let me think about this..." },
        { type: "text", text: "Here's the solution" },
      ]);
    });

    it("should preserve reasoning parts for Anthropic provider", () => {
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Solve this problem" }],
        },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "Let me think about this..." },
            { type: "text", text: "Here's the solution" },
          ],
        },
      ];

      const result = transformModelMessages(messages, "anthropic");

      // Should have 2 messages, assistant message should have both reasoning and text
      expect(result).toHaveLength(2);
      expect(result[1].role).toBe("assistant");
      const content = (result[1] as AssistantModelMessage).content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content).toHaveLength(2);
        expect(content[0]).toEqual({ type: "reasoning", text: "Let me think about this..." });
        expect(content[1]).toEqual({ type: "text", text: "Here's the solution" });
      }
    });

    it("should filter out reasoning-only messages for OpenAI", () => {
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Calculate something" }],
        },
        {
          role: "assistant",
          content: [{ type: "reasoning", text: "Let me think..." }],
        },
      ];

      const result = transformModelMessages(messages, "openai");

      // Should only have user message, reasoning-only assistant message should be filtered out
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe("user");
    });

    it("should preserve tool calls when stripping reasoning for OpenAI", () => {
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Run a command" }],
        },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "I need to check something..." },
            { type: "text", text: "Let me check" },
            { type: "tool-call", toolCallId: "call1", toolName: "bash", input: { script: "pwd" } },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call1",
              toolName: "bash",
              output: { type: "json", value: { stdout: "/home/user" } },
            },
          ],
        },
      ];

      const result = transformModelMessages(messages, "openai");

      // Should still contain user, assistant, and tool messages after filtering
      expect(result.length).toBeGreaterThan(2);

      // Find the assistant message with text (reasoning should remain alongside text)
      const textMessage = result.find((msg) => {
        if (msg.role !== "assistant") return false;
        const content = msg.content;
        return Array.isArray(content) && content.some((c) => c.type === "text");
      });
      expect(textMessage).toBeDefined();
      if (textMessage) {
        const content = (textMessage as AssistantModelMessage).content;
        if (Array.isArray(content)) {
          expect(content.some((c) => c.type === "reasoning")).toBe(true);
          expect(content.some((c) => c.type === "text")).toBe(true);
        }
      }

      // Find the assistant message with tool-call
      const toolCallMessage = result.find((msg) => {
        if (msg.role !== "assistant") return false;
        const content = msg.content;
        return Array.isArray(content) && content.some((c) => c.type === "tool-call");
      });
      expect(toolCallMessage).toBeDefined();
    });

    it("should handle multiple reasoning parts for OpenAI", () => {
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Complex task" }],
        },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "First, I'll consider..." },
            { type: "reasoning", text: "Then, I'll analyze..." },
            { type: "text", text: "Final answer" },
          ],
        },
      ];

      const result = transformModelMessages(messages, "openai");

      // Should have 2 messages, assistant should keep all reasoning + text (coalesced)
      expect(result).toHaveLength(2);
      expect(result[1].role).toBe("assistant");
      expect((result[1] as AssistantModelMessage).content).toEqual([
        { type: "reasoning", text: "First, I'll consider...Then, I'll analyze..." },
        { type: "text", text: "Final answer" },
      ]);
    });
  });
});

describe("injectModeTransition", () => {
  it("should inject transition message when mode changes", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Let's plan a feature" }],
        metadata: { timestamp: 1000 },
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Here's the plan..." }],
        metadata: { timestamp: 2000, mode: "plan" },
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "Now execute it" }],
        metadata: { timestamp: 3000 },
      },
    ];

    const result = injectModeTransition(messages, "exec");

    // Should have 4 messages: user, assistant, mode-transition, user
    expect(result.length).toBe(4);

    // Third message should be mode transition
    expect(result[2].role).toBe("user");
    expect(result[2].metadata?.synthetic).toBe(true);
    expect(result[2].parts[0]).toMatchObject({
      type: "text",
      text: "[Mode switched from plan to exec. Follow exec mode instructions.]",
    });

    // Original messages should be preserved
    expect(result[0]).toEqual(messages[0]);
    expect(result[1]).toEqual(messages[1]);
    expect(result[3]).toEqual(messages[2]); // Last user message shifted
  });

  it("should not inject transition when mode is the same", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Let's plan" }],
        metadata: { timestamp: 1000 },
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Planning..." }],
        metadata: { timestamp: 2000, mode: "plan" },
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "Continue planning" }],
        metadata: { timestamp: 3000 },
      },
    ];

    const result = injectModeTransition(messages, "plan");

    // Should be unchanged
    expect(result.length).toBe(3);
    expect(result).toEqual(messages);
  });

  it("should not inject transition when no previous mode exists", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
        metadata: { timestamp: 1000 },
      },
    ];

    const result = injectModeTransition(messages, "exec");

    // Should be unchanged (no assistant message to compare)
    expect(result.length).toBe(1);
    expect(result).toEqual(messages);
  });

  it("should not inject transition when no mode specified", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
        metadata: { timestamp: 1000 },
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Hi" }],
        metadata: { timestamp: 2000, mode: "plan" },
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "Continue" }],
        metadata: { timestamp: 3000 },
      },
    ];

    const result = injectModeTransition(messages, undefined);

    // Should be unchanged
    expect(result.length).toBe(3);
    expect(result).toEqual(messages);
  });

  it("should handle conversation with no user messages", () => {
    const messages: MuxMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Hi" }],
        metadata: { timestamp: 2000, mode: "plan" },
      },
    ];

    const result = injectModeTransition(messages, "exec");

    // Should be unchanged (no user message to inject before)
    expect(result.length).toBe(1);
    expect(result).toEqual(messages);
  });

  it("should include tool names in transition message when provided", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Let's plan a feature" }],
        metadata: { timestamp: 1000 },
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Here's the plan..." }],
        metadata: { timestamp: 2000, mode: "plan" },
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "Now execute it" }],
        metadata: { timestamp: 3000 },
      },
    ];

    const toolNames = ["file_read", "bash", "file_edit_replace_string", "web_search"];
    const result = injectModeTransition(messages, "exec", toolNames);

    // Should have 4 messages: user, assistant, mode-transition, user
    expect(result.length).toBe(4);

    // Third message should be mode transition with tool names
    expect(result[2].role).toBe("user");
    expect(result[2].metadata?.synthetic).toBe(true);
    expect(result[2].parts[0]).toMatchObject({
      type: "text",
      text: "[Mode switched from plan to exec. Follow exec mode instructions. Available tools: file_read, bash, file_edit_replace_string, web_search.]",
    });
  });

  it("should handle mode transition without tools parameter (backward compatibility)", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Let's plan" }],
        metadata: { timestamp: 1000 },
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Planning..." }],
        metadata: { timestamp: 2000, mode: "plan" },
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "Execute" }],
        metadata: { timestamp: 3000 },
      },
    ];

    const result = injectModeTransition(messages, "exec");

    // Should have 4 messages with transition, but no tool info
    expect(result.length).toBe(4);
    expect(result[2].parts[0]).toMatchObject({
      type: "text",
      text: "[Mode switched from plan to exec. Follow exec mode instructions.]",
    });
  });

  it("should handle mode transition with empty tool list", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Let's plan" }],
        metadata: { timestamp: 1000 },
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Planning..." }],
        metadata: { timestamp: 2000, mode: "plan" },
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "Execute" }],
        metadata: { timestamp: 3000 },
      },
    ];

    const result = injectModeTransition(messages, "exec", []);

    // Should have 4 messages with transition, but no tool info (empty array handled gracefully)
    expect(result.length).toBe(4);
    expect(result[2].parts[0]).toMatchObject({
      type: "text",
      text: "[Mode switched from plan to exec. Follow exec mode instructions.]",
    });
  });
});

describe("filterEmptyAssistantMessages", () => {
  it("should filter out assistant messages with only reasoning when preserveReasoningOnly=false", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
        metadata: { timestamp: 1000 },
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "reasoning", text: "Let me think about this..." }],
        metadata: { timestamp: 2000 },
      },
    ];

    const result = filterEmptyAssistantMessages(messages, false);

    // Reasoning-only message should be filtered out
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("user-1");
  });

  it("should filter out assistant messages with empty parts array (placeholder messages)", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
        metadata: { timestamp: 1000 },
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [], // Empty placeholder message
        metadata: { timestamp: 2000 },
      },
      {
        id: "assistant-2",
        role: "assistant",
        parts: [], // Another empty placeholder
        metadata: { timestamp: 3000 },
      },
    ];

    // Empty messages should be filtered out regardless of preserveReasoningOnly
    const result1 = filterEmptyAssistantMessages(messages, false);
    expect(result1.length).toBe(1);
    expect(result1[0].id).toBe("user-1");

    const result2 = filterEmptyAssistantMessages(messages, true);
    expect(result2.length).toBe(1);
    expect(result2[0].id).toBe("user-1");
  });

  it("should preserve assistant messages with only reasoning when preserveReasoningOnly=true", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
        metadata: { timestamp: 1000 },
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "reasoning", text: "Let me think about this..." }],
        metadata: { timestamp: 2000 },
      },
    ];

    const result = filterEmptyAssistantMessages(messages, true);

    // Reasoning-only message should be preserved when preserveReasoningOnly=true
    expect(result.length).toBe(2);
    expect(result[1].id).toBe("assistant-1");
    expect(result[1].parts).toEqual([{ type: "reasoning", text: "Let me think about this..." }]);
  });

  it("should preserve assistant messages with text content regardless of preserveReasoningOnly", () => {
    const messages: MuxMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "Thinking..." },
          { type: "text", text: "Here's my answer" },
        ],
        metadata: { timestamp: 2000 },
      },
    ];

    // With preserveReasoningOnly=false
    const result1 = filterEmptyAssistantMessages(messages, false);
    expect(result1.length).toBe(1);
    expect(result1[0].id).toBe("assistant-1");

    // With preserveReasoningOnly=true
    const result2 = filterEmptyAssistantMessages(messages, true);
    expect(result2.length).toBe(1);
    expect(result2[0].id).toBe("assistant-1");
  });

  it("should filter out assistant messages with only empty text regardless of preserveReasoningOnly", () => {
    const messages: MuxMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "" }],
        metadata: { timestamp: 2000 },
      },
    ];

    // With preserveReasoningOnly=false
    const result1 = filterEmptyAssistantMessages(messages, false);
    expect(result1.length).toBe(0);

    // With preserveReasoningOnly=true
    const result2 = filterEmptyAssistantMessages(messages, true);
    expect(result2.length).toBe(0);
  });

  it("should preserve messages interrupted during thinking phase when preserveReasoningOnly=true", () => {
    // Simulates an interrupted stream during Extended Thinking
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Solve this problem" }],
        metadata: { timestamp: 1000 },
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "reasoning", text: "Let me analyze this step by step..." }],
        metadata: { timestamp: 2000, partial: true },
      },
    ];

    // When thinking is disabled, filter out reasoning-only message
    const result1 = filterEmptyAssistantMessages(messages, false);
    expect(result1.length).toBe(1);
    expect(result1[0].id).toBe("user-1");

    // When thinking is enabled, preserve it for API compliance
    const result2 = filterEmptyAssistantMessages(messages, true);
    expect(result2.length).toBe(2);
    expect(result2[1].id).toBe("assistant-1");
    expect(result2[1].metadata?.partial).toBe(true);
  });
});

describe("injectFileChangeNotifications", () => {
  it("should return messages unchanged when no file attachments provided", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
        metadata: { timestamp: 1000 },
      },
    ];

    const result = injectFileChangeNotifications(messages, undefined);
    expect(result).toEqual(messages);

    const result2 = injectFileChangeNotifications(messages, []);
    expect(result2).toEqual(messages);
  });

  it("should append synthetic user message with file change notification", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Fix this code" }],
        metadata: { timestamp: 1000 },
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "I'll fix it" }],
        metadata: { timestamp: 2000 },
      },
    ];

    const changedFiles = [
      {
        type: "edited_text_file" as const,
        filename: "src/app.ts",
        snippet: "@@ -10,3 +10,3 @@\n-const x = 1\n+const x = 2",
      },
    ];

    const result = injectFileChangeNotifications(messages, changedFiles);

    expect(result.length).toBe(3);
    expect(result[0]).toEqual(messages[0]);
    expect(result[1]).toEqual(messages[1]);

    const syntheticMsg = result[2];
    expect(syntheticMsg.role).toBe("user");
    expect(syntheticMsg.metadata?.synthetic).toBe(true);
    expect(syntheticMsg.id).toMatch(/^file-change-/);
    expect(syntheticMsg.parts[0]).toMatchObject({
      type: "text",
    });
    const text = (syntheticMsg.parts[0] as { type: "text"; text: string }).text;
    expect(text).toContain("<system-file-update>");
    expect(text).toContain("src/app.ts was modified");
    expect(text).toContain("@@ -10,3 +10,3 @@");
  });

  it("should handle multiple file changes", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
        metadata: { timestamp: 1000 },
      },
    ];

    const changedFiles = [
      {
        type: "edited_text_file" as const,
        filename: "src/foo.ts",
        snippet: "diff1",
      },
      {
        type: "edited_text_file" as const,
        filename: "src/bar.ts",
        snippet: "diff2",
      },
    ];

    const result = injectFileChangeNotifications(messages, changedFiles);

    expect(result.length).toBe(2);
    const text = (result[1].parts[0] as { type: "text"; text: string }).text;
    expect(text).toContain("src/foo.ts was modified");
    expect(text).toContain("src/bar.ts was modified");
    expect(text).toContain("diff1");
    expect(text).toContain("diff2");
  });
});
