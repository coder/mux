import { EventEmitter } from "events";
import type { Config } from "@/node/config";
import { EventStore } from "@/node/utils/eventStore";
import type { WorkspaceInitEvent } from "@/common/orpc/types";
import { log } from "@/node/services/log";
import { INIT_HOOK_MAX_LINES } from "@/common/constants/toolLimits";

/**
 * Output line with timestamp for replay timing.
 */
export interface TimedLine {
  line: string;
  isError: boolean; // true if from stderr
  timestamp: number;
}

/**
 * Persisted state for init hooks.
 * Stored in ~/.mux/sessions/{workspaceId}/init-status.json
 */
export interface InitStatus {
  status: "running" | "success" | "error";
  hookPath: string;
  startTime: number;
  lines: TimedLine[];
  exitCode: number | null;
  endTime: number | null; // When init-end event occurred
  /** Number of lines dropped from middle when output exceeded INIT_HOOK_MAX_LINES */
  truncatedLines?: number;
}

/**
 * In-memory state for active init hooks.
 * Currently identical to InitStatus, but kept separate for future extension.
 */
type InitHookState = InitStatus;

/**
 * InitStateManager - Manages init hook lifecycle with persistence and replay.
 *
 * Uses EventStore abstraction for state management:
 * - In-memory Map for active init hooks (via EventStore)
 * - Disk persistence to init-status.json for replay across page reloads
 * - EventEmitter for streaming events to AgentSession
 * - Permanent storage (never auto-deleted, unlike stream partials)
 *
 * Key differences from StreamManager:
 * - Simpler state machine (running → success/error, no abort)
 * - No throttling (init hooks emit discrete lines, not streaming tokens)
 * - Permanent persistence (init logs kept forever as workspace metadata)
 *
 * Lifecycle:
 * 1. startInit() - Create in-memory state, emit init-start, create completion promise
 * 2. appendOutput() - Accumulate lines, emit init-output
 * 3. endInit() - Finalize state, write to disk, emit init-end, resolve promise
 * 4. State remains in memory until cleared or process restart
 * 5. replayInit() - Re-emit events from in-memory or disk state (via EventStore)
 *
 * Waiting: Tools use waitForInit() which returns a promise that resolves when
 * init completes. This promise is stored in initPromises map and resolved by
 * endInit(). No event listeners needed, eliminating race conditions.
 */
export class InitStateManager extends EventEmitter {
  private readonly store: EventStore<InitHookState, WorkspaceInitEvent & { workspaceId: string }>;

  /**
   * Promise-based completion tracking for running inits.
   * Each running init has a promise that resolves when endInit() is called.
   * Multiple tools can await the same promise without race conditions.
   */
  private readonly initPromises = new Map<
    string,
    { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }
  >();

  constructor(config: Config) {
    super();
    this.store = new EventStore(
      config,
      "init-status.json",
      (state) => this.serializeInitEvents(state),
      (event) => this.emit(event.type, event),
      "InitStateManager"
    );
  }

  /**
   * Serialize InitHookState into array of events for replay.
   * Used by EventStore.replay() to reconstruct the event stream.
   */
  private serializeInitEvents(
    state: InitHookState & { workspaceId?: string }
  ): Array<WorkspaceInitEvent & { workspaceId: string }> {
    const events: Array<WorkspaceInitEvent & { workspaceId: string }> = [];
    const workspaceId = state.workspaceId ?? "unknown";

    // Emit init-start
    events.push({
      type: "init-start",
      workspaceId,
      hookPath: state.hookPath,
      timestamp: state.startTime,
    });

    // Emit init-output for each accumulated line with original timestamps
    // Defensive: state.lines could be undefined from old persisted data
    let lines = state.lines ?? [];
    let truncatedLines = state.truncatedLines ?? 0;

    // Truncate old persisted data that exceeded the limit (backwards compat)
    if (lines.length > INIT_HOOK_MAX_LINES) {
      const excessLines = lines.length - INIT_HOOK_MAX_LINES;
      lines = lines.slice(-INIT_HOOK_MAX_LINES); // Keep tail
      truncatedLines += excessLines;
      log.info(
        `[InitStateManager] Truncated ${excessLines} lines from old persisted data for ${workspaceId}`
      );
    }

    for (const timedLine of lines) {
      // Skip malformed entries (missing required fields)
      if (typeof timedLine.line !== "string" || typeof timedLine.timestamp !== "number") {
        log.warn(`[InitStateManager] Skipping malformed init-output:`, timedLine);
        continue;
      }
      events.push({
        type: "init-output",
        workspaceId,
        line: timedLine.line,
        isError: timedLine.isError,
        timestamp: timedLine.timestamp, // Use original timestamp for replay
      });
    }

    // Emit init-end (only if completed)
    if (state.exitCode !== null) {
      events.push({
        type: "init-end",
        workspaceId,
        exitCode: state.exitCode,
        timestamp: state.endTime ?? state.startTime,
        // Include truncation info so frontend can show indicator
        ...(truncatedLines ? { truncatedLines } : {}),
      });
    }

    return events;
  }

