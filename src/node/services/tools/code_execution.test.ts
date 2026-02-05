/**
 * Tests for code_execution tool
 */

import { describe, it, expect, mock } from "bun:test";
import { createCodeExecutionTool, clearTypeCaches } from "./code_execution";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { ToolBridge } from "@/node/services/ptc/toolBridge";
import type { Tool, ToolCallOptions } from "ai";
import type { PTCEvent, PTCExecutionResult } from "@/node/services/ptc/types";
import { z } from "zod";

const mockToolCallOptions: ToolCallOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

/**
 * Realistic mock result shapes matching actual tool result schemas.
 */
const mockResults = {
  file_read: {
    success: true as const,
    content: "mock file content",
    file_size: 100,
    modifiedTime: "2025-01-01T00:00:00Z",
    lines_read: 5,
  },
  bash: {
    success: true as const,
    output: "mock output",
    exitCode: 0,
    wall_duration_ms: 10,
  },
};

// Create a mock tool for testing - accepts sync functions
function createMockTool(
  name: string,
  schema: z.ZodType,
  executeFn?: (args: unknown) => unknown
): Tool {
  const defaultResult = mockResults[name as keyof typeof mockResults];
  const tool: Tool = {
    description: `Mock ${name} tool`,
    inputSchema: schema,
    execute: executeFn
      ? (args) => Promise.resolve(executeFn(args))
      : () => Promise.resolve(defaultResult ?? { success: true }),
  };
  return tool;
}

