import type { Runtime, BackgroundHandle } from "@/node/runtime/Runtime";
import { spawnProcess } from "./backgroundProcessExecutor";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "./log";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";

import { EventEmitter } from "events";

/**
 * Metadata written to meta.json for bookkeeping
 */
export interface BackgroundProcessMeta {
  id: string;
  pid: number;
  script: string;
  startTime: number;
  status: "running" | "exited" | "killed" | "failed";
  exitCode?: number;
  exitTime?: number;
  displayName?: string;
}

/**
 * Represents a background process with file-based output.
 * All per-process state is consolidated here so cleanup is automatic when
 * the process is removed from the processes map.
 */
export interface BackgroundProcess {
  id: string; // Process ID (display_name from the bash tool call)
  pid: number; // OS process ID
  workspaceId: string; // Owning workspace
  outputDir: string; // Directory containing stdout.log, stderr.log, meta.json
  script: string; // Original command
  startTime: number; // Timestamp when started
  exitCode?: number; // Undefined if still running
  exitTime?: number; // Timestamp when exited (undefined if running)
  status: "running" | "exited" | "killed" | "failed";
  handle: BackgroundHandle; // For process interaction
  displayName?: string; // Human-readable name (e.g., "Dev Server")
  /** True if this process is being waited on (foreground mode) */
  isForeground: boolean;
  /** Tracks read position for incremental output retrieval */
  outputBytesRead: number;
  /** Mutex to serialize getOutput() calls (prevents race condition when
   * parallel tool calls read from same offset before position is updated) */
  outputLock: AsyncMutex;
  /** Tracks how many times getOutput() has been called (for polling detection) */
  getOutputCallCount: number;
  /** Buffer for incomplete lines (no trailing newline) from previous read */
  incompleteLineBuffer: string;
}

/**
 * Represents a foreground process that can be sent to background.
 * These are processes started via runtime.exec() (not nohup) that we track
 * so users can click "Background" to stop waiting for them.
 */
export interface ForegroundProcess {
  /** Workspace ID */
  workspaceId: string;
  /** Tool call ID that started this process (for UI to match) */
  toolCallId: string;
  /** Script being executed */
  script: string;
  /** Display name for the process (used as ID if sent to background) */
  displayName: string;
  /** Callback to invoke when user requests backgrounding */
  onBackground: () => void;
  /** Current accumulated output (for saving to files on background) */
  output: string[];
}

/**
 * Manages bash processes for workspaces.
 *
 * ALL bash commands are spawned through this manager with background-style
 * infrastructure (nohup, file output, exit code trap). This enables:
 * - Uniform code path for all bash commands
 * - Crash resilience (output always persisted to files)
 * - Seamless fg→bg transition via sendToBackground()
 *
 * Supports incremental output retrieval via getOutput().
 */
/**
 * Event types emitted by BackgroundProcessManager.
 * The 'change' event is emitted whenever the state changes for a workspace.
 */
export interface BackgroundProcessManagerEvents {
  change: [workspaceId: string];
}

export class BackgroundProcessManager extends EventEmitter<BackgroundProcessManagerEvents> {
  // NOTE: This map is in-memory only. Background processes use nohup/setsid so they
  // could survive app restarts, but we kill all tracked processes on shutdown via
  // dispose(). Rehydrating from meta.json on startup is out of scope for now.
  // All per-process state (read position, output lock) is stored in BackgroundProcess
  // so cleanup is automatic when the process is removed from this map.
  private processes = new Map<string, BackgroundProcess>();

  // Base directory for process output files
  private readonly bgOutputDir: string;
  // Tracks foreground processes (started via runtime.exec) that can be backgrounded
  // Key is toolCallId to support multiple parallel foreground processes per workspace
  private foregroundProcesses = new Map<string, ForegroundProcess>();
  // Tracks workspaces with queued messages (for bash_output to return early)
  private queuedMessageWorkspaces = new Set<string>();

