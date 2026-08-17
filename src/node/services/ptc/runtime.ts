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
   * Register a host function that returns a real Promise INTO the guest
   * (async capability bridge). Unlike registerFunction (asyncified: guest
   * blocks until the host settles), the guest receives the Promise
   * immediately and may await it, chain it, or ignore it (fire-and-forget).
   * eval() waits for in-flight capability promises the returned value depends
   * on, bounded by the same deadline/interrupt semantics.
   */
  registerPromiseFunction(name: string, fn: (...args: unknown[]) => Promise<unknown>): void;

  /**
   * Register a synchronous host function (no asyncify, no suspension).
   * Required for bridges that must be callable from guest continuations
   * resumed via executePendingJobs (e.g. code after `await capability()`),
   * where asyncified functions cannot suspend. Keep these fast and pure-ish:
   * they block the guest.
   */
  registerSyncFunction(name: string, fn: (...args: unknown[]) => unknown): void;

  /**
   * Route late guest-continuation execution through a host-provided gate.
   * When a fire-and-forget capability (registerPromiseFunction) settles after
   * its originating eval() returned, the runtime must run pending guest jobs —
   * but on a shared/persistent runtime that must not interleave with a later
   * eval. The gate lets the owner (e.g. SandboxMount) serialize the run under
   * its exclusive lock. Without a gate, jobs run immediately on settlement.
   */
  setPendingJobGate(gate: (run: () => void) => void): void;

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