describe("createCodeExecutionTool", () => {
  const runtimeFactory = new QuickJSRuntimeFactory();

  describe("tool creation", () => {
    it("creates tool with description containing available tools", async () => {
      const mockTools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() }), () => ({
          content: "test",
        })),
        bash: createMockTool("bash", z.object({ script: z.string() }), () => ({ output: "ok" })),
      };

      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));

      const desc = (tool as { description?: string }).description ?? "";
      // Description now contains TypeScript definitions instead of prose
      expect(desc).toContain("function file_read");
      expect(desc).toContain("function bash");
    });

    it("excludes UI-specific tools from description", async () => {
      const mockTools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() }), () => ({
          content: "test",
        })),
        todo_write: createMockTool("todo_write", z.object({ todos: z.array(z.string()) }), () => ({
          success: true,
        })),
        status_set: createMockTool("status_set", z.object({ message: z.string() }), () => ({
          success: true,
        })),
      };

      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));

      const desc = (tool as { description?: string }).description ?? "";
      // Description now contains TypeScript definitions
      expect(desc).toContain("function file_read");
      expect(desc).not.toContain("function todo_write");
      expect(desc).not.toContain("function status_set");
    });

    it("excludes provider-native tools without execute function", async () => {
      const mockTools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() }), () => ({
          content: "test",
        })),
        web_search: {
          description: "Provider-native search",
          inputSchema: z.object({ query: z.string() }),
          // No execute function - provider handles this
        } satisfies Tool,
      };

      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));

      const desc = (tool as { description?: string }).description ?? "";
      // Description now contains TypeScript definitions
      expect(desc).toContain("function file_read");
      expect(desc).not.toContain("function web_search");
    });
  });

  describe("static analysis", () => {
    it("rejects code with syntax errors", async () => {
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge({}));

      const result = (await tool.execute!(
        { code: "const x = {" }, // Unclosed brace
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain("Code analysis failed");
    });

    it("includes line numbers for syntax errors with invalid tokens", async () => {
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge({}));

      // Invalid token @ on line 2 - parser detects it on the exact line
      const result = (await tool.execute!(
        { code: "const x = 1;\nconst y = @;\nconst z = 3;" },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain("Code analysis failed");
      expect(result.error).toContain("(line 2)");
    });

    it("rejects code using unavailable globals", async () => {
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge({}));

      const result = (await tool.execute!(
        { code: "const env = process.env" },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain("Code analysis failed");
      expect(result.error).toContain("process");
    });

    it("includes line numbers for unavailable globals", async () => {
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge({}));

      const result = (await tool.execute!(
        { code: "const x = 1;\nconst y = 2;\nconst env = process.env" }, // process on line 3
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain("(line 3)");
    });

    it("rejects code using require()", async () => {
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge({}));

      const result = (await tool.execute!(
        { code: 'const fs = require("fs")' },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain("Code analysis failed");
      expect(result.error).toContain("require");
    });

    it("does not reject 'require(' inside string literals", async () => {
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge({}));

      const result = (await tool.execute!(
        {
          code: 'return "this is a string containing require(fs) but should be allowed"',
        },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(true);
      expect(result.result).toContain("require(");
    });

    it("does not reject 'import(' inside string literals", async () => {
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge({}));

      const result = (await tool.execute!(
        { code: 'return `this is a template string containing import("fs")`' },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(true);
      expect(result.result).toContain("import(");
    });

    it("rejects code using dynamic import()", async () => {
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge({}));

      const result = (await tool.execute!(
        { code: 'return import("fs")' },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain("Code analysis failed");
      expect(result.error).toContain("Dynamic import() is not available");
    });

    it("includes line and column numbers for type errors", async () => {
      const mockTools: Record<string, Tool> = {
        bash: createMockTool("bash", z.object({ script: z.string() })),
      };
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));

      const result = (await tool.execute!(
        { code: "const x = 1;\nconst result = mux.bash({ scriptz: 'ls' });" }, // typo on line 2
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain("Code analysis failed");
      expect(result.error).toContain("scriptz");
      expect(result.error).toContain("(line 2, col");
    });

    it("includes line and column for calling non-existent tools", async () => {
      const mockTools: Record<string, Tool> = {
        bash: createMockTool("bash", z.object({ script: z.string() })),
      };
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));

      const result = (await tool.execute!(
        { code: "const x = 1;\nconst y = 2;\nmux.nonexistent({ arg: 1 });" }, // line 3
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain("Code analysis failed");
      expect(result.error).toContain("(line 3, col");
    });
  });

  describe("code execution", () => {
    it("executes simple code and returns result", async () => {
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge({}));

      const result = (await tool.execute!(
        { code: "return 1 + 2" },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(true);
      expect(result.result).toBe(3);
    });

    it("captures console.log output", async () => {
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge({}));

      const result = (await tool.execute!(
        { code: 'console.log("hello", 123); return "done"' },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(true);
      expect(result.result).toBe("done");
      expect(result.consoleOutput).toHaveLength(1);
      expect(result.consoleOutput[0].level).toBe("log");
      expect(result.consoleOutput[0].args).toEqual(["hello", 123]);
    });

    it("records tool execution time", async () => {
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge({}));

      const result = (await tool.execute!(
        { code: "return 42" },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(true);
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });
  });

  describe("tool bridge integration", () => {
    it("calls bridged tools and returns results", async () => {
      const mockExecute = mock((args: unknown) => {
        const { filePath } = args as { filePath: string };
        return {
          success: true as const,
          content: `Content of ${filePath}`,
          file_size: 100,
          modifiedTime: "2025-01-01T00:00:00Z",
          lines_read: 1,
        };
      });

      const mockTools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() }), mockExecute),
      };

      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));

      const result = (await tool.execute!(
        { code: 'return mux.file_read({ filePath: "test.txt" })' },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(true);
      expect(result.result).toMatchObject({
        content: "Content of test.txt",
        success: true,
      });
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it("records tool calls in result", async () => {
      const mockTools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() })),
      };

      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));

      const result = (await tool.execute!(
        { code: 'mux.file_read({ filePath: "a.txt" }); return "done"' },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(true);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].toolName).toBe("file_read");
      expect(result.toolCalls[0].args).toEqual({ filePath: "a.txt" });
      expect(result.toolCalls[0].result).toMatchObject({
        content: "mock file content",
        success: true,
      });
      expect(result.toolCalls[0].duration_ms).toBeGreaterThanOrEqual(0);
    });

    it("validates tool arguments against schema", async () => {
      const mockTools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() })),
      };

      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));

      const result = (await tool.execute!(
        { code: "return mux.file_read({ wrongField: 123 })" },
        mockToolCallOptions
      )) as PTCExecutionResult;

      // Now caught by TypeScript type validation at compile time, not runtime
      expect(result.success).toBe(false);
      // Error message contains TypeScript diagnostic (e.g., "filePath" required)
      expect(result.error).toContain("Code analysis failed");
    });

    it("handles tool execution errors gracefully", async () => {
      const mockTools: Record<string, Tool> = {
        failing_tool: createMockTool("failing_tool", z.object({}), () => {
          throw new Error("Tool failed!");
        }),
      };

      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));

      const result = (await tool.execute!(
        { code: "return mux.failing_tool({})" },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain("Tool failed!");
      // Should still record the failed tool call
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].error).toContain("Tool failed!");
    });

    it("returns partial results when execution fails mid-way", async () => {
      let callCount = 0;
      const mockTools: Record<string, Tool> = {
        counter: createMockTool("counter", z.object({}), () => {
          callCount++;
          if (callCount === 2) {
            throw new Error("Second call failed");
          }
          return { count: callCount };
        }),
      };

      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));

      const result = (await tool.execute!(
        {
          code: `
            mux.counter({});
            mux.counter({}); // This one fails
            mux.counter({}); // Never reached
            return "done";
          `,
        },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(false);
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0].result).toEqual({ count: 1 });
      expect(result.toolCalls[1].error).toContain("Second call failed");
    });
  });

  describe("event streaming", () => {
    it("emits events for tool calls", async () => {
      const events: PTCEvent[] = [];
      const onEvent = (event: PTCEvent) => events.push(event);

      const mockTools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() }), () => ({
          content: "test",
        })),
      };

      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(mockTools),
        onEvent
      );

      await tool.execute!(
        { code: 'return mux.file_read({ filePath: "test.txt" })' },
        mockToolCallOptions
      );

      const toolCallEvents = events.filter(
        (e) => e.type === "tool-call-start" || e.type === "tool-call-end"
      );
      expect(toolCallEvents).toHaveLength(2);
      expect(toolCallEvents[0].type).toBe("tool-call-start");
      expect(toolCallEvents[1].type).toBe("tool-call-end");
    });

    it("emits events for console output", async () => {
      const events: PTCEvent[] = [];
      const onEvent = (event: PTCEvent) => events.push(event);

      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge({}), onEvent);

      await tool.execute!(
        { code: 'console.log("test"); console.warn("warning"); return 1' },
        mockToolCallOptions
      );

      const consoleEvents = events.filter((e) => e.type === "console");
      expect(consoleEvents).toHaveLength(2);
      expect(consoleEvents[0].level).toBe("log");
      expect(consoleEvents[1].level).toBe("warn");
    });
  });

  describe("abort handling", () => {
    it("aborts execution when signal is triggered", async () => {
      const mockTools: Record<string, Tool> = {
        slow_tool: createMockTool("slow_tool", z.object({}), async () => {
          // Simulate slow operation
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { done: true };
        }),
      };

      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));
      const abortController = new AbortController();

      // Abort immediately
      abortController.abort();

      const result = (await tool.execute!(
        { code: "return mux.slow_tool({})" },
        { toolCallId: "test-1", messages: [], abortSignal: abortController.signal }
      )) as PTCExecutionResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain("abort");
    });
  });

  describe("type caching", () => {
    it("returns consistent types for same tool set", async () => {
      clearTypeCaches();

      const mockTools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() }), () => ({
          content: "test",
        })),
      };

      const tool1 = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));
      const tool2 = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));

      const desc1 = (tool1 as { description?: string }).description ?? "";
      const desc2 = (tool2 as { description?: string }).description ?? "";

      expect(desc1).toBe(desc2);
      expect(desc1).toContain("function file_read");
    });

    it("regenerates types when tool set changes", async () => {
      clearTypeCaches();

      const tools1: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() }), () => ({
          content: "test",
        })),
      };
      const tools2: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() }), () => ({
          content: "test",
        })),
        bash: createMockTool("bash", z.object({ script: z.string() }), () => ({
          output: "ok",
        })),
      };

      const tool1 = await createCodeExecutionTool(runtimeFactory, new ToolBridge(tools1));
      const tool2 = await createCodeExecutionTool(runtimeFactory, new ToolBridge(tools2));

      const desc1 = (tool1 as { description?: string }).description ?? "";
      const desc2 = (tool2 as { description?: string }).description ?? "";

      expect(desc1).not.toBe(desc2);
      expect(desc1).not.toContain("function bash");
      expect(desc2).toContain("function bash");
    });

    it("clearTypeCaches forces regeneration", async () => {
      const mockTools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() }), () => ({
          content: "test",
        })),
      };

      // First call to populate cache
      await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));

      // Clear and verify new generation works
      clearTypeCaches();

      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));
      const desc = (tool as { description?: string }).description ?? "";
      expect(desc).toContain("function file_read");
    });
  });
});