  constructor(bgOutputDir: string) {
    super();
    // Background bash status can have many concurrent subscribers (e.g. multiple workspaces).
    // Raise the default listener cap to avoid noisy MaxListenersExceededWarning.
    this.setMaxListeners(50);
    this.bgOutputDir = bgOutputDir;
  }

  /**
   * Mark whether a workspace has a queued user message.
   * Used by bash_output to return early when user has sent a new message.
   */
  setMessageQueued(workspaceId: string, queued: boolean): void {
    if (queued) {
      this.queuedMessageWorkspaces.add(workspaceId);
    } else {
      this.queuedMessageWorkspaces.delete(workspaceId);
    }
  }

  /**
   * Check if a workspace has a queued user message.
   */
  hasQueuedMessage(workspaceId: string): boolean {
    return this.queuedMessageWorkspaces.has(workspaceId);
  }

  /** Emit a change event for a workspace */
  private emitChange(workspaceId: string): void {
    this.emit("change", workspaceId);
  }

  /**
   * Get the base directory for background process output files.
   */
  getBgOutputDir(): string {
    return this.bgOutputDir;
  }

  /**
   * Spawn a new process with background-style infrastructure.
   *
   * All processes are spawned with nohup/setsid and file-based output,
   * enabling seamless fg→bg transition via sendToBackground().
   *
   * @param runtime Runtime to spawn the process on
   * @param workspaceId Workspace ID for tracking/filtering
   * @param script Bash script to execute
   * @param config Execution configuration
   */
  async spawn(
    runtime: Runtime,
    workspaceId: string,
    script: string,
    config: {
      cwd: string;
      env?: Record<string, string>;
      niceness?: number;
      /** Human-readable name for the process - used to generate the process ID */
      displayName: string;
      /** If true, process is foreground (being waited on). Default: false (background) */
      isForeground?: boolean;
      /** Auto-terminate after this many seconds (background processes only) */
      timeoutSecs?: number;
    }
  ): Promise<
    | { success: true; processId: string; outputDir: string; pid: number }
    | { success: false; error: string }
  > {
    log.debug(`BackgroundProcessManager.spawn() called for workspace ${workspaceId}`);

    // Generate unique processId, appending (1), (2), etc. on collision
    let processId = config.displayName;
    let suffix = 1;
    while (this.processes.has(processId)) {
      processId = `${config.displayName} (${suffix})`;
      suffix++;
    }

    // Spawn via executor with background infrastructure
    // spawnProcess uses runtime.tempDir() internally for output directory
    const result = await spawnProcess(runtime, script, {
      cwd: config.cwd,
      workspaceId,
      processId,
      env: config.env,
      niceness: config.niceness,
    });

    if (!result.success) {
      log.debug(`BackgroundProcessManager: Failed to spawn: ${result.error}`);
      return { success: false, error: result.error };
    }

    const { handle, pid, outputDir } = result;
    const startTime = Date.now();

    // Write meta.json with process info
    const meta: BackgroundProcessMeta = {
      id: processId,
      pid,
      script,
      startTime,
      status: "running",
      displayName: config.displayName,
    };
    await handle.writeMeta(JSON.stringify(meta, null, 2));

    const proc: BackgroundProcess = {
      id: processId,
      pid,
      workspaceId,
      outputDir,
      script,
      startTime,
      status: "running",
      handle,
      displayName: config.displayName,
      isForeground: config.isForeground ?? false,
      outputBytesRead: 0,
      outputLock: new AsyncMutex(),
      getOutputCallCount: 0,
      incompleteLineBuffer: "",
    };

    // Store process in map
    this.processes.set(processId, proc);

    log.debug(
      `Process ${processId} spawned successfully with PID ${pid} (foreground: ${proc.isForeground})`
    );

    // Schedule auto-termination for background processes with timeout
    const timeoutSecs = config.timeoutSecs;
    if (!config.isForeground && timeoutSecs !== undefined && timeoutSecs > 0) {
      setTimeout(() => {
        void this.terminate(processId).then((result) => {
          if (result.success) {
            log.debug(`Process ${processId} auto-terminated after ${timeoutSecs}s timeout`);
          }
        });
      }, timeoutSecs * 1000);
    }

    // Emit change event (only if background - foreground processes don't show in list)
    if (!proc.isForeground) {
      this.emitChange(workspaceId);
    }

    return { success: true, processId, outputDir, pid };
  }

