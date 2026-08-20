/**
 * Tests for code_execution tool
 */

import { describe, it, expect, mock } from "bun:test";
import {
  createCodeExecutionTool,
  retargetCodeExecutionTool,
  clearTypeCaches,
  type MountRunner,
} from "./code_execution";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { ToolBridge } from "@/node/services/ptc/toolBridge";
import type { Tool, ToolExecutionOptions } from "ai";
import type { PTCEvent, PTCExecutionResult } from "@/node/services/ptc/types";
import { z } from "zod";
import { DisposableTempDir } from "@/node/services/tempDir";
import { SandboxHostService } from "@/node/services/sandbox/sandboxHostService";

const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
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
      expect(desc).toContain("declare namespace shux");
      expect(desc).toContain("declare const mux: typeof shux");
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

    it("surfaces runtime validation errors for wrong tool args", async () => {
      const mockTools: Record<string, Tool> = {
        bash: createMockTool("bash", z.object({ script: z.string() })),
      };
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));

      const result = (await tool.execute!(
        { code: "const x = 1;\nconst result = mux.bash({ scriptz: 'ls' });" },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(false);
      expect(result.error).not.toContain("Code analysis failed");
      expect(result.error).toContain("script");
    });

    it("surfaces runtime errors for calling non-existent tools", async () => {
      const mockTools: Record<string, Tool> = {
        bash: createMockTool("bash", z.object({ script: z.string() })),
      };
      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));

      const result = (await tool.execute!(
        { code: "const x = 1;\nconst y = 2;\nmux.nonexistent({ arg: 1 });" },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(false);
      expect(result.error).not.toContain("Code analysis failed");
      expect(result.error).toMatch(/nonexistent|not a function/i);
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

      for (const ns of ["shux", "mux"] as const) {
        const result = (await tool.execute!(
          { code: `return ${ns}.file_read({ filePath: "test.txt" })` },
          mockToolCallOptions
        )) as PTCExecutionResult;

        expect(result.success).toBe(true);
        expect(result.result).toMatchObject({
          content: "Content of test.txt",
          success: true,
        });
      }
      expect(mockExecute).toHaveBeenCalledTimes(2);
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

    it("validates tool arguments against schema at runtime", async () => {
      const mockTools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() })),
      };

      const tool = await createCodeExecutionTool(runtimeFactory, new ToolBridge(mockTools));

      const result = (await tool.execute!(
        { code: "return mux.file_read({ wrongField: 123 })" },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(false);
      expect(result.error).not.toContain("Code analysis failed");
      expect(result.error).toMatch(/filePath|required|validation/i);
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

  describe("retargetCodeExecutionTool", () => {
    it("retargets a captured execute reference onto the donor's bridge", async () => {
      // The request.assemble wrapper scenario: middleware captured the
      // pre-hook instance's execute, while a later rebuild removed `bash`
      // from the bridgeable set. After retargeting, the captured reference
      // must dispatch through the donor's bridge — bash is gone, file_read
      // still works.
      const bashExecute = mock(() => mockResults.bash);
      const preHookTool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge({
          bash: createMockTool("bash", z.object({ script: z.string() }), bashExecute),
          file_read: createMockTool("file_read", z.object({ filePath: z.string() })),
        })
      );
      const donorTool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge({
          file_read: createMockTool("file_read", z.object({ filePath: z.string() })),
        })
      );

      // Wrapper-style capture BEFORE the retarget.
      const capturedExecute = preHookTool.execute!.bind(preHookTool);

      expect(retargetCodeExecutionTool(preHookTool, donorTool)).toBe(true);

      const bashResult = (await capturedExecute(
        { code: 'return mux.bash({ script: "echo hi" })' },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(bashResult.success).toBe(false);
      expect(bashExecute).not.toHaveBeenCalled();

      const readResult = (await capturedExecute(
        { code: 'return mux.file_read({ filePath: "a.txt" })' },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(readResult.success).toBe(true);
      expect(readResult.result).toMatchObject({ content: "mock file content" });
    });

    it("returns false when either tool was not created by the factory", async () => {
      const realTool = await createCodeExecutionTool(runtimeFactory, new ToolBridge({}));
      const foreignTool = createMockTool("bash", z.object({ script: z.string() }));

      expect(retargetCodeExecutionTool(foreignTool, realTool)).toBe(false);
      expect(retargetCodeExecutionTool(realTool, foreignTool)).toBe(false);

      // The real tool stays functional after rejected retargets.
      const result = (await realTool.execute!(
        { code: "return 7" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(result.success).toBe(true);
      expect(result.result).toBe(7);
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
        {
          toolCallId: "test-1",
          messages: [],
          context: undefined,
          abortSignal: abortController.signal,
        }
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

    it("persistent mount shares vars across two separate code_execution calls and a simulated restart", async () => {
      using tmp = new DisposableTempDir("code-exec-persistent");
      const host = new SandboxHostService();
      const mountProvider: MountRunner = (fn) =>
        host.withPersistentMount(
          {
            lifetime: "persistent",
            runtimeFactory,
            scopeKey: "ws-code-exec",
            sessionDir: tmp.path,
          },
          fn
        );
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge({}),
        undefined,
        mountProvider
      );

      // Call 1 writes vars; call 2 (a separate tool call) reads them.
      const first = (await tool.execute!(
        { code: "vars.total = 40; return vars.total;" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(first.success).toBe(true);
      expect(first.result).toBe(40);

      const second = (await tool.execute!(
        { code: "vars.total += 2; return vars.total;" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(second.success).toBe(true);
      expect(second.result).toBe(42);

      // Simulated restart: fresh host restores the per-call snapshot.
      await host.disposeScope("ws-code-exec");
      const host2 = new SandboxHostService();
      const tool2 = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge({}),
        undefined,
        (fn) =>
          host2.withPersistentMount(
            {
              lifetime: "persistent",
              runtimeFactory,
              scopeKey: "ws-code-exec",
              sessionDir: tmp.path,
            },
            fn
          )
      );
      const third = (await tool2.execute!(
        { code: "return vars.total;" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(third.success).toBe(true);
      expect(third.result).toBe(42);
      await host2.disposeScope("ws-code-exec");
    });

    it("persists vars mutated before a failed eval so memory and disk agree", async () => {
      using tmp = new DisposableTempDir("code-exec-persistent");
      const host = new SandboxHostService();
      const mountProvider: MountRunner = (fn) =>
        host.withPersistentMount(
          {
            lifetime: "persistent",
            runtimeFactory,
            scopeKey: "ws-failed-eval",
            sessionDir: tmp.path,
          },
          fn
        );
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge({}),
        undefined,
        mountProvider
      );

      const seed = (await tool.execute!(
        { code: "vars.state = 'initial'; return vars.state;" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(seed.success).toBe(true);

      // Guest mutates vars, THEN throws: the live guest keeps the mutation,
      // so the snapshot must too — a restart must not resurrect 'initial'.
      const failed = (await tool.execute!(
        { code: "vars.state = 'mutated-before-throw'; throw new Error('boom');" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(failed.success).toBe(false);

      // Simulated restart: fresh host restores the latest snapshot.
      await host.disposeScope("ws-failed-eval");
      const host2 = new SandboxHostService();
      const tool2 = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge({}),
        undefined,
        (fn) =>
          host2.withPersistentMount(
            {
              lifetime: "persistent",
              runtimeFactory,
              scopeKey: "ws-failed-eval",
              sessionDir: tmp.path,
            },
            fn
          )
      );
      const after = (await tool2.execute!(
        { code: "return vars.state;" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(after.success).toBe(true);
      expect(after.result).toBe("mutated-before-throw");
      await host2.disposeScope("ws-failed-eval");
    });

    it("recovers from unsnapshottable vars by rebuilding the mount from the last durable snapshot", async () => {
      using tmp = new DisposableTempDir("code-exec-persistent");
      const host = new SandboxHostService();
      const mountProvider: MountRunner = (fn) =>
        host.withPersistentMount(
          {
            lifetime: "persistent",
            runtimeFactory,
            scopeKey: "ws-cyclic-vars",
            sessionDir: tmp.path,
          },
          fn
        );
      const tool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge({}),
        undefined,
        mountProvider
      );

      const seed = (await tool.execute!(
        { code: "vars.state = 'durable'; return vars.state;" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(seed.success).toBe(true);

      // Guest makes vars cyclic (unsnapshottable) and throws: the snapshot
      // fails, so the live mount must be disposed rather than kept with state
      // that disk can never reflect.
      const poisoned = (await tool.execute!(
        { code: "vars.self = vars; throw new Error('boom');" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(poisoned.success).toBe(false);

      // Next call rebuilds the mount from the last durable snapshot: the
      // cyclic mutation is gone, the seeded value is restored.
      const recovered = (await tool.execute!(
        { code: "return { state: vars.state, self: typeof vars.self };" },
        mockToolCallOptions
      )) as PTCExecutionResult;
      expect(recovered.success).toBe(true);
      expect(recovered.result).toEqual({ state: "durable", self: "undefined" });
      await host.disposeScope("ws-cyclic-vars");
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
