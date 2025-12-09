import { describe, it, expect } from "bun:test";
import { createStatusSetTool } from "./status_set";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import type { ToolCallOptions } from "ai";
import { STATUS_MESSAGE_MAX_LENGTH } from "@/common/constants/toolLimits";

describe("status_set tool validation", () => {
  const mockConfig: ToolConfiguration = {
    cwd: "/test",
    runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
    runtimeTempDir: "/tmp",
    workspaceId: "test-workspace",
  };

  const mockToolCallOptions: ToolCallOptions = {
    toolCallId: "test-call-id",
    messages: [],
  };

  describe("emoji validation", () => {
    it("should accept single emoji characters", async () => {
      const tool = createStatusSetTool(mockConfig);

      const emojis = ["🔍", "📝", "✅", "🚀", "⏳"];
      for (const emoji of emojis) {
        const result = (await tool.execute!({ emoji, message: "Test" }, mockToolCallOptions)) as {
          success: boolean;
          emoji: string;
          message: string;
        };
        expect(result).toEqual({ success: true, emoji, message: "Test" });
      }
    });

    it("should accept emojis with variation selectors", async () => {
      const tool = createStatusSetTool(mockConfig);

      // Emojis with variation selectors (U+FE0F)
      const emojis = ["✏️", "✅", "➡️", "☀️"];
      for (const emoji of emojis) {
        const result = (await tool.execute!({ emoji, message: "Test" }, mockToolCallOptions)) as {
          success: boolean;
          emoji: string;
          message: string;
        };
        expect(result).toEqual({ success: true, emoji, message: "Test" });
      }
    });

    it("should accept emojis with skin tone modifiers", async () => {
      const tool = createStatusSetTool(mockConfig);

      const emojis = ["👋🏻", "👋🏽", "👋🏿"];
      for (const emoji of emojis) {
        const result = (await tool.execute!({ emoji, message: "Test" }, mockToolCallOptions)) as {
          success: boolean;
          emoji: string;
          message: string;
        };
        expect(result).toEqual({ success: true, emoji, message: "Test" });
      }
    });

    it("should reject multiple emojis", async () => {
      const tool = createStatusSetTool(mockConfig);

      const result1 = (await tool.execute!(
        { emoji: "🔍📝", message: "Test" },
        mockToolCallOptions
      )) as { success: boolean; error: string };
      expect(result1.success).toBe(false);
      expect(result1.error).toBe("emoji must be a single emoji character");

      const result2 = (await tool.execute!(
        { emoji: "✅✅", message: "Test" },
        mockToolCallOptions
      )) as { success: boolean; error: string };
      expect(result2.success).toBe(false);
      expect(result2.error).toBe("emoji must be a single emoji character");
    });

    it("should reject text (non-emoji)", async () => {
      const tool = createStatusSetTool(mockConfig);

      const result1 = (await tool.execute!(
        { emoji: "a", message: "Test" },
        mockToolCallOptions
      )) as {
        success: boolean;
        error: string;
      };
      expect(result1.success).toBe(false);
      expect(result1.error).toBe("emoji must be a single emoji character");

      const result2 = (await tool.execute!(
        { emoji: "abc", message: "Test" },
        mockToolCallOptions
      )) as { success: boolean; error: string };
      expect(result2.success).toBe(false);
      expect(result2.error).toBe("emoji must be a single emoji character");

      const result3 = (await tool.execute!(
        { emoji: "!", message: "Test" },
        mockToolCallOptions
      )) as {
        success: boolean;
        error: string;
      };
      expect(result3.success).toBe(false);
      expect(result3.error).toBe("emoji must be a single emoji character");
    });

    it("should reject empty emoji", async () => {
      const tool = createStatusSetTool(mockConfig);

      const result = (await tool.execute!({ emoji: "", message: "Test" }, mockToolCallOptions)) as {
        success: boolean;
        error: string;
      };
      expect(result.success).toBe(false);
      expect(result.error).toBe("emoji must be a single emoji character");
    });

    it("should reject emoji with text", async () => {
      const tool = createStatusSetTool(mockConfig);

      const result1 = (await tool.execute!(
        { emoji: "🔍a", message: "Test" },
        mockToolCallOptions
      )) as { success: boolean; error: string };
      expect(result1.success).toBe(false);
      expect(result1.error).toBe("emoji must be a single emoji character");

      const result2 = (await tool.execute!(
        { emoji: "x🔍", message: "Test" },
        mockToolCallOptions
      )) as { success: boolean; error: string };
      expect(result2.success).toBe(false);
      expect(result2.error).toBe("emoji must be a single emoji character");
    });
  });

  describe("message validation", () => {
    it(`should accept messages up to ${STATUS_MESSAGE_MAX_LENGTH} characters`, async () => {
      const tool = createStatusSetTool(mockConfig);

      const result1 = (await tool.execute!(
        { emoji: "✅", message: "a".repeat(STATUS_MESSAGE_MAX_LENGTH) },
        mockToolCallOptions
      )) as { success: boolean; message: string };
      expect(result1.success).toBe(true);
      expect(result1.message).toBe("a".repeat(STATUS_MESSAGE_MAX_LENGTH));

      const result2 = (await tool.execute!(
        { emoji: "✅", message: "Analyzing code structure" },
        mockToolCallOptions
      )) as { success: boolean };
      expect(result2.success).toBe(true);
    });

    it(`should truncate messages longer than ${STATUS_MESSAGE_MAX_LENGTH} characters with ellipsis`, async () => {
      const tool = createStatusSetTool(mockConfig);

      // Test with MAX_LENGTH + 1 characters
      const result1 = (await tool.execute!(
        { emoji: "✅", message: "a".repeat(STATUS_MESSAGE_MAX_LENGTH + 1) },
        mockToolCallOptions
      )) as { success: boolean; message: string };
      expect(result1.success).toBe(true);
      expect(result1.message).toBe("a".repeat(STATUS_MESSAGE_MAX_LENGTH - 1) + "…");
      expect(result1.message.length).toBe(STATUS_MESSAGE_MAX_LENGTH);

      // Test with longer message
      const longMessage =
        "This is a very long message that exceeds the 60 character limit and should be truncated";
      const result2 = (await tool.execute!(
        { emoji: "✅", message: longMessage },
        mockToolCallOptions
      )) as { success: boolean; message: string };
      expect(result2.success).toBe(true);
      expect(result2.message).toBe(longMessage.slice(0, STATUS_MESSAGE_MAX_LENGTH - 1) + "…");
      expect(result2.message.length).toBe(STATUS_MESSAGE_MAX_LENGTH);
    });

    it("should accept empty message", async () => {
      const tool = createStatusSetTool(mockConfig);

      const result = (await tool.execute!({ emoji: "✅", message: "" }, mockToolCallOptions)) as {
        success: boolean;
      };
      expect(result.success).toBe(true);
    });
  });

  describe("url parameter", () => {
    it("should accept valid URLs", async () => {
      const tool = createStatusSetTool(mockConfig);

      const validUrls = [
        "https://github.com/owner/repo/pull/123",
        "http://example.com",
        "https://example.com/path/to/resource?query=param",
      ];

      for (const url of validUrls) {
        const result = (await tool.execute!(
          { emoji: "🔍", message: "Test", url },
          mockToolCallOptions
        )) as {
          success: boolean;
          url: string;
        };
        expect(result.success).toBe(true);
        expect(result.url).toBe(url);
      }
    });

    it("should work without URL parameter", async () => {
      const tool = createStatusSetTool(mockConfig);

      const result = (await tool.execute!(
        { emoji: "✅", message: "Test" },
        mockToolCallOptions
      )) as {
        success: boolean;
        url?: string;
      };
      expect(result.success).toBe(true);
      expect(result.url).toBeUndefined();
    });

    it("should omit URL from result when undefined", async () => {
      const tool = createStatusSetTool(mockConfig);

      const result = (await tool.execute!(
        { emoji: "✅", message: "Test", url: undefined },
        mockToolCallOptions
      )) as {
        success: boolean;
      };
      expect(result.success).toBe(true);
      expect("url" in result).toBe(false);
    });
  });
});
