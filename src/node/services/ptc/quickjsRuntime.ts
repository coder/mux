/**
 * QuickJS Runtime Implementation
 *
 * Implements IJSRuntime using quickjs-emscripten for sandboxed JavaScript execution.
 * Uses Asyncify to allow async host functions to appear synchronous in the sandbox.
 */

import {
  newQuickJSAsyncWASMModuleFromVariant,
  type QuickJSAsyncContext,
  type QuickJSHandle,
} from "quickjs-emscripten-core";
import { QuickJSAsyncFFI } from "@jitl/quickjs-wasmfile-release-asyncify/ffi";
import crypto from "crypto";
import type { IJSRuntime, IJSRuntimeFactory, RuntimeLimits } from "./runtime";
import type { PTCEvent, PTCExecutionResult, PTCToolCallRecord, PTCConsoleRecord } from "./types";
import { UNAVAILABLE_IDENTIFIERS } from "./staticAnalysis";

// Default limits
const DEFAULT_MEMORY_BYTES = 64 * 1024 * 1024; // 64MB
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Generate a short random ID for PTC nested tool calls (10 hex chars). */
function generateCallId(): string {
  return crypto.randomBytes(5).toString("hex");
}

/**
 * QuickJS-based JavaScript runtime for PTC.
 * Uses Asyncify build for async host function support.
 */
export class QuickJSRuntime implements IJSRuntime {
  private disposed = false;
  private eventHandler?: (event: PTCEvent) => void;
  private abortController?: AbortController;
  private abortRequested = false; // Track abort requests before eval() starts
  private limits: RuntimeLimits = {};
  private consoleSetup = false;
  /** Serializes late-settlement guest continuations; see setPendingJobGate. */
  private pendingJobGate?: (run: () => void) => void;

  // Execution state (reset per eval)
  private toolCalls: PTCToolCallRecord[] = [];
  private consoleOutput: PTCConsoleRecord[] = [];

  // In-flight async-capability promises (registerPromiseFunction). eval()'s
  // resolve loop awaits these when the returned value is still pending, so a
  // guest `await` on a capability promise is not misreported as stuck.
  // NOT reset per eval: fire-and-forget capabilities from a previous call on a
  // persistent mount may legitimately still be settling.
  private readonly pendingHostPromises = new Set<Promise<void>>();

  private constructor(private readonly ctx: QuickJSAsyncContext) {}

  static async create(): Promise<QuickJSRuntime> {
    // Create the async variant manually due to bun's package export resolution issues.
    // The self-referential import in the variant package doesn't resolve correctly.
    const variant = {
      type: "async" as const,
      importFFI: () => Promise.resolve(QuickJSAsyncFFI),
      // eslint-disable-next-line @typescript-eslint/require-await -- sync require wrapped for interface
      importModuleLoader: async () => {
        // Use require() with the named export path since bun's dynamic import()
        // doesn't resolve package exports correctly from within node_modules
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
        const mod = require("@jitl/quickjs-wasmfile-release-asyncify/emscripten-module");
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
        return mod.default ?? mod;
      },
    };

    const QuickJS = await newQuickJSAsyncWASMModuleFromVariant(variant);
    const ctx = QuickJS.newContext();
    return new QuickJSRuntime(ctx);
  }

  setLimits(limits: RuntimeLimits): void {
    this.limits = limits;

    // Apply memory limit to the runtime
    const memoryBytes = limits.memoryBytes ?? DEFAULT_MEMORY_BYTES;
    this.ctx.runtime.setMemoryLimit(memoryBytes);
  }

  onEvent(handler: (event: PTCEvent) => void): void {
    this.eventHandler = handler;
  }

