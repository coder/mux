import { describe, expect, test } from "bun:test";
import { tool } from "ai";
import { z } from "zod";
import { withSequentialExecution } from "./withSequentialExecution";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve: Deferred<T>["resolve"] | undefined;
  let reject: Deferred<T>["reject"] | undefined;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  if (!resolve || !reject) {
    throw new Error("createDeferred failed to initialize promise controls");
  }

  return { promise, resolve, reject };
}

function callWrappedExecute(
  toolRecord: Record<string, unknown>,
  options: unknown
): Promise<unknown> {
  const execute = toolRecord.execute;
  if (typeof execute !== "function") {
    throw new Error("Expected wrapped tool execute handler");
  }

  const invoke = execute as (args: Record<string, never>, options: unknown) => Promise<unknown>;
  return invoke({}, options);
}

describe("withSequentialExecution", () => {
  test("serializes sibling execute handlers in invocation order", async () => {
    const executionLog: string[] = [];
    const started = {
      a: createDeferred<void>(),
      b: createDeferred<void>(),
      c: createDeferred<void>(),
    };
    const release = {
      a: createDeferred<void>(),
      b: createDeferred<void>(),
      c: createDeferred<void>(),
    };

    const tools = {
      a: tool({
        description: "Tool A",
        inputSchema: z.object({}),
        execute: async () => {
          executionLog.push("start A");
          started.a.resolve();
          await release.a.promise;
          executionLog.push("end A");
          return { tool: "A" };
        },
      }),
      b: tool({
        description: "Tool B",
        inputSchema: z.object({}),
        execute: async () => {
          executionLog.push("start B");
          started.b.resolve();
          await release.b.promise;
          executionLog.push("end B");
          return { tool: "B" };
        },
      }),
      c: tool({
        description: "Tool C",
        inputSchema: z.object({}),
        execute: async () => {
          executionLog.push("start C");
          started.c.resolve();
          await release.c.promise;
          executionLog.push("end C");
          return { tool: "C" };
        },
      }),
    };

    const wrappedTools = withSequentialExecution(tools);
    expect(wrappedTools).toBeDefined();
    expect(wrappedTools).not.toBe(tools);
    expect(wrappedTools!.a).not.toBe(tools.a);
    expect(wrappedTools!.b).not.toBe(tools.b);
    expect(wrappedTools!.c).not.toBe(tools.c);

    const resultsPromise = Promise.all([
      wrappedTools!.a.execute!({}, {} as never),
      wrappedTools!.b.execute!({}, {} as never),
      wrappedTools!.c.execute!({}, {} as never),
    ]);

    await started.a.promise;
    await Promise.resolve();
    expect(executionLog).toEqual(["start A"]);

    release.a.resolve();
    await started.b.promise;
    await Promise.resolve();
    expect(executionLog).toEqual(["start A", "end A", "start B"]);

    release.b.resolve();
    await started.c.promise;
    await Promise.resolve();
    expect(executionLog).toEqual(["start A", "end A", "start B", "end B", "start C"]);

    release.c.resolve();
    const results = await resultsPromise;

    expect(results).toEqual([{ tool: "A" }, { tool: "B" }, { tool: "C" }]);
    expect(executionLog).toEqual(["start A", "end A", "start B", "end B", "start C", "end C"]);
  });

  test("does not execute queued siblings after stream abort", async () => {
    const executionLog: string[] = [];
    const startedA = createDeferred<void>();
    const releaseA = createDeferred<void>();
    let startedB = false;

    const tools = {
      a: tool({
        description: "Tool A",
        inputSchema: z.object({}),
        execute: async () => {
          executionLog.push("start A");
          startedA.resolve();
          await releaseA.promise;
          executionLog.push("end A");
          return { tool: "A" };
        },
      }),
      b: tool({
        description: "Tool B",
        inputSchema: z.object({}),
        execute: () => {
          startedB = true;
          executionLog.push("start B");
          return { tool: "B" };
        },
      }),
    };

    const wrappedTools = withSequentialExecution(tools);
    expect(wrappedTools).toBeDefined();

    const controller = new AbortController();
    const firstPromise = callWrappedExecute(
      wrappedTools!.a as Record<string, unknown>,
      {} as never
    );
    await startedA.promise;

    const secondPromise = callWrappedExecute(
      wrappedTools!.b as Record<string, unknown>,
      {
        abortSignal: controller.signal,
      } as never
    );
    controller.abort();

    try {
      await secondPromise;
      throw new Error("Expected queued tool to reject after abort");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Interrupted");
    }
    expect(startedB).toBe(false);
    expect(executionLog).toEqual(["start A"]);

    releaseA.resolve();
    expect(await firstPromise).toEqual({ tool: "A" });
    await Promise.resolve();
    expect(startedB).toBe(false);
    expect(executionLog).toEqual(["start A", "end A"]);
  });
});
