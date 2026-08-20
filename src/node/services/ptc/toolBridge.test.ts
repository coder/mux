/**
 * Tests for ToolBridge
 */

import { describe, it, expect, mock } from "bun:test";
import { ToolBridge } from "./toolBridge";
import type { Tool } from "ai";
import type { IJSRuntime, RuntimeLimits } from "./runtime";
import type { PTCEvent, PTCExecutionResult } from "./types";
import { z } from "zod";

// Helper to create a mock runtime for testing
function createMockRuntime(overrides: Partial<IJSRuntime> = {}): IJSRuntime {
  const defaultResult: PTCExecutionResult = {
    success: true,
    result: undefined,
    toolCalls: [],
    consoleOutput: [],
    duration_ms: 0,
  };

  return {
    eval: mock(() => Promise.resolve(defaultResult)),
    registerFunction: mock((_name: string, _fn: () => Promise<unknown>) => undefined),
    registerObject: mock(
      (_name: string, _obj: Record<string, () => Promise<unknown>>) => undefined
    ),
    registerPromiseFunction: mock((_name: string, _fn: () => Promise<unknown>) => undefined),
    registerSyncFunction: mock((_name: string, _fn: () => unknown) => undefined),
    setPendingJobGate: mock((_gate: (run: () => void) => void) => undefined),
    setLimits: mock((_limits: RuntimeLimits) => undefined),
    onEvent: mock((_handler: (event: PTCEvent) => void) => undefined),
    abort: mock(() => undefined),
    getAbortSignal: mock(() => undefined),
    dispose: mock(() => undefined),
    [Symbol.dispose]: mock(() => undefined),
    ...overrides,
  };
}

// Create a mock tool for testing - executeFn can be sync, will be wrapped
function createMockTool(
  name: string,
  schema: z.ZodType,
  executeFn?: (args: unknown) => unknown
): Tool {
  const tool: Tool = {
    description: `Mock ${name} tool`,
    inputSchema: schema,
    ...(executeFn ? { execute: (args) => Promise.resolve(executeFn(args)) } : {}),
  };
  return tool;
}