  registerFunction(name: string, fn: (...args: unknown[]) => Promise<unknown>): void {
    this.assertNotDisposed("registerFunction");

    const handle = this.ctx.newAsyncifiedFunction(name, async (...argHandles) => {
      if (this.abortController?.signal.aborted) {
        throw new Error("Execution aborted");
      }

      // Convert QuickJS handles to JS values - cast to unknown at the FFI boundary
      const args: unknown[] = argHandles.map((h) => this.ctx.dump(h) as unknown);
      const startTime = Date.now();
      // Generate our own callId for nested tool calls. Regular tool calls get IDs from
      // the model (e.g. Anthropic's toolu_*, OpenAI's call_*), but PTC nested calls are
      // executed in our sandbox, not requested by the model.
      const callId = generateCallId();

      // Emit start event
      this.eventHandler?.({
        type: "tool-call-start",
        callId,
        toolName: name,
        args: args[0],
        startTime,
      });

      try {
        const result = await fn(...args);
        const endTime = Date.now();
        const duration_ms = endTime - startTime;

        // Record tool call
        this.toolCalls.push({ toolName: name, args: args[0], result, duration_ms });

        // Emit end event
        this.eventHandler?.({
          type: "tool-call-end",
          callId,
          toolName: name,
          args: args[0],
          result,
          startTime,
          endTime,
        });

        // Marshal result back to QuickJS
        return this.marshal(result);
      } catch (error) {
        const endTime = Date.now();
        const duration_ms = endTime - startTime;
        const errorStr = error instanceof Error ? error.message : String(error);

        // Record failed tool call
        this.toolCalls.push({
          toolName: name,
          args: args[0],
          error: errorStr,
          duration_ms,
        });

        // Emit end event with error
        this.eventHandler?.({
          type: "tool-call-end",
          callId,
          toolName: name,
          args: args[0],
          error: errorStr,
          startTime,
          endTime,
        });

        // Re-throw to propagate error to sandbox
        throw error;
      }
    });

    this.ctx.setProp(this.ctx.global, name, handle);
    handle.dispose();
  }

  registerPromiseFunction(name: string, fn: (...args: unknown[]) => Promise<unknown>): void {
    this.assertNotDisposed("registerPromiseFunction");

    // Plain (non-asyncified) host function: it must return synchronously, so
    // it hands the guest a deferred VM promise and settles it when the host
    // promise settles. This is the async capability bridge: the guest can
    // fire-and-forget or await the returned Promise.
    const fnHandle = this.ctx.newFunction(name, (...argHandles) => {
      const args: unknown[] = argHandles.map((h) => this.ctx.dump(h) as unknown);
      const startTime = Date.now();
      const callId = generateCallId();
      const deferred = this.ctx.newPromise();

      // Capture per-eval attribution state NOW: a fire-and-forget capability
      // can settle after its originating eval() returned (timeout/abort or
      // un-awaited call). eval() swaps this.toolCalls/this.eventHandler per
      // execution, so consulting them at settlement would report the record
      // under a later eval and emit it to the wrong handler.
      const toolCalls = this.toolCalls;
      const eventHandler = this.eventHandler;

      eventHandler?.({
        type: "tool-call-start",
        callId,
        toolName: name,
        args: args[0],
        startTime,
      });

      const settle = (async () => {
        try {
          const result = await fn(...args);
          const endTime = Date.now();
          toolCalls.push({
            toolName: name,
            args: args[0],
            result,
            duration_ms: endTime - startTime,
          });
          eventHandler?.({
            type: "tool-call-end",
            callId,
            toolName: name,
            args: args[0],
            result,
            startTime,
            endTime,
          });
          if (this.disposed) return;
          const valueHandle = this.marshal(result);
          deferred.resolve(valueHandle);
          valueHandle.dispose();
        } catch (error) {
          const endTime = Date.now();
          const errorStr = error instanceof Error ? error.message : String(error);
          toolCalls.push({
            toolName: name,
            args: args[0],
            error: errorStr,
            duration_ms: endTime - startTime,
          });
          eventHandler?.({
            type: "tool-call-end",
            callId,
            toolName: name,
            args: args[0],
            error: errorStr,
            startTime,
            endTime,
          });
          if (this.disposed) return;
          const errorHandle = this.marshal({ name: "Error", message: errorStr });
          deferred.reject(errorHandle);
          errorHandle.dispose();
        }
      })();

      // Track settlement so eval()'s resolve loop can wait on it. The tracked
      // promise never rejects (settle() catches everything above).
      const tracked: Promise<void> = settle.finally(() => {
        this.pendingHostPromises.delete(tracked);
      });
      this.pendingHostPromises.add(tracked);

      // Run guest continuations (.then/await) once the deferred settles.
      // Routed through the pending-job gate when set: on shared (persistent)
      // runtimes a LATE settlement must not re-enter the QuickJS context
      // while a later eval is running — the gate serializes the run under the
      // owner's exclusive lock. In-eval settlements are unaffected: eval's
      // resolve loop drains pending jobs itself.
      deferred.settled
        .then(() => {
          const run = () => {
            if (!this.disposed) {
              this.ctx.runtime.executePendingJobs();
            }
          };
          if (this.pendingJobGate) {
            this.pendingJobGate(run);
          } else {
            run();
          }
        })
        .catch(() => undefined);

      // Ownership of deferred.handle transfers to the wrapper (return value).
      return deferred.handle;
    });

    this.ctx.setProp(this.ctx.global, name, fnHandle);
    fnHandle.dispose();
  }

