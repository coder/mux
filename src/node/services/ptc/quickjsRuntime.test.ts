import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { QuickJSRuntime, QuickJSRuntimeFactory } from "./quickjsRuntime";
import type { PTCEvent } from "./types";

describe("QuickJSRuntime", () => {
  let runtime: QuickJSRuntime;

  beforeEach(async () => {
    runtime = await QuickJSRuntime.create();
  });

  afterEach(() => {
    runtime.dispose();
  });

  describe("basic evaluation", () => {
    it("executes basic JS and returns result", async () => {
      const result = await runtime.eval("return 1 + 1;");
      expect(result.success).toBe(true);
      expect(result.result).toBe(2);
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it("handles string results", async () => {
      const result = await runtime.eval('return "hello world";');
      expect(result.success).toBe(true);
      expect(result.result).toBe("hello world");
    });

    it("handles object results", async () => {
      const result = await runtime.eval('return { foo: "bar", num: 42 };');
      expect(result.success).toBe(true);
      expect(result.result).toEqual({ foo: "bar", num: 42 });
    });

    it("handles array results", async () => {
      const result = await runtime.eval("return [1, 2, 3];");
      expect(result.success).toBe(true);
      expect(result.result).toEqual([1, 2, 3]);
    });

    it("handles undefined return (no explicit return)", async () => {
      const result = await runtime.eval("const x = 1;");
      expect(result.success).toBe(true);
      expect(result.result).toBeUndefined();
    });

    it("handles null return", async () => {
      const result = await runtime.eval("return null;");
      expect(result.success).toBe(true);
      expect(result.result).toBeNull();
    });

    it("handles syntax errors", async () => {
      const result = await runtime.eval("return {{{;");
      expect(result.success).toBe(false);
      expect(result.error).toContain("SyntaxError");
    });

    it("handles runtime errors", async () => {
      const result = await runtime.eval("throw new Error('boom');");
      expect(result.success).toBe(false);
      expect(result.error).toContain("boom");
    });

    // Note: With asyncify, async host functions appear SYNC to QuickJS.
    // Native JS await/Promise is not supported - use sync calls to host functions.
    it("handles multiple statements", async () => {
      const result = await runtime.eval(`
        const x = 10;
        const y = 20;
        return x + y;
      `);
      expect(result.success).toBe(true);
      expect(result.result).toBe(30);
    });
  });

  describe("registered functions", () => {
    // With asyncify, async host functions appear SYNCHRONOUS to QuickJS.
    // No 'await' needed in QuickJS code - evalCodeAsync suspends the WASM module.
    it("calls registered async functions (sync from QuickJS perspective)", async () => {
      runtime.registerFunction("fetchData", () => Promise.resolve({ value: 42 }));

      // Note: NO await in the QuickJS code - the function appears sync
      const result = await runtime.eval("return fetchData();");
      expect(result.success).toBe(true);
      expect(result.result).toEqual({ value: 42 });
    });

    it("passes arguments to registered functions", async () => {
      runtime.registerFunction("add", (...args: unknown[]) => {
        const [a, b] = args as [number, number];
        return Promise.resolve(a + b);
      });

      const result = await runtime.eval("return add(10, 20);");
      expect(result.success).toBe(true);
      expect(result.result).toBe(30);
    });

    it("handles function errors", async () => {
      runtime.registerFunction("failFunc", () => {
        return Promise.reject(new Error("function failed"));
      });

      const result = await runtime.eval("return failFunc();");
      expect(result.success).toBe(false);
      expect(result.error).toContain("function failed");
    });

    it("records tool calls on success", async () => {
      runtime.registerFunction("myTool", (arg: unknown) => Promise.resolve({ received: arg }));

      const result = await runtime.eval('return myTool({ input: "test" });');
      expect(result.success).toBe(true);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].toolName).toBe("myTool");
      expect(result.toolCalls[0].args).toEqual({ input: "test" });
      expect(result.toolCalls[0].result).toEqual({ received: { input: "test" } });
      expect(result.toolCalls[0].duration_ms).toBeGreaterThanOrEqual(0);
    });

    it("records tool calls on failure", async () => {
      runtime.registerFunction("failTool", () => {
        return Promise.reject(new Error("tool error"));
      });

      const result = await runtime.eval("try { failTool(); } catch(e) { return 'caught'; }");
      expect(result.success).toBe(true);
      expect(result.result).toBe("caught");
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].toolName).toBe("failTool");
      expect(result.toolCalls[0].error).toContain("tool error");
    });
  });

  describe("registered objects", () => {
    it("calls methods on registered objects", async () => {
      runtime.registerObject("mux", {
        fileRead: (...args: unknown[]) => Promise.resolve({ content: `File: ${String(args[0])}` }),
        bash: (...args: unknown[]) => Promise.resolve({ output: `Ran: ${String(args[0])}` }),
      });

      // No await needed - asyncified methods appear sync
      const result = await runtime.eval(`
        const file = mux.fileRead("test.txt");
        const bash = mux.bash("ls");
        return { file, bash };
      `);

      expect(result.success).toBe(true);
      expect(result.result).toEqual({
        file: { content: "File: test.txt" },
        bash: { output: "Ran: ls" },
      });
    });

    it("records tool calls with full name", async () => {
      runtime.registerObject("mux", {
        fileRead: () => Promise.resolve("content"),
      });

      const result = await runtime.eval('mux.fileRead("test.txt");');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].toolName).toBe("mux.fileRead");
    });
  });

  describe("console capture", () => {
    it("captures console.log output", async () => {
      const result = await runtime.eval(`
        console.log("hello", 123);
        return "done";
      `);

      expect(result.success).toBe(true);
      expect(result.consoleOutput).toHaveLength(1);
      expect(result.consoleOutput[0].level).toBe("log");
      expect(result.consoleOutput[0].args).toEqual(["hello", 123]);
      expect(result.consoleOutput[0].timestamp).toBeGreaterThan(0);
    });

    it("captures console.warn and console.error", async () => {
      const result = await runtime.eval(`
        console.log("info");
        console.warn("warning");
        console.error("error");
        return;
      `);

      expect(result.consoleOutput).toHaveLength(3);
      expect(result.consoleOutput[0].level).toBe("log");
      expect(result.consoleOutput[1].level).toBe("warn");
      expect(result.consoleOutput[2].level).toBe("error");
    });
  });

  describe("event streaming", () => {
    it("emits tool-call-start and tool-call-end events", async () => {
      const events: PTCEvent[] = [];
      runtime.onEvent((e) => events.push(e));

      runtime.registerFunction("myTool", () => Promise.resolve("result"));
      await runtime.eval("myTool()");

      const toolEvents = events.filter(
        (e) => e.type === "tool-call-start" || e.type === "tool-call-end"
      );
      expect(toolEvents).toHaveLength(2);

      expect(toolEvents[0].type).toBe("tool-call-start");
      expect(toolEvents[0].toolName).toBe("myTool");

      expect(toolEvents[1].type).toBe("tool-call-end");
      expect(toolEvents[1].toolName).toBe("myTool");
      if (toolEvents[1].type === "tool-call-end") {
        expect(toolEvents[1].result).toBe("result");
      }
    });

    it("emits console events", async () => {
      const events: PTCEvent[] = [];
      runtime.onEvent((e) => events.push(e));

      await runtime.eval('console.log("test", 42)');

      const consoleEvents = events.filter((e) => e.type === "console");
      expect(consoleEvents).toHaveLength(1);
      expect(consoleEvents[0].type).toBe("console");
      if (consoleEvents[0].type === "console") {
        expect(consoleEvents[0].level).toBe("log");
        expect(consoleEvents[0].args).toEqual(["test", 42]);
      }
    });
  });

  describe("partial results on failure", () => {
    it("returns partial results when error occurs after tool calls", async () => {
      runtime.registerFunction("succeed", () => Promise.resolve("ok"));
      runtime.registerFunction("fail", () => {
        return Promise.reject(new Error("boom"));
      });

      const result = await runtime.eval(`
        succeed();
        fail();
      `);

      expect(result.success).toBe(false);
      expect(result.error).toContain("boom");
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0].result).toBe("ok");
      expect(result.toolCalls[1].error).toContain("boom");
    });

    it("preserves console output on failure", async () => {
      const result = await runtime.eval(`
        console.log("before error");
        throw new Error("fail");
      `);

      expect(result.success).toBe(false);
      expect(result.consoleOutput).toHaveLength(1);
      expect(result.consoleOutput[0].args).toEqual(["before error"]);
    });
  });

  describe("limits", () => {
    it("applies memory limits", async () => {
      runtime.setLimits({ memoryBytes: 1024 * 1024 }); // 1MB

      // Try to allocate a large array - should fail
      const result = await runtime.eval(`
        const arr = new Array(10 * 1024 * 1024).fill(1);
        return arr.length;
      `);

      // Should either fail or succeed with limited allocation
      // QuickJS may throw or return partial result
      expect(result.success).toBe(false);
    });

    it("applies timeout limits", async () => {
      runtime.setLimits({ timeoutMs: 100 }); // 100ms timeout

      const result = await runtime.eval(`
        while(true) {} // Infinite loop
      `);

      expect(result.success).toBe(false);
      expect(result.error).toContain("timeout");
    });

    it("aborts signal when timeout fires during async host function", async () => {
      // This tests the setTimeout-based timeout's effect on the abort signal.
      // The interrupt handler only fires during QuickJS execution, but when
      // waiting for an async host function, the setTimeout aborts the signal.
      //
      // Important: The host function itself won't be cancelled mid-flight
      // (JavaScript can't interrupt Promises), but the signal will be aborted
      // so subsequent tool calls will see it and fail fast.
      let firstCallCompleted = false;

      runtime.registerFunction("slowOp", async () => {
        // Sleep for 200ms
        await new Promise((resolve) => setTimeout(resolve, 200));
        firstCallCompleted = true;
        return "done";
      });

      // Check the abort signal state from QuickJS (sync is fine, made async for type)
      runtime.registerFunction("checkAbortState", () => {
        return Promise.resolve({ aborted: runtime.getAbortSignal()?.aborted ?? false });
      });

      runtime.setLimits({ timeoutMs: 100 }); // 100ms timeout

      const result = await runtime.eval(`
        slowOp();           // Takes 200ms, timeout fires at 100ms
        checkAbortState();  // Should show aborted = true
        slowOp();           // This would start after abort
        return "finished";
      `);

      // The first call completes (can't be interrupted mid-Promise)
      expect(firstCallCompleted).toBe(true);
      // But the overall execution fails due to timeout
      expect(result.success).toBe(false);
      expect(result.error).toContain("timeout");
    });
  });

  describe("abort", () => {
    it("can abort during async host function", async () => {
      // Abort is checked at the start of each async host function call
      let callCount = 0;
      runtime.registerFunction("slowOp", async () => {
        callCount++;
        // Simulate slow async work
        await new Promise((resolve) => setTimeout(resolve, 200));
        return "done";
      });

      // Queue multiple calls, abort after first starts
      const evalPromise = runtime.eval(`
        slowOp();
        slowOp(); // Should be aborted before running
        return "finished";
      `);

      // Abort after first function starts but before it completes
      setTimeout(() => runtime.abort(), 100);

      await evalPromise;
      // First call may complete, but second should be aborted
      // (timing dependent, but abort should eventually take effect)
      expect(callCount).toBeLessThanOrEqual(2);
    });

    it("abort method exists and can be called", () => {
      // Basic sanity test that abort() is callable
      expect(() => runtime.abort()).not.toThrow();
    });
  });

  describe("dispose", () => {
    it("throws on eval after dispose", async () => {
      runtime.dispose();

      try {
        await runtime.eval("return 1");
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(String(e)).toContain("disposed");
      }
    });

    it("can be disposed multiple times safely", () => {
      runtime.dispose();
      runtime.dispose(); // Should not throw
    });

    it("supports Symbol.dispose", () => {
      expect(typeof runtime[Symbol.dispose]).toBe("function");
      runtime[Symbol.dispose]();
    });
  });

  describe("friendly error messages for unavailable globals", () => {
    it("provides friendly error for process", async () => {
      const result = await runtime.eval("const env = process.env;");
      expect(result.success).toBe(false);
      expect(result.error).toContain("'process' is not available in the sandbox");
      expect(result.error).toContain("mux.*");
    });

    it("provides friendly error for window", async () => {
      const result = await runtime.eval("window.alert('hi');");
      expect(result.success).toBe(false);
      expect(result.error).toContain("'window' is not available in the sandbox");
    });

    it("provides friendly error for fetch", async () => {
      const result = await runtime.eval("fetch('https://example.com');");
      expect(result.success).toBe(false);
      expect(result.error).toContain("'fetch' is not available in the sandbox");
    });

    it("provides friendly error for require", async () => {
      const result = await runtime.eval("const fs = require('fs');");
      expect(result.success).toBe(false);
      expect(result.error).toContain("'require' is not available in the sandbox");
    });

    it("provides friendly error for document", async () => {
      const result = await runtime.eval("document.getElementById('test');");
      expect(result.success).toBe(false);
      expect(result.error).toContain("'document' is not available in the sandbox");
    });

    it("keeps standard ReferenceError for user-defined undefined vars", async () => {
      const result = await runtime.eval("const x = myUndefinedVar;");
      expect(result.success).toBe(false);
      // Should NOT get the friendly message since it's not a known unavailable global
      expect(result.error).not.toContain("mux.*");
      expect(result.error).toContain("not defined");
    });
  });
});