describe("ToolBridge", () => {
  describe("constructor", () => {
    it("filters out excluded tools", () => {
      const tools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({}), () => ({})),
        code_execution: createMockTool("code_execution", z.object({}), () => ({})),
        ask_user_question: createMockTool("ask_user_question", z.object({}), () => ({})),
        propose_plan: createMockTool("propose_plan", z.object({}), () => ({})),
        todo_write: createMockTool("todo_write", z.object({}), () => ({})),
        todo_read: createMockTool("todo_read", z.object({}), () => ({})),
        status_set: createMockTool("status_set", z.object({}), () => ({})),
      };

      const bridge = new ToolBridge(tools);
      const names = bridge.getBridgeableToolNames();

      expect(names).toEqual(["file_read"]);
      expect(names).not.toContain("code_execution");
      expect(names).not.toContain("ask_user_question");
      expect(names).not.toContain("propose_plan");
      expect(names).not.toContain("todo_write");
      expect(names).not.toContain("todo_read");
      expect(names).not.toContain("status_set");
    });

    it("filters out tools without execute function", () => {
      const tools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({}), () => ({})),
        web_search: createMockTool("web_search", z.object({})), // No execute
      };

      const bridge = new ToolBridge(tools);
      const names = bridge.getBridgeableToolNames();

      expect(names).toEqual(["file_read"]);
      expect(names).not.toContain("web_search");
    });
  });

  describe("getBridgeableToolNames", () => {
    it("returns list of bridgeable tool names", () => {
      const tools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({}), () => ({})),
        bash: createMockTool("bash", z.object({}), () => ({})),
        web_fetch: createMockTool("web_fetch", z.object({}), () => ({})),
      };

      const bridge = new ToolBridge(tools);
      const names = bridge.getBridgeableToolNames();

      expect(names).toHaveLength(3);
      expect(names).toContain("file_read");
      expect(names).toContain("bash");
      expect(names).toContain("web_fetch");
    });
  });

  describe("register", () => {
    it("registers the same tools object under xum and mux", () => {
      const mockRegisterObject = mock(
        (_name: string, _obj: Record<string, () => Promise<unknown>>) => undefined
      );
      const mockRuntime = createMockRuntime({ registerObject: mockRegisterObject });

      const tools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({}), () => ({})),
      };

      const bridge = new ToolBridge(tools);
      bridge.register(mockRuntime);

      expect(mockRegisterObject).toHaveBeenCalledTimes(2);
      const calls = mockRegisterObject.mock.calls as unknown as Array<
        [string, Record<string, unknown>]
      >;
      expect(calls.map(([name]) => name)).toEqual(["xum", "mux"]);
      const [, xumObj] = calls[0];
      const [, muxObj] = calls[1];
      expect(muxObj).toBe(xumObj);
      expect(typeof xumObj.file_read).toBe("function");
    });

    it("enforces capability grants: denied tools are excluded, stubbed, and never leak", async () => {
      const executed = mock(() => ({ result: "ok" }));
      const tools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({}), executed),
        bash: createMockTool("bash", z.object({}), executed),
      };

      const bridge = new ToolBridge(tools, {
        version: 1,
        bridgeTools: { allow: ["file_read"] },
        vars: false,
        hostEvents: false,
      });

      // Denied tool is not advertised as bridgeable...
      expect(bridge.getBridgeableToolNames()).toEqual(["file_read"]);
      // ...and must not leak into the model-visible non-bridgeable set either.
      expect(Object.keys(bridge.getNonBridgeableTools())).toEqual([]);

      let registeredMux: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      const mockRegisterObject = mock(
        (name: string, obj: Record<string, (...args: unknown[]) => Promise<unknown>>) => {
          if (name === "mux") registeredMux = obj;
          return undefined;
        }
      );
      bridge.register(createMockRuntime({ registerObject: mockRegisterObject }));

      // Granted tool executes.
      const fileRead = registeredMux.file_read as (...args: unknown[]) => Promise<unknown>;
      await fileRead({});
      expect(executed).toHaveBeenCalledTimes(1);

      // Denied tool is stubbed with a clear capability error, not a crash.
      const bash = registeredMux.bash as (...args: unknown[]) => Promise<unknown>;
      try {
        await bash({});
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(String(e)).toContain("Capability denied: xum.bash is not granted");
      }
      expect(executed).toHaveBeenCalledTimes(1); // bash never ran
    });

    it("validates arguments before executing tool", async () => {
      const mockExecute = mock(() => ({ result: "ok" }));

      const tools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() }), mockExecute),
      };

      const bridge = new ToolBridge(tools);

      // Create a simple mock runtime that captures registered functions
      let registeredMux: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      const mockRegisterObject = mock(
        (name: string, obj: Record<string, (...args: unknown[]) => Promise<unknown>>) => {
          if (name === "mux") registeredMux = obj;
          return undefined;
        }
      );
      const mockRuntime = createMockRuntime({ registerObject: mockRegisterObject });

      bridge.register(mockRuntime);

      // Call with invalid args - should throw
      // Type assertion needed because Record indexing returns T | undefined for ESLint
      const fileRead = registeredMux.file_read as (...args: unknown[]) => Promise<unknown>;
      try {
        await fileRead({ wrongField: "test" });
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(String(e)).toContain("Invalid arguments for file_read");
      }

      // Call with valid args - should succeed
      await fileRead({ filePath: "test.txt" });
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it("serializes non-JSON values", async () => {
      // Tool that returns a non-plain object (with circular reference)
      const circularObj: Record<string, unknown> = { a: 1 };
      circularObj.self = circularObj;

      const mockExecute = mock(() => circularObj);

      const tools: Record<string, Tool> = {
        circular: createMockTool("circular", z.object({}), mockExecute),
      };

      const bridge = new ToolBridge(tools);

      let registeredMux: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      const mockRegisterObject = mock(
        (name: string, obj: Record<string, () => Promise<unknown>>) => {
          if (name === "mux") registeredMux = obj;
          return undefined;
        }
      );
      const mockRuntime = createMockRuntime({ registerObject: mockRegisterObject });

      bridge.register(mockRuntime);

      const result = await registeredMux.circular({});
      expect(result).toEqual({ error: "Result not JSON-serializable" });
    });

    it("uses runtime abort signal for tool cancellation", async () => {
      const mockExecute = mock((_args: unknown) => ({ result: "ok" }));

      const tools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() }), mockExecute),
      };

      const bridge = new ToolBridge(tools);

      let registeredMux: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      const mockRegisterObject = mock(
        (name: string, obj: Record<string, () => Promise<unknown>>) => {
          if (name === "mux") registeredMux = obj;
          return undefined;
        }
      );
      // Provide an abort signal via getAbortSignal
      const abortController = new AbortController();
      const mockRuntime = createMockRuntime({
        registerObject: mockRegisterObject,
        getAbortSignal: () => abortController.signal,
      });

      bridge.register(mockRuntime);

      await registeredMux.file_read({ filePath: "test.txt" });
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it("throws if runtime abort signal is already aborted", async () => {
      const mockExecute = mock(() => ({ result: "ok" }));

      const tools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() }), mockExecute),
      };

      const bridge = new ToolBridge(tools);

      let registeredMux: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      const mockRegisterObject = mock(
        (name: string, obj: Record<string, (...args: unknown[]) => Promise<unknown>>) => {
          if (name === "mux") registeredMux = obj;
          return undefined;
        }
      );

      // Pre-abort the signal
      const abortController = new AbortController();
      abortController.abort();
      const mockRuntime = createMockRuntime({
        registerObject: mockRegisterObject,
        getAbortSignal: () => abortController.signal,
      });

      bridge.register(mockRuntime);

      // Type assertion needed because Record indexing returns T | undefined for ESLint
      const fileRead = registeredMux.file_read as (...args: unknown[]) => Promise<unknown>;
      try {
        await fileRead({ filePath: "test.txt" });
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(String(e)).toContain("Execution aborted");
      }
      expect(mockExecute).not.toHaveBeenCalled();
    });
  });
});