  setPendingJobGate(gate: (run: () => void) => void): void {
    this.pendingJobGate = gate;
  }

  registerSyncFunction(name: string, fn: (...args: unknown[]) => unknown): void {
    this.assertNotDisposed("registerSyncFunction");

    const fnHandle = this.ctx.newFunction(name, (...argHandles) => {
      const args: unknown[] = argHandles.map((h) => this.ctx.dump(h) as unknown);
      // Host exceptions propagate to the guest as thrown errors.
      const result = fn(...args);
      return this.marshal(result);
    });

    this.ctx.setProp(this.ctx.global, name, fnHandle);
    fnHandle.dispose();
  }

  registerObject(
    name: string,
    obj: Record<string, (...args: unknown[]) => Promise<unknown>>
  ): void {
    this.assertNotDisposed("registerObject");

    // Create object in QuickJS
    const objHandle = this.ctx.newObject();

    for (const [methodName, fn] of Object.entries(obj)) {
      const fnHandle = this.ctx.newAsyncifiedFunction(methodName, async (...argHandles) => {
        if (this.abortController?.signal.aborted) {
          throw new Error("Execution aborted");
        }

        // Convert QuickJS handles to JS values - cast to unknown at the FFI boundary
        const args: unknown[] = argHandles.map((h) => this.ctx.dump(h) as unknown);
        const startTime = Date.now();
        const callId = generateCallId();

        // Emit start event
        this.eventHandler?.({
          type: "tool-call-start",
          callId,
          toolName: methodName,
          args: args[0],
          startTime,
        });

        try {
          const result = await fn(...args);
          const endTime = Date.now();
          const duration_ms = endTime - startTime;

          // Record tool call
          this.toolCalls.push({ toolName: methodName, args: args[0], result, duration_ms });

          // Emit end event
          this.eventHandler?.({
            type: "tool-call-end",
            callId,
            toolName: methodName,
            args: args[0],
            result,
            startTime,
            endTime,
          });

          return this.marshal(result);
        } catch (error) {
          const endTime = Date.now();
          const duration_ms = endTime - startTime;
          const errorStr = error instanceof Error ? error.message : String(error);

          this.toolCalls.push({
            toolName: methodName,
            args: args[0],
            error: errorStr,
            duration_ms,
          });

          this.eventHandler?.({
            type: "tool-call-end",
            callId,
            toolName: methodName,
            args: args[0],
            error: errorStr,
            startTime,
            endTime,
          });

          throw error;
        }
      });

      this.ctx.setProp(objHandle, methodName, fnHandle);
      fnHandle.dispose();
    }

    this.ctx.setProp(this.ctx.global, name, objHandle);
    objHandle.dispose();
  }

