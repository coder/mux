import type { Runtime, BackgroundHandle } from "@/node/runtime/Runtime";
import { spawnProcess } from "./backgroundProcessExecutor";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "./log";

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
 * Represents a background process with file-based output
 */
export interface BackgroundProcess {
  id: string; // Sequential ID (e.g., "bash_1", "bash_2")
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
}

/**
 * Tracks read position for incremental output retrieval.
 * Each call to getOutput() returns only new content since the last read.
 */
interface OutputReadPosition {
  stdoutBytes: number;
  stderrBytes: number;
}

/**
 * Represents a foreground process that can be sent to background.
 * These are processes started via runtime.exec() (not nohup) that we track
 * so users can click "Background" to stop waiting for them.
 */
export interface ForegroundProcess {
  /** Workspace ID */
  workspaceId: string;
  /** Script being executed */
  script: string;
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
export class BackgroundProcessManager extends EventEmitter {
  // NOTE: This map is in-memory only. Background processes use nohup/setsid so they
  // could survive app restarts, but we kill all tracked processes on shutdown via
  // dispose(). Rehydrating from meta.json on startup is out of scope for now.
  private processes = new Map<string, BackgroundProcess>();

  // Tracks read positions for incremental output retrieval
  private readPositions = new Map<string, OutputReadPosition>();

  // Counter for generating sequential process IDs (bash_1, bash_2, etc.)
  private nextProcessNumber = 1;

  // Base directory for process output files
  private readonly bgOutputDir: string;

  // Tracks foreground processes (started via runtime.exec) that can be backgrounded
  // Key is workspaceId since only one foreground process runs at a time per workspace
  private foregroundProcesses = new Map<string, ForegroundProcess>();

  constructor(bgOutputDir: string) {
    super();
    this.bgOutputDir = bgOutputDir;
  }

  /**
   * Get the base directory for background process output files.
   */
  getBgOutputDir(): string {
    return this.bgOutputDir;
  }

  /**
   * Generate a unique sequential process ID (bash_1, bash_2, etc.)
   * Follows Claude Code's ID format for consistency.
   */
  generateProcessId(): string {
    return `bash_${this.nextProcessNumber++}`;
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
      displayName?: string;
      /** If true, process is foreground (being waited on). Default: false (background) */
      isForeground?: boolean;
    }
  ): Promise<
    | { success: true; processId: string; outputDir: string; pid: number }
    | { success: false; error: string }
  > {
    log.debug(`BackgroundProcessManager.spawn() called for workspace ${workspaceId}`);

    // Generate sequential process ID (bash_1, bash_2, etc.)
    const processId = this.generateProcessId();

    // Spawn via executor with background infrastructure
    const result = await spawnProcess(
      runtime,
      script,
      {
        cwd: config.cwd,
        workspaceId,
        processId,
        env: config.env,
        niceness: config.niceness,
      },
      this.bgOutputDir
    );

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
    };

    // Store process in map
    this.processes.set(processId, proc);