  /**
   * Register a foreground process that can be sent to background.
   * Called by bash tool when starting foreground execution.
   *
   * @param workspaceId Workspace the process belongs to
   * @param toolCallId Tool call ID (for UI to identify which bash row)
   * @param script Script being executed
   * @param onBackground Callback invoked when user requests backgrounding
   * @returns Cleanup function to call when process completes
   */
  registerForegroundProcess(
    workspaceId: string,
    toolCallId: string,
    script: string,
    displayName: string,
    onBackground: () => void
  ): { unregister: () => void; addOutput: (line: string) => void } {
    const proc: ForegroundProcess = {
      workspaceId,
      toolCallId,
      script,
      displayName,
      onBackground,
      output: [],
    };
    this.foregroundProcesses.set(toolCallId, proc);
    log.debug(
      `Registered foreground process for workspace ${workspaceId}, toolCallId ${toolCallId}`
    );
    this.emitChange(workspaceId);

    return {
      unregister: () => {
        this.foregroundProcesses.delete(toolCallId);
        log.debug(`Unregistered foreground process toolCallId ${toolCallId}`);
        this.emitChange(workspaceId);
      },
      addOutput: (line: string) => {
        proc.output.push(line);
      },
    };
  }

  /**
   * Register a migrated foreground process as a tracked background process.
   *
   * Called by bash tool when migration completes, after migrateToBackground()
   * has created the output directory and started file writing.
   *
   * @param handle The BackgroundHandle from migrateToBackground()
   * @param processId The generated process ID
   * @param workspaceId Workspace the process belongs to
   * @param script Original script being executed
   * @param outputDir Directory containing output files
   * @param displayName Optional human-readable name
   */
  registerMigratedProcess(
    handle: BackgroundHandle,
    processId: string,
    workspaceId: string,
    script: string,
    outputDir: string,
    displayName?: string
  ): void {
    const startTime = Date.now();

    const proc: BackgroundProcess = {
      id: processId,
      pid: 0, // Unknown for migrated processes (could be remote)
      workspaceId,
      outputDir,
      script,
      startTime,
      status: "running",
      handle,
      displayName,
      isForeground: false, // Now in background
      outputBytesRead: 0,
      outputLock: new AsyncMutex(),
      getOutputCallCount: 0,
      incompleteLineBuffer: "",
    };

    // Store process in map
    this.processes.set(processId, proc);

    // Write meta.json
    const meta: BackgroundProcessMeta = {
      id: processId,
      pid: 0,
      script,
      startTime,
      status: "running",
      displayName,
    };
    void handle.writeMeta(JSON.stringify(meta, null, 2));

    log.debug(`Migrated process ${processId} registered for workspace ${workspaceId}`);
    this.emitChange(workspaceId);
  }

  /**
   * Send a foreground process to background.
   *
   * For processes started with background infrastructure (isForeground=true in spawn):
   * - Marks as background and emits 'backgrounded' event
   *
   * For processes started via runtime.exec (tracked via registerForegroundProcess):
   * - Invokes the onBackground callback to trigger early return
   *
   * @param toolCallId The tool call ID of the bash to background
   * @returns Success status
   */
  sendToBackground(toolCallId: string): { success: true } | { success: false; error: string } {
    log.debug(`BackgroundProcessManager.sendToBackground(${toolCallId}) called`);

    const fgProc = this.foregroundProcesses.get(toolCallId);
    if (fgProc) {
      fgProc.onBackground();
      log.debug(`Foreground process toolCallId ${toolCallId} sent to background`);
      return { success: true };
    }

    return { success: false, error: "No foreground process found with that tool call ID" };
  }