  /**
   * Start tracking a new init hook execution.
   * Creates in-memory state, completion promise, and emits init-start event.
   */
  startInit(workspaceId: string, hookPath: string): void {
    const startTime = Date.now();

    const state: InitHookState = {
      status: "running",
      hookPath,
      startTime,
      lines: [],
      exitCode: null,
      endTime: null,
    };

    this.store.setState(workspaceId, state);

    // Create completion promise for this init
    // This allows multiple tools to await the same init without event listeners
    let resolve: () => void;
    let reject: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    this.initPromises.set(workspaceId, {
      promise,
      resolve: resolve!,
      reject: reject!,
    });

    log.debug(`Init hook started for workspace ${workspaceId}: ${hookPath}`);

    // Emit init-start event
    this.emit("init-start", {
      type: "init-start",
      workspaceId,
      hookPath,
      timestamp: startTime,
    } satisfies WorkspaceInitEvent & { workspaceId: string });
  }

  /**
   * Append output line from init hook.
   * Accumulates in state (with truncation for long output) and emits init-output event.
   *
   * Truncation strategy: Keep only the most recent INIT_HOOK_MAX_LINES lines (tail).
   * Older lines are dropped to prevent OOM with large rsync/build output.
   */
  appendOutput(workspaceId: string, line: string, isError: boolean): void {
    const state = this.store.getState(workspaceId);

    if (!state) {
      log.error(`appendOutput called for workspace ${workspaceId} with no active init state`);
      return;
    }

    const timestamp = Date.now();
    const timedLine: TimedLine = { line, isError, timestamp };

    // Truncation: keep only the most recent MAX_LINES
    if (state.lines.length >= INIT_HOOK_MAX_LINES) {
      state.lines.shift(); // Drop oldest line
      state.truncatedLines = (state.truncatedLines ?? 0) + 1;
    }
    state.lines.push(timedLine);

    // Emit init-output event (always emit for live streaming, even if truncated from storage)
    this.emit("init-output", {
      type: "init-output",
      workspaceId,
      line,
      isError,
      timestamp,
    } satisfies WorkspaceInitEvent & { workspaceId: string });
  }

  /**
   * Finalize init hook execution.
   * Updates state, persists to disk, emits init-end event, and resolves completion promise.
   *
   * IMPORTANT: We persist BEFORE updating in-memory exitCode to prevent a race condition
   * where replay() sees exitCode !== null but the file doesn't exist yet. This ensures
   * the invariant: if init-end is visible (live or replay), the file MUST exist.
   */
  async endInit(workspaceId: string, exitCode: number): Promise<void> {
    const state = this.store.getState(workspaceId);

    if (!state) {
      log.error(`endInit called for workspace ${workspaceId} with no active init state`);
      return;
    }

    const endTime = Date.now();
    const finalStatus = exitCode === 0 ? "success" : "error";

    // Create complete state for persistence (don't mutate in-memory state yet)
    const stateToPerist: InitHookState = {
      ...state,
      status: finalStatus,
      exitCode,
      endTime,
    };

    // Persist FIRST - ensures file exists before in-memory state shows completion
    await this.store.persist(workspaceId, stateToPerist);

    // NOW update in-memory state (replay will now see file exists)
    state.status = finalStatus;
    state.exitCode = exitCode;
    state.endTime = endTime;

    log.info(
      `Init hook ${state.status} for workspace ${workspaceId} (exit code ${exitCode}, duration ${endTime - state.startTime}ms)`
    );

    // Emit init-end event
    this.emit("init-end", {
      type: "init-end",
      workspaceId,
      exitCode,
      timestamp: endTime,
      // Include truncation info so frontend can show indicator
      ...(state.truncatedLines ? { truncatedLines: state.truncatedLines } : {}),
    } satisfies WorkspaceInitEvent & { workspaceId: string });

    // Resolve completion promise for waiting tools
    const promiseEntry = this.initPromises.get(workspaceId);
    if (promiseEntry) {
      promiseEntry.resolve();
      this.initPromises.delete(workspaceId);
    }

    // Keep state in memory for replay (unlike streams which delete immediately)
  }