    log.debug(
      `Process ${processId} spawned successfully with PID ${pid} (foreground: ${proc.isForeground})`
    );
    return { success: true, processId, outputDir, pid };
  }

  /**
   * Register a foreground process that can be sent to background.
   * Called by bash tool when starting foreground execution.
   *
   * @param workspaceId Workspace the process belongs to
   * @param script Script being executed
   * @param onBackground Callback invoked when user requests backgrounding
   * @returns Cleanup function to call when process completes
   */
  registerForegroundProcess(
    workspaceId: string,
    script: string,
    onBackground: () => void
  ): { unregister: () => void; addOutput: (line: string) => void } {
    const proc: ForegroundProcess = {
      workspaceId,
      script,
      onBackground,
      output: [],
    };
    this.foregroundProcesses.set(workspaceId, proc);
    log.debug(`Registered foreground process for workspace ${workspaceId}`);

    return {
      unregister: () => {
        this.foregroundProcesses.delete(workspaceId);
        log.debug(`Unregistered foreground process for workspace ${workspaceId}`);
      },
      addOutput: (line: string) => {
        proc.output.push(line);
      },
    };
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
   * @param workspaceId Workspace to find the foreground process in
   * @returns Success status
   */
  sendToBackground(workspaceId: string): { success: true } | { success: false; error: string } {
    log.debug(`BackgroundProcessManager.sendToBackground(${workspaceId}) called`);

    // First check for background-infrastructure processes (spawned via this.spawn)
    const bgProc = Array.from(this.processes.values()).find(
      (p) => p.workspaceId === workspaceId && p.isForeground && p.status === "running"
    );

    if (bgProc) {
      // Mark as background
      bgProc.isForeground = false;
      // Emit event to signal the waiter to return
      this.emit("backgrounded", bgProc.id);
      log.debug(`Background-infrastructure process ${bgProc.id} sent to background`);
      return { success: true };
    }

    // Check for foreground processes (started via runtime.exec)
    const fgProc = this.foregroundProcesses.get(workspaceId);
    if (fgProc) {
      // Invoke callback to trigger early return
      fgProc.onBackground();
      log.debug(`Foreground process for workspace ${workspaceId} sent to background`);
      return { success: true };
    }

    return { success: false, error: "No foreground process found for this workspace" };
  }

  /**
   * Check if a workspace has a foreground process running.
   */
  hasForegroundProcess(workspaceId: string): boolean {
    // Check background-infrastructure processes
    const hasBgProc = Array.from(this.processes.values()).some(
      (p) => p.workspaceId === workspaceId && p.isForeground && p.status === "running"
    );
    // Check exec-based foreground processes
    const hasFgProc = this.foregroundProcesses.has(workspaceId);
    return hasBgProc || hasFgProc;
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
      }
    }

    return proc;
  }

  /**
   * Get incremental output from a background process.
   * Returns only NEW output since the last call (tracked per process).
   * @param processId Process ID to get output from
   * @param filter Optional regex pattern to filter output lines (non-matching lines are discarded permanently)
   */
  async getOutput(
    processId: string,
    filter?: string
  ): Promise<
    | {
        success: true;
        status: "running" | "exited" | "killed" | "failed";
        stdout: string;
        stderr: string;
        exitCode?: number;
      }
    | { success: false; error: string }
  > {
    log.debug(
      `BackgroundProcessManager.getOutput(${processId}, filter=${filter ?? "none"}) called`
    );

    const proc = await this.getProcess(processId);
    if (!proc) {
      return { success: false, error: `Process not found: ${processId}` };
    }

    // Get or initialize read position
    let pos = this.readPositions.get(processId);
    if (!pos) {
      pos = { stdoutBytes: 0, stderrBytes: 0 };
      this.readPositions.set(processId, pos);
    }

    log.debug(
      `BackgroundProcessManager.getOutput: proc.outputDir=${proc.outputDir}, stdoutOffset=${pos.stdoutBytes}, stderrOffset=${pos.stderrBytes}`
    );

    // Read new content via the handle (works for both local and SSH runtimes)
    const [stdoutResult, stderrResult] = await Promise.all([
      proc.handle.readOutput("stdout.log", pos.stdoutBytes),
      proc.handle.readOutput("stderr.log", pos.stderrBytes),
    ]);

    const stdout = stdoutResult.content;
    const stderr = stderrResult.content;

    log.debug(
      `BackgroundProcessManager.getOutput: read stdoutLen=${stdout.length}, stderrLen=${stderr.length}`
    );

    // Update read positions
    pos.stdoutBytes = stdoutResult.newOffset;
    pos.stderrBytes = stderrResult.newOffset;

    // Apply filter if provided (permanently discards non-matching lines)
    let filteredStdout = stdout;
    let filteredStderr = stderr;
    if (filter) {
      try {
        const regex = new RegExp(filter);
        filteredStdout = stdout
          .split("\n")
          .filter((line) => regex.test(line))
          .join("\n");
        filteredStderr = stderr
          .split("\n")
          .filter((line) => regex.test(line))
          .join("\n");
      } catch (e) {
        return { success: false, error: `Invalid filter regex: ${getErrorMessage(e)}` };
      }
    }

    return {
      success: true,
      status: proc.status,
      stdout: filteredStdout,
      stderr: filteredStderr,
      exitCode: proc.exitCode,
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
    for (const p of matching) {
      this.processes.delete(p.id);
    }

    log.debug(`Cleaned up ${matching.length} process(es) for workspace ${workspaceId}`);
  }
}