  /**
   * Get all foreground tool call IDs for a workspace.
   * Returns empty array if no foreground processes are running.
   */
  getForegroundToolCallIds(workspaceId: string): string[] {
    const ids: string[] = [];
    // Check exec-based foreground processes
    for (const [toolCallId, proc] of this.foregroundProcesses) {
      if (proc.workspaceId === workspaceId) {
        ids.push(toolCallId);
      }
    }
    return ids;
  }

  /**
   * Write/update meta.json for a process
   */
  private async updateMetaFile(proc: BackgroundProcess): Promise<void> {
    const meta: BackgroundProcessMeta = {
      id: proc.id,
      pid: proc.pid,
      script: proc.script,
      startTime: proc.startTime,
      status: proc.status,
      exitCode: proc.exitCode,
      exitTime: proc.exitTime,
    };
    const metaJson = JSON.stringify(meta, null, 2);

    await proc.handle.writeMeta(metaJson);
  }

  /**
   * Get a background process by ID.
   * Refreshes status if the process is still marked as running.
   */
  async getProcess(processId: string): Promise<BackgroundProcess | null> {
    log.debug(`BackgroundProcessManager.getProcess(${processId}) called`);
    const proc = this.processes.get(processId);
    if (!proc) return null;

    // Refresh status if still running (exit code null = still running)
    if (proc.status === "running") {
      const exitCode = await proc.handle.getExitCode();
      if (exitCode !== null) {
        log.debug(`Background process ${proc.id} has exited`);
        proc.status = "exited";
        proc.exitCode = exitCode;
        proc.exitTime = Date.now();
        await this.updateMetaFile(proc).catch((err: unknown) => {
          log.debug(
            `BackgroundProcessManager: Failed to update meta.json: ${getErrorMessage(err)}`
          );
        });
        this.emitChange(proc.workspaceId);
      }
    }

    return proc;
  }

