/**
 * Programmatic Tool Calling (PTC) Runtime Interface
 *
 * Abstract interface for JS sandboxes. Currently implemented by QuickJSRuntime,
 * but designed to allow future migration to libbun or other runtimes.
 */

import type { PTCEvent, PTCExecutionResult } from "./types";

/**
 * Resource limits for sandbox execution.
 */
export interface RuntimeLimits {
  /** Maximum memory in bytes (default: 64MB) */
  memoryBytes?: number;
  /** Maximum execution time in milliseconds (default: 5 minutes) */
  timeoutMs?: number;
}

/**
 * Interface for a sandboxed JavaScript runtime.
 * Implements Disposable for automatic cleanup with `using` declarations.
 */
export interface IJSRuntime extends Disposable {
  /**
   * Execute JavaScript code in the sandbox.
   * Code is wrapped in an async IIFE to allow top-level await.
   * Returns execution result with partial results on failure.
   */
  eval(code: string): Promise<PTCExecutionResult>;

  /**
   * Register a host function callable from sandbox.
   * The function will be available as a global in the sandbox.
   */
  registerFunction(name: string, fn: (...args: unknown[]) => Promise<unknown>): void;

  /**
   * Register an object with methods (for namespaced tools like mux.bash).
   * Each method on the object becomes callable from the sandbox.
   */
  registerObject(name: string, obj: Record<string, (...args: unknown[]) => Promise<unknown>>): void;

  /**
   * Set memory/CPU limits for the sandbox.
   * Must be called before eval() to take effect.
   */
  setLimits(limits: RuntimeLimits): void;

  /**
   * Subscribe to events for UI streaming (tool calls, console output).
   * Only one handler can be active at a time.
   */
  onEvent(handler: (event: PTCEvent) => void): void;

  /**
   * Abort the currently running execution.
   * The sandbox will stop at the next interrupt check point.
   */
  abort(): void;

  /**
   * Get the abort signal for the current execution.
   * This signal is aborted when the sandbox times out or abort() is called.
   * Used by tool bridge to propagate cancellation to nested tool calls.
   */
  getAbortSignal(): AbortSignal | undefined;

  /**
   * Clean up resources. Called automatically with `using` declarations.
   */
  dispose(): void;
}

/**
 * Factory for creating JS runtime instances.
 */
export interface IJSRuntimeFactory {
  create(): Promise<IJSRuntime>;
}