  async eval(code: string): Promise<PTCExecutionResult> {
    this.assertNotDisposed("eval");

    const execStartTime = Date.now();
    this.abortController = new AbortController();
    this.toolCalls = [];
    this.consoleOutput = [];

    // Honor abort requests made before eval() was called
    if (this.abortRequested) {
      this.abortController.abort();
    }

    // Set up console capturing (only once)
    if (!this.consoleSetup) {
      this.setupConsole();
      this.consoleSetup = true;
    }

    // Set up interrupt handler for cancellation and timeout
    const timeoutMs = this.limits.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;

    this.ctx.runtime.setInterruptHandler(() => {
      if (this.abortController?.signal.aborted) {
        return true; // Interrupt execution
      }
      if (Date.now() > deadline) {
        this.abortController?.abort();
        return true; // Interrupt execution due to timeout
      }
      return false; // Continue execution
    });

    // Set up a real timeout timer that fires even during async suspension.
    // The interrupt handler only runs during QuickJS execution, but when suspended
    // waiting for an async host function (e.g., mux.bash()), it never fires.
    // This timer ensures nested tools are cancelled when the deadline is exceeded.
    const timeoutId = setTimeout(() => {
      this.abortController?.abort();
    }, timeoutMs);

    // Wrap code in function to allow return statements.
    // With asyncify, async host functions appear synchronous to QuickJS,
    // so we don't need an async IIFE. Using evalCodeAsync handles the suspension.
    const wrappedCode = `(function() { ${code} })()`;

    try {
      const evalResult = await this.ctx.evalCodeAsync(wrappedCode);

      if (evalResult.error) {
        const errObj: unknown = this.ctx.dump(evalResult.error) as unknown;
        evalResult.error.dispose();

        const duration_ms = Date.now() - execStartTime;
        const errorMessage = this.getErrorMessage(errObj, deadline, timeoutMs);

        return {
          success: false,
          error: errorMessage,
          toolCalls: this.toolCalls,
          consoleOutput: this.consoleOutput,
          duration_ms,
        };
      }

      const resolvedValue = await this.resolveReturnedValue(evalResult.value, deadline, timeoutMs);
      evalResult.value.dispose();

      if (!resolvedValue.success) {
        return {
          success: false,
          error: resolvedValue.error,
          toolCalls: this.toolCalls,
          consoleOutput: this.consoleOutput,
          duration_ms: Date.now() - execStartTime,
        };
      }

      return {
        success: true,
        result: resolvedValue.value,
        toolCalls: this.toolCalls,
        consoleOutput: this.consoleOutput,
        duration_ms: Date.now() - execStartTime,
      };
    } catch (error) {
      const duration_ms = Date.now() - execStartTime;
      const errorMessage = this.getErrorMessage(error, deadline, timeoutMs);

      return {
        success: false,
        error: errorMessage,
        toolCalls: this.toolCalls,
        consoleOutput: this.consoleOutput,
        duration_ms,
      };
    } finally {
      clearTimeout(timeoutId);
      // An abort applies to the eval it interrupted (or the one about to
      // start), not to future evals: persistent mounts reuse this runtime
      // across calls, and a sticky flag would poison every later eval.
      this.abortRequested = false;
    }
  }

  abort(): void {
    this.abortRequested = true;
    this.abortController?.abort();
  }

  getAbortSignal(): AbortSignal | undefined {
    return this.abortController?.signal;
  }