  /**
   * Get incremental output from a background process.
   * Returns only NEW output since the last call (tracked per process).
   * @param processId Process ID to get output from
   * @param filter Optional regex pattern to filter output lines (non-matching lines are discarded permanently)
   * @param filterExclude When true, invert filter to exclude matching lines instead of keeping them
   * @param timeout Seconds to wait for output if none available (default 0 = non-blocking)
   * @param abortSignal Optional signal to abort waiting early (e.g., when stream is cancelled)
   * @param workspaceId Optional workspace ID to check for queued messages (return early to process them)
   */
  async getOutput(
    processId: string,
    filter?: string,
    filterExclude?: boolean,
    timeout?: number,
    abortSignal?: AbortSignal,
    workspaceId?: string
  ): Promise<
    | {
        success: true;
        status: "running" | "exited" | "killed" | "failed" | "interrupted";
        output: string;
        exitCode?: number;
        elapsed_ms: number;
        note?: string;
      }
    | { success: false; error: string }
  > {
    const timeoutSecs = Math.max(timeout ?? 0, 0);
    log.debug(
      `BackgroundProcessManager.getOutput(${processId}, filter=${filter ?? "none"}, exclude=${filterExclude ?? false}, timeout=${timeoutSecs}s) called`
    );

    // Validate: filter_exclude requires filter
    if (filterExclude && !filter) {
      return { success: false, error: "filter_exclude requires filter to be set" };
    }

    const proc = await this.getProcess(processId);
    if (!proc) {
      return { success: false, error: `Process not found: ${processId}` };
    }

    // Acquire per-process mutex to serialize concurrent getOutput() calls.
    // This prevents race conditions where parallel tool calls both read from
    // the same offset before either updates the read position.
    await using _lock = await proc.outputLock.acquire();

    // Track call count for polling detection
    proc.getOutputCallCount++;
    const callCount = proc.getOutputCallCount;

    log.debug(
      `BackgroundProcessManager.getOutput: proc.outputDir=${proc.outputDir}, offset=${proc.outputBytesRead}, callCount=${callCount}`
    );

    // Pre-compile regex if filter is provided
    let filterRegex: RegExp | undefined;
    if (filter) {
      try {
        filterRegex = new RegExp(filter);
      } catch (e) {
        return { success: false, error: `Invalid filter regex: ${getErrorMessage(e)}` };
      }
    }

    // Apply filtering to complete lines only
    // Incomplete line fragments (no trailing newline) are kept in buffer for next read
    const applyFilter = (lines: string[]): string => {
      if (!filterRegex) return lines.join("\n");
      const filtered = filterExclude
        ? lines.filter((line) => !filterRegex.test(line))
        : lines.filter((line) => filterRegex.test(line));
      return filtered.join("\n");
    };

    // Blocking wait loop: poll for output up to timeout seconds
    const startTime = Date.now();
    const timeoutMs = timeoutSecs * 1000;
    const pollIntervalMs = 100;
    let accumulatedRaw = "";
    let currentStatus = proc.status;

    // Track the previous buffer to prepend to accumulated output
    const previousBuffer = proc.incompleteLineBuffer;

    while (true) {
      // Read new content via the handle (works for both local and SSH runtimes)
      // Output is already unified in output.log (stdout + stderr via 2>&1)
      const result = await proc.handle.readOutput(proc.outputBytesRead);
      accumulatedRaw += result.content;

      // Update read position
      proc.outputBytesRead = result.newOffset;

      // Refresh process status
      const refreshedProc = await this.getProcess(processId);
      currentStatus = refreshedProc?.status ?? proc.status;

      // Line-buffered filtering: prepend incomplete line from previous call
      const rawWithBuffer = previousBuffer + accumulatedRaw;
      const allLines = rawWithBuffer.split("\n");

      // Last element is incomplete if content doesn't end with newline
      const hasTrailingNewline = rawWithBuffer.endsWith("\n");
      const completeLines = hasTrailingNewline ? allLines.slice(0, -1) : allLines.slice(0, -1);

      // When using filter_exclude, check if we have meaningful (non-excluded) output.
      // We only consider complete lines as "meaningful" here; fragments are buffered for the next read.
      const filteredOutput = applyFilter(completeLines);
      const hasMeaningfulOutput = filterExclude
        ? filteredOutput.trim().length > 0
        : completeLines.length > 0;

      // Return immediately if:
      // 1. We have meaningful output (after filtering if filter_exclude is set)
      // 2. Timeout elapsed
      // 3. Abort signal received (user sent a new message)
      if (hasMeaningfulOutput) {
        break;
      }

      // If the process is no longer running (exited/killed/failed), do one last read
      // to avoid dropping output that arrives between our readOutput() call and
      // the status refresh.
      if (currentStatus !== "running") {
        while (true) {
          const finalRead = await proc.handle.readOutput(proc.outputBytesRead);
          if (finalRead.content.length === 0) {
            break;
          }

          // Defensive: avoid infinite loops if a handle returns inconsistent offsets.
          if (finalRead.newOffset <= proc.outputBytesRead) {
            break;
          }

          accumulatedRaw += finalRead.content;
          proc.outputBytesRead = finalRead.newOffset;
        }

        break;
      }

      if (abortSignal?.aborted || (workspaceId && this.hasQueuedMessage(workspaceId))) {
        const elapsed_ms = Date.now() - startTime;
        return {
          success: true,
          status: "interrupted",
          output: "(waiting interrupted)",
          elapsed_ms,
        };
      }

      const elapsed = Date.now() - startTime;
      if (elapsed >= timeoutMs) {
        break;
      }

      // Sleep before next poll
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    // Final line processing with buffer from previous call

    // If the process exited, do a final drain of output.
    //
    // Rationale: stdout/stderr writes can land just after we observe that the process
    // has exited. Without a final drain, we can return "exited" with empty output
    // even though output becomes available moments later.
    if (currentStatus !== "running") {
      const offsetBeforeDrain = proc.outputBytesRead;

      while (true) {
        const extra = await proc.handle.readOutput(proc.outputBytesRead);
        if (extra.content.length === 0) {
          break;
        }
        accumulatedRaw += extra.content;
        proc.outputBytesRead = extra.newOffset;
      }

      // If we didn't observe any new output, wait one poll interval and try once more.
      if (proc.outputBytesRead === offsetBeforeDrain) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

        while (true) {
          const extra = await proc.handle.readOutput(proc.outputBytesRead);
          if (extra.content.length === 0) {
            break;
          }
          accumulatedRaw += extra.content;
          proc.outputBytesRead = extra.newOffset;
        }
      }
    }
    const rawWithBuffer = previousBuffer + accumulatedRaw;
    const allLines = rawWithBuffer.split("\n");
    const hasTrailingNewline = rawWithBuffer.endsWith("\n");

    // On process exit, include incomplete line; otherwise keep it buffered
    const linesToReturn =
      currentStatus !== "running"
        ? allLines.filter((l) => l.length > 0) // Include all non-empty lines on exit
        : hasTrailingNewline
          ? allLines.slice(0, -1)
          : allLines.slice(0, -1);

    // Update buffer for next call (clear on exit, keep incomplete line otherwise)
    proc.incompleteLineBuffer =
      currentStatus === "running" && !hasTrailingNewline ? allLines[allLines.length - 1] : "";

    log.debug(
      `BackgroundProcessManager.getOutput: read rawLen=${accumulatedRaw.length}, completeLines=${linesToReturn.length}`
    );

    const filteredOutput = applyFilter(linesToReturn);

    // Suggest filter_exclude if polling too frequently on a running process
    const shouldSuggestFilterExclude =
      callCount >= 3 && !filterExclude && currentStatus === "running";

    // Suggest better pattern if using filter_exclude but still polling frequently
    const shouldSuggestBetterPattern =
      callCount >= 3 && filterExclude && currentStatus === "running";

    let note: string | undefined;
    if (shouldSuggestFilterExclude) {
      note =
        "STOP POLLING. You've called bash_output 3+ times on this process. " +
        "This wastes tokens and clutters the conversation. " +
        "Instead, make ONE call with: filter='⏳|progress|waiting|\\\\\\.\\\\\\.\\\\\\.', " +
        "filter_exclude=true, timeout_secs=120. This blocks until meaningful output arrives.";
    } else if (shouldSuggestBetterPattern) {
      note =
        "You're using filter_exclude but still polling frequently. " +
        "Your filter pattern may not be matching the actual output. " +
        "Try a broader pattern like: filter='\\\\.|\\\\d+%|running|progress|pending|⏳|waiting'. " +
        "Wait for the FULL timeout before checking again.";
    }

    return {
      success: true,
      status: currentStatus,
      output: filteredOutput,
      exitCode:
        currentStatus !== "running"
          ? ((await this.getProcess(processId))?.exitCode ?? undefined)
          : undefined,
      elapsed_ms: Date.now() - startTime,
      note,
    };
  }