  /**
   * Get current in-memory init state for a workspace.
   * Returns undefined if no init state exists.
   */
  getInitState(workspaceId: string): InitHookState | undefined {
    return this.store.getState(workspaceId);
  }

  /**
   * Read persisted init status from disk.
   * Returns null if no status file exists.
   */
  async readInitStatus(workspaceId: string): Promise<InitStatus | null> {
    return this.store.readPersisted(workspaceId);
  }

  /**
   * Replay init events for a workspace.
   * Delegates to EventStore.replay() which:
   * 1. Checks in-memory state first, then falls back to disk
   * 2. Serializes state into events via serializeInitEvents()
   * 3. Emits events (init-start, init-output*, init-end)
   *
   * This is called during AgentSession.emitHistoricalEvents() to ensure
   * init state is visible after page reloads.
   */
  async replayInit(workspaceId: string): Promise<void> {
    // Pass workspaceId as context for serialization
    await this.store.replay(workspaceId, { workspaceId });
  }

  /**
   * Delete persisted init status from disk.
   * Useful for testing or manual cleanup.
   * Does NOT clear in-memory state (for active replay).
   */
  async deleteInitStatus(workspaceId: string): Promise<void> {
    await this.store.deletePersisted(workspaceId);
  }

  /**
   * Clear in-memory state for a workspace.
   * Useful for testing or cleanup after workspace deletion.
   * Does NOT delete disk file (use deleteInitStatus for that).
   *
   * Also cancels any running init promises to prevent orphaned waiters.
   */
  clearInMemoryState(workspaceId: string): void {
    this.store.deleteState(workspaceId);

    // Cancel any running init promise for this workspace
    const promiseEntry = this.initPromises.get(workspaceId);
    if (promiseEntry) {
      promiseEntry.reject(new Error(`Workspace ${workspaceId} was deleted`));
      this.initPromises.delete(workspaceId);
    }
  }

  /**
   * Wait for workspace initialization to complete.
   * Used by tools (bash, file_*) to ensure files are ready before executing.
   *
   * Behavior:
   * - No init state: Returns immediately (init not needed or backwards compat)
   * - Init succeeded/failed: Returns immediately (tools proceed regardless of init outcome)
   * - Init running: Waits for completion promise (up to 5 minutes, then proceeds anyway)
   *
   * This method NEVER throws - tools should always proceed. If init fails or times out,
   * the tool will either succeed (if init wasn't critical) or fail with its own error
   * (e.g., file not found). This provides better error messages than blocking on init.
   *
   * Promise-based approach eliminates race conditions:
   * - Multiple tools share the same promise (no duplicate listeners)
   * - No event cleanup needed (promise auto-resolves once)
   * - Timeout races handled by Promise.race()
   *
   * @param workspaceId Workspace ID to wait for
   */
  async waitForInit(workspaceId: string): Promise<void> {
    const state = this.getInitState(workspaceId);

    // No init state - proceed immediately (backwards compat or init not needed)
    if (!state) {
      return;
    }

    // Init already completed (success or failure) - proceed immediately
    // Tools should work regardless of init outcome
    if (state.status !== "running") {
      return;
    }

    // Init is running - wait for completion promise with timeout
    const promiseEntry = this.initPromises.get(workspaceId);

    if (!promiseEntry) {
      // State says running but no promise exists (shouldn't happen, but handle gracefully)
      log.error(`Init state is running for ${workspaceId} but no promise found, proceeding`);
      return;
    }

    const INIT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        log.error(
          `Init timeout for ${workspaceId} after 5 minutes - tools will proceed anyway. ` +
            `Init will continue in background.`
        );
        resolve(); // Resolve, don't reject - tools should proceed
      }, INIT_TIMEOUT_MS);
    });

    // Race between completion and timeout
    // Both resolve (no rejection), so tools always proceed
    try {
      await Promise.race([promiseEntry.promise, timeoutPromise]);
    } catch (error) {
      // Init promise was rejected (e.g., workspace deleted)
      // Log and proceed anyway - let the tool fail with its own error if needed
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`Init wait interrupted for ${workspaceId}: ${errorMsg} - proceeding anyway`);
    }
  }
}