  dispose(): void {
    if (!this.disposed) {
      this.ctx.dispose();
      this.disposed = true;
    }
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  // --- Private helpers ---

  private assertNotDisposed(method: string): void {
    if (this.disposed) {
      throw new Error(`Cannot call ${method} on disposed QuickJSRuntime`);
    }
  }

  private async resolveReturnedValue(
    handle: QuickJSHandle,
    deadline: number,
    timeoutMs: number
  ): Promise<{ success: true; value: unknown } | { success: false; error: string }> {
    let promiseState = this.ctx.getPromiseState(handle);
    while (promiseState.type === "pending") {
      if (this.abortController?.signal.aborted || Date.now() > deadline) {
        return {
          success: false,
          error: this.getErrorMessage("Execution interrupted", deadline, timeoutMs),
        };
      }
      if (this.ctx.runtime.hasPendingJob()) {
        const pendingJobs = this.ctx.runtime.executePendingJobs();
        if (pendingJobs.error) {
          const errorObj: unknown = pendingJobs.error.context.dump(pendingJobs.error) as unknown;
          const error = this.getErrorMessage(errorObj, deadline, timeoutMs);
          pendingJobs.dispose();
          return { success: false, error };
        }
        pendingJobs.dispose();
      } else if (this.pendingHostPromises.size > 0) {
        // The returned value may depend on an in-flight async capability
        // (registerPromiseFunction). Wait for any settlement, bounded by the
        // deadline/abort; each settlement schedules executePendingJobs.
        await this.waitForAnyHostPromise(deadline);
      } else {
        // Nothing can ever settle this promise.
        break;
      }
      promiseState = this.ctx.getPromiseState(handle);
    }

    if (promiseState.type === "pending") {
      return { success: false, error: "Execution returned a pending Promise" };
    }
    if (promiseState.type === "rejected") {
      const errorObj: unknown = this.ctx.dump(promiseState.error) as unknown;
      promiseState.error.dispose();
      return { success: false, error: this.getErrorMessage(errorObj, deadline, timeoutMs) };
    }

    try {
      const valueHandle = promiseState.notAPromise ? handle : promiseState.value;
      const value: unknown = this.ctx.dump(valueHandle) as unknown;
      return { success: true, value };
    } finally {
      if (!promiseState.notAPromise) {
        promiseState.value.dispose();
      }
    }
  }

  /**
   * Wait until any in-flight async-capability promise settles, the deadline
   * passes, or the execution is aborted. Tracked promises never reject.
   */
  private async waitForAnyHostPromise(deadline: number): Promise<void> {
    const abortSignal = this.abortController?.signal;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        abortSignal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, deadline - Date.now()) + 1);
      abortSignal?.addEventListener("abort", finish, { once: true });
      for (const pending of this.pendingHostPromises) {
        void pending.then(finish);
      }
    });
  }

  /**
   * Format a QuickJS error object into a readable error message.
   */
  private formatError(errorObj: unknown): string {
    if (typeof errorObj === "object" && errorObj !== null) {
      const err = errorObj as { name?: string; message?: string; stack?: string };
      if (err.name && err.message) {
        return `${err.name}: ${err.message}`;
      }
      if (err.message) {
        return err.message;
      }
    }
    return String(errorObj);
  }

  /**
   * Get appropriate error message, checking for timeout/abort conditions.
   * Also provides friendlier messages for common sandbox errors.
   */
  private getErrorMessage(errorObj: unknown, deadline: number, timeoutMs: number): string {
    const isAborted = this.abortController?.signal.aborted;
    const isTimedOut = Date.now() > deadline;

    if (isAborted && isTimedOut) {
      return `Execution timeout (${timeoutMs}ms exceeded)`;
    }
    if (isAborted) {
      return "Execution aborted";
    }

    // Check for QuickJS interrupt error
    const formatted = this.formatError(errorObj);
    if (formatted.includes("interrupted")) {
      if (isTimedOut) {
        return `Execution timeout (${timeoutMs}ms exceeded)`;
      }
      return "Execution interrupted";
    }

    // Provide friendlier message for unavailable globals
    const refErrorMatch = /ReferenceError: '?(\w+)'? is not defined/.exec(formatted);
    if (refErrorMatch) {
      const identifier = refErrorMatch[1];
      if (UNAVAILABLE_IDENTIFIERS.has(identifier)) {
        return `'${identifier}' is not available in the sandbox. Use mux.* tools for I/O operations.`;
      }
    }

    return formatted;
  }

  /**
   * Set up console.log/warn/error to capture output.
   */
  private setupConsole(): void {
    const consoleObj = this.ctx.newObject();

    for (const level of ["log", "warn", "error"] as const) {
      const fn = this.ctx.newFunction(level, (...argHandles) => {
        const args: unknown[] = argHandles.map((h) => this.ctx.dump(h) as unknown);
        const timestamp = Date.now();

        // Record console output
        this.consoleOutput.push({ level, args, timestamp });

        // Emit console event
        this.eventHandler?.({
          type: "console",
          level,
          args,
          timestamp,
        });
      });
      this.ctx.setProp(consoleObj, level, fn);
      fn.dispose();
    }

    this.ctx.setProp(this.ctx.global, "console", consoleObj);
    consoleObj.dispose();
  }

  /**
   * Marshal a JavaScript value into a QuickJS handle.
   *
   * Recursively converts JS values to QuickJS handles with:
   * - Cycle detection (circular refs become "[Circular]")
   * - Native BigInt support
   * - Preserved undefined in objects/arrays
   * - Explicit markers for unserializable types (functions, symbols)
   */
  private marshal(value: unknown, seen = new WeakSet<object>()): QuickJSHandle {
    if (value === undefined) {
      return this.ctx.undefined;
    }
    if (value === null) {
      return this.ctx.null;
    }
    if (typeof value === "boolean") {
      return value ? this.ctx.true : this.ctx.false;
    }
    if (typeof value === "number") {
      return this.ctx.newNumber(value);
    }
    if (typeof value === "string") {
      return this.ctx.newString(value);
    }
    if (typeof value === "bigint") {
      return this.ctx.newBigInt(value);
    }

    // Functions and symbols can't be marshaled - return explicit marker
    if (typeof value === "function" || typeof value === "symbol") {
      return this.marshalObject({ __unserializable__: typeof value }, seen);
    }

    // Objects and arrays - recursively marshal with cycle detection
    if (typeof value === "object") {
      // Date → ISO string (matches JSON.stringify behavior)
      if (value instanceof Date) {
        return this.ctx.newString(value.toISOString());
      }

      // Check for circular reference - `seen` tracks current ancestors in the
      // traversal path, not all visited objects. This correctly handles shared
      // references (same object in multiple places) vs true cycles.
      if (seen.has(value)) {
        return this.ctx.newString("[Circular]");
      }
      seen.add(value);

      try {
        if (Array.isArray(value)) {
          return this.marshalArray(value, seen);
        }
        return this.marshalObject(value as Record<string, unknown>, seen);
      } finally {
        // Remove from path after processing - allows same object to appear
        // in multiple non-circular positions (shared references)
        seen.delete(value);
      }
    }

    // Unknown type - shouldn't happen but be defensive
    return this.ctx.undefined;
  }

  private marshalArray(arr: unknown[], seen: WeakSet<object>): QuickJSHandle {
    const handle = this.ctx.newArray();
    for (let i = 0; i < arr.length; i++) {
      const elem = this.marshal(arr[i], seen);
      this.ctx.setProp(handle, i, elem);
      elem.dispose();
    }
    return handle;
  }

  private marshalObject(obj: Record<string, unknown>, seen: WeakSet<object>): QuickJSHandle {
    const handle = this.ctx.newObject();
    for (const [key, val] of Object.entries(obj)) {
      const valHandle = this.marshal(val, seen);
      this.ctx.setProp(handle, key, valHandle);
      valHandle.dispose();
    }
    return handle;
  }
}

/**
 * Factory for creating QuickJS runtime instances.
 */
export class QuickJSRuntimeFactory implements IJSRuntimeFactory {
  async create(): Promise<QuickJSRuntime> {
    return QuickJSRuntime.create();
  }
}