  /**
   * List background processes (not including foreground ones being waited on).
   * Optionally filtered by workspace.
   * Refreshes status of running processes before returning.
   */
  async list(workspaceId?: string): Promise<BackgroundProcess[]> {
    log.debug(`BackgroundProcessManager.list(${workspaceId ?? "all"}) called`);
    await this.refreshRunningStatuses();
    // Only return background processes (not foreground ones being waited on)
    const backgroundProcesses = Array.from(this.processes.values()).filter((p) => !p.isForeground);
    return workspaceId
      ? backgroundProcesses.filter((p) => p.workspaceId === workspaceId)
      : backgroundProcesses;
  }

  /**
   * Check all "running" processes and update status if they've exited.
   * Called lazily from list() to avoid polling overhead.
   */
  private async refreshRunningStatuses(): Promise<void> {
    const runningProcesses = Array.from(this.processes.values()).filter(
      (p) => p.status === "running"
    );

    for (const proc of runningProcesses) {
      const exitCode = await proc.handle.getExitCode();
      if (exitCode !== null) {
        log.debug(`Background process ${proc.id} has exited`);
        proc.status = "exited";
        proc.exitCode = exitCode;
        proc.exitTime = Date.now();
        await this.updateMetaFile(proc).catch((err: unknown) => {
          log.debug(
            `BackgroundProcessManager: Failed to update meta.json: ${getErrorMessage(err)}`
          );
        });
        this.emitChange(proc.workspaceId);
      }
    }
  }

