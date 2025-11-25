import type { BackgroundExecutor, BackgroundHandle } from "./backgroundExecutor";
import { log } from "./log";
import { randomBytes } from "crypto";
import { CircularBuffer } from "./circularBuffer";

/**
 * Represents a background process with buffered output
 */
export interface BackgroundProcess {
  id: string; // Short unique ID (e.g., "bg-abc123")
  workspaceId: string; // Owning workspace
  script: string; // Original command
  startTime: number; // Timestamp when started
  stdoutBuffer: CircularBuffer<string>; // Circular buffer (max 1000 lines)
  stderrBuffer: CircularBuffer<string>; // Circular buffer (max 1000 lines)
  exitCode?: number; // Undefined if still running
  exitTime?: number; // Timestamp when exited (undefined if running)
  status: "running" | "exited" | "killed" | "failed";
  handle: BackgroundHandle | null; // For process interaction
}

const MAX_BUFFER_LINES = 1000;

/**
 * Manages background bash processes for workspaces.
 *
 * Executors are provided lazily at spawn time and cached per workspace.
 * This allows different execution backends per workspace (local vs SSH).
 */
export class BackgroundProcessManager {
  private processes = new Map<string, BackgroundProcess>();
  private executors = new Map<string, BackgroundExecutor>();

  /**
   * Spawn a new background process.
   * The executor is cached on first spawn per workspace for reuse (e.g., SSH connection pooling).
   */
  async spawn(
    executor: BackgroundExecutor,
    workspaceId: string,
    script: string,
    config: { cwd: string; secrets?: Record<string, string>; niceness?: number }
  ): Promise<{ success: true; processId: string } | { success: false; error: string }> {
    log.debug(`BackgroundProcessManager.spawn() called for workspace ${workspaceId}`);

    // Cache executor on first spawn for this workspace (enables SSH connection reuse)
    if (!this.executors.has(workspaceId)) {
      this.executors.set(workspaceId, executor);
    }

    // Generate unique process ID
    const processId = `bg-${randomBytes(4).toString("hex")}`;

    // Create circular buffers for output
    const stdoutBuffer = new CircularBuffer<string>(MAX_BUFFER_LINES);
    const stderrBuffer = new CircularBuffer<string>(MAX_BUFFER_LINES);

    const proc: BackgroundProcess = {
      id: processId,
      workspaceId,
      script,
      startTime: Date.now(),
      stdoutBuffer,
      stderrBuffer,
      status: "running",
      handle: null,
    };

    // Spawn via executor
    const result = await executor.spawn(script, {
      cwd: config.cwd,
      env: config.secrets,
      niceness: config.niceness,
    });

    if (!result.success) {
      log.debug(`BackgroundProcessManager: Failed to spawn: ${result.error}`);
      return { success: false, error: result.error };
    }

    const handle = result.handle;

    // Wire up callbacks to buffers
    handle.onStdout((line: string) => {
      stdoutBuffer.push(line);
    });

    handle.onStderr((line: string) => {
      stderrBuffer.push(line);
    });

    handle.onExit((exitCode: number) => {
      log.debug(`Background process ${processId} exited with code ${exitCode}`);
      proc.exitCode = exitCode;
      proc.exitTime ??= Date.now();
      // Don't overwrite status if already marked as killed/failed by terminate()
      if (proc.status === "running") {
        proc.status = "exited";
      }
    });

    proc.handle = handle;

    // Store process in map
    this.processes.set(processId, proc);

    log.debug(`Background process ${processId} spawned successfully`);
    return { success: true, processId };
  }

  /**
   * Get a background process by ID
   */
  getProcess(processId: string): BackgroundProcess | null {
    log.debug(`BackgroundProcessManager.getProcess(${processId}) called`);
    return this.processes.get(processId) ?? null;
  }

  /**
   * List all background processes, optionally filtered by workspace
   */
  list(workspaceId?: string): BackgroundProcess[] {
    log.debug(`BackgroundProcessManager.list(${workspaceId ?? "all"}) called`);
    const allProcesses = Array.from(this.processes.values());
    return workspaceId ? allProcesses.filter((p) => p.workspaceId === workspaceId) : allProcesses;
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

    // Check if we have a valid handle
    if (!proc.handle) {
      log.debug(`Process ${processId} has no handle, marking as failed`);
      proc.status = "failed";
      proc.exitTime = Date.now();
      return { success: true };
    }

    try {
      await proc.handle.terminate();

      // Update process status
      proc.status = "killed";
      proc.exitTime ??= Date.now();

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
      // Ensure handle is cleaned up even on error
      if (proc.handle) {
        await proc.handle.dispose();
      }
      return { success: true };
    }
  }

  /**
   * Clean up all processes for a workspace.
   * Terminates running processes, removes them from memory, and clears the cached executor.
   */
  async cleanup(workspaceId: string): Promise<void> {
    log.debug(`BackgroundProcessManager.cleanup(${workspaceId}) called`);
    const matching = Array.from(this.processes.values()).filter(
      (p) => p.workspaceId === workspaceId
    );

    // Terminate all running processes
    await Promise.all(matching.map((p) => this.terminate(p.id)));

    // Remove all processes from memory
    matching.forEach((p) => this.processes.delete(p.id));

    // Clear cached executor for this workspace
    this.executors.delete(workspaceId);

    log.debug(`Cleaned up ${matching.length} process(es) for workspace ${workspaceId}`);
  }
}