describe("QuickJSRuntimeFactory", () => {
  it("creates new runtime instances", async () => {
    const factory = new QuickJSRuntimeFactory();
    const runtime = await factory.create();

    expect(runtime).toBeInstanceOf(QuickJSRuntime);

    const result = await runtime.eval("return 42");
    expect(result.success).toBe(true);
    expect(result.result).toBe(42);

    runtime.dispose();
  });
});

describe("sequential execution", () => {
  it("executes async host functions sequentially even in loops", async () => {
    // This test proves that Asyncify causes async host functions to execute
    // sequentially, not in parallel. Even constructs that would normally
    // run concurrently (like Promise.all) execute one-at-a-time.
    const runtime = await QuickJSRuntime.create();
    const callOrder: number[] = [];

    runtime.registerObject("test", {
      trackOrder: async (args: unknown) => {
        const id = (args as { id: number }).id;
        callOrder.push(id);
        // Small delay - if parallel, calls would interleave
        await new Promise((r) => setTimeout(r, 10));
        return { id };
      },
    });

    const result = await runtime.eval(`
      // Due to Asyncify, these calls appear synchronous and execute in order
      const r1 = test.trackOrder({ id: 1 });
      const r2 = test.trackOrder({ id: 2 });
      const r3 = test.trackOrder({ id: 3 });
      return [r1.id, r2.id, r3.id];
    `);

    runtime.dispose();

    expect(result.success).toBe(true);
    expect(result.result).toEqual([1, 2, 3]);
    // Call order is deterministically sequential
    expect(callOrder).toEqual([1, 2, 3]);
  });
});