  /**
   * Terminate a background process
   */
  async terminate(
    processId: string
  ): Promise<{ success: true } | { success: false; error: string }> {
    log.debug(`BackgroundProcessManager.terminate(${processId}) called`);

    // Get process from Map
    const proc = this.processes.get(processId);
    if (!proc) {
      return { success: false, error: `Process not found: ${processId}` };
    }

    // If already terminated, return success (idempotent)
    if (proc.status === "exited" || proc.status === "killed" || proc.status === "failed") {
      log.debug(`Process ${processId} already terminated with status: ${proc.status}`);
      return { success: true };
    }

    try {
      await proc.handle.terminate();

      // Update process status and exit code
      proc.status = "killed";
      proc.exitCode = (await proc.handle.getExitCode()) ?? undefined;
      proc.exitTime ??= Date.now();

      // Update meta.json
      await this.updateMetaFile(proc).catch((err: unknown) => {
        log.debug(`BackgroundProcessManager: Failed to update meta.json: ${getErrorMessage(err)}`);
      });

      // Dispose of the handle
      await proc.handle.dispose();

      log.debug(`Process ${processId} terminated successfully`);
      this.emitChange(proc.workspaceId);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.debug(`Error terminating process ${processId}: ${errorMessage}`);
      // Mark as killed even if there was an error (process likely already dead)
      proc.status = "killed";
      proc.exitTime ??= Date.now();
      // Update meta.json
      await this.updateMetaFile(proc).catch((err: unknown) => {
        log.debug(`BackgroundProcessManager: Failed to update meta.json: ${getErrorMessage(err)}`);
      });
      // Ensure handle is cleaned up even on error
      await proc.handle.dispose();
      this.emitChange(proc.workspaceId);
      return { success: true };
    }
  }

  /**
   * Terminate all background processes across all workspaces.
   * Called during app shutdown to prevent orphaned processes.
   */
  async terminateAll(): Promise<void> {
    log.debug(`BackgroundProcessManager.terminateAll() called`);
    const allProcesses = Array.from(this.processes.values());
    await Promise.all(allProcesses.map((p) => this.terminate(p.id)));
    this.processes.clear();
    log.debug(`Terminated ${allProcesses.length} background process(es)`);
  }

  /**
   * Clean up all processes for a workspace.
   * Terminates running processes and removes from memory.
   * Output directories are left on disk (cleaned by OS for /tmp, or on workspace deletion for local).
   */
  async cleanup(workspaceId: string): Promise<void> {
    log.debug(`BackgroundProcessManager.cleanup(${workspaceId}) called`);
    const matching = Array.from(this.processes.values()).filter(
      (p) => p.workspaceId === workspaceId
    );

    // Terminate all running processes
    await Promise.all(matching.map((p) => this.terminate(p.id)));

    // Remove from memory (output dirs left on disk for OS/workspace cleanup)
    // All per-process state (outputBytesRead, outputLock) is stored in the
    // BackgroundProcess object, so cleanup is automatic when we delete here.
    for (const p of matching) {
      this.processes.delete(p.id);
    }

    log.debug(`Cleaned up ${matching.length} process(es) for workspace ${workspaceId}`);
  }
}