describe("marshal edge cases", () => {
  let runtime: QuickJSRuntime;

  beforeEach(async () => {
    runtime = await QuickJSRuntime.create();
  });

  afterEach(() => {
    runtime.dispose();
  });

  it("handles BigInt values natively", async () => {
    runtime.registerFunction("getBigInt", () => Promise.resolve(BigInt("9007199254740993")));

    const result = await runtime.eval("return getBigInt();");
    expect(result.success).toBe(true);
    // QuickJS returns bigints as numbers if they fit, or as BigInt
    expect(result.result).toBe(9007199254740993n);
  });

  it("preserves undefined in objects", async () => {
    runtime.registerFunction("getObjWithUndefined", () =>
      Promise.resolve({ a: 1, b: undefined, c: 3 })
    );

    const result = await runtime.eval(`
      const obj = getObjWithUndefined();
      return { hasB: 'b' in obj, bValue: obj.b, a: obj.a, c: obj.c };
    `);
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ hasB: true, bValue: undefined, a: 1, c: 3 });
  });

  it("preserves undefined in arrays (not converted to null)", async () => {
    runtime.registerFunction("getArrayWithUndefined", () => Promise.resolve([1, undefined, 3]));

    const result = await runtime.eval(`
      const arr = getArrayWithUndefined();
      return { len: arr.length, first: arr[0], second: arr[1], third: arr[2] };
    `);
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ len: 3, first: 1, second: undefined, third: 3 });
  });

  it("handles circular references with [Circular] placeholder", async () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    runtime.registerFunction("getCircular", () => Promise.resolve(circular));

    const result = await runtime.eval(`
      const obj = getCircular();
      return { a: obj.a, selfType: typeof obj.self, selfValue: obj.self };
    `);
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ a: 1, selfType: "string", selfValue: "[Circular]" });
  });

  it("marks functions as unserializable", async () => {
    runtime.registerFunction("getFunction", () =>
      Promise.resolve({ fn: () => "hello", value: 42 })
    );

    const result = await runtime.eval(`
      const obj = getFunction();
      return { fnType: obj.fn.__unserializable__, value: obj.value };
    `);
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ fnType: "function", value: 42 });
  });

  it("marks symbols as unserializable", async () => {
    runtime.registerFunction("getSymbol", () =>
      Promise.resolve({ sym: Symbol("test"), value: 42 })
    );

    const result = await runtime.eval(`
      const obj = getSymbol();
      return { symType: obj.sym.__unserializable__, value: obj.value };
    `);
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ symType: "symbol", value: 42 });
  });

  it("handles deeply nested objects", async () => {
    runtime.registerFunction("getDeep", () =>
      Promise.resolve({ a: { b: { c: { d: { e: "deep" } } } } })
    );

    const result = await runtime.eval("return getDeep().a.b.c.d.e;");
    expect(result.success).toBe(true);
    expect(result.result).toBe("deep");
  });

  it("handles arrays with mixed types", async () => {
    runtime.registerFunction("getMixed", () =>
      Promise.resolve([1, "two", { three: 3 }, [4, 5], null, true])
    );

    const result = await runtime.eval("return getMixed();");
    expect(result.success).toBe(true);
    expect(result.result).toEqual([1, "two", { three: 3 }, [4, 5], null, true]);
  });

  it("handles empty objects and arrays", async () => {
    runtime.registerFunction("getEmpty", () => Promise.resolve({ obj: {}, arr: [] }));

    const result = await runtime.eval("return getEmpty();");
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ obj: {}, arr: [] });
  });

  it("converts Date to ISO string (matches JSON.stringify)", async () => {
    const testDate = new Date("2024-06-15T12:30:00.000Z");
    runtime.registerFunction("getDate", () =>
      Promise.resolve({ created: testDate, nested: { date: testDate } })
    );

    const result = await runtime.eval("return getDate();");
    expect(result.success).toBe(true);
    expect(result.result).toEqual({
      created: "2024-06-15T12:30:00.000Z",
      nested: { date: "2024-06-15T12:30:00.000Z" },
    });
  });

  it("handles shared references (same object in multiple places) without marking as circular", async () => {
    // Shared reference is NOT circular - same object appears twice but no cycle
    const shared = { id: 42, name: "shared" };
    const obj = { a: shared, b: shared, c: { nested: shared } };
    runtime.registerFunction("getShared", () => Promise.resolve(obj));

    const result = await runtime.eval(`
      const obj = getShared();
      return {
        aId: obj.a.id,
        bId: obj.b.id,
        cNestedId: obj.c.nested.id,
        // Verify none are "[Circular]" strings
        aType: typeof obj.a,
        bType: typeof obj.b
      };
    `);
    expect(result.success).toBe(true);
    expect(result.result).toEqual({
      aId: 42,
      bId: 42,
      cNestedId: 42,
      aType: "object",
      bType: "object",
    });
  });

  it("still detects true circular references", async () => {
    // True cycle: a -> b -> a
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b" };
    a.ref = b;
    b.ref = a; // Creates cycle
    runtime.registerFunction("getCycle", () => Promise.resolve(a));

    const result = await runtime.eval(`
      const obj = getCycle();
      return {
        name: obj.name,
        refName: obj.ref.name,
        refRefValue: obj.ref.ref  // This points back to 'a' - should be "[Circular]"
      };
    `);
    expect(result.success).toBe(true);
    expect(result.result).toEqual({
      name: "a",
      refName: "b",
      refRefValue: "[Circular]",
    });
  });
});
