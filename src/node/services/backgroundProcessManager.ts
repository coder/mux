import type { Runtime, BackgroundHandle } from "@/node/runtime/Runtime";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "./log";
import * as path from "path";

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
  id: string; // Short unique ID (e.g., "bg-abc123")
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
}

/**
 * Manages background bash processes for workspaces.
 *
 * Processes are spawned via Runtime.spawnBackground() and tracked by ID.
 * Output is stored in circular buffers for later retrieval.
 */
export class BackgroundProcessManager {
  // NOTE: This map is in-memory only. Background processes use nohup/setsid so they
  // could survive app restarts, but we kill all tracked processes on shutdown via
  // dispose(). Rehydrating from meta.json on startup is out of scope for now.
  private processes = new Map<string, BackgroundProcess>();

  /**
   * Spawn a new background process.
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
      secrets?: Record<string, string>;
      niceness?: number;
      displayName?: string;
    }
  ): Promise<
    { success: true; processId: string; outputDir: string } | { success: false; error: string }
  > {
    log.debug(`BackgroundProcessManager.spawn() called for workspace ${workspaceId}`);

    // Spawn via runtime - it generates processId and creates outputDir
    const result = await runtime.spawnBackground(script, {
      cwd: config.cwd,
      workspaceId,
      env: config.secrets,
      niceness: config.niceness,
    });

    if (!result.success) {
      log.debug(`BackgroundProcessManager: Failed to spawn: ${result.error}`);
      return { success: false, error: result.error };
    }

    const { handle, pid } = result;
    const outputDir = handle.outputDir;
    // Extract processId from outputDir (last path segment)
    const processId = path.basename(outputDir);
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
    };

    // Store process in map
    this.processes.set(processId, proc);

    log.debug(`Background process ${processId} spawned successfully with PID ${pid}`);
    return { success: true, processId, outputDir };
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
   * List all background processes, optionally filtered by workspace.
   * Refreshes status of running processes before returning.
   */
  async list(workspaceId?: string): Promise<BackgroundProcess[]> {
    log.debug(`BackgroundProcessManager.list(${workspaceId ?? "all"}) called`);
    await this.refreshRunningStatuses();
    const allProcesses = Array.from(this.processes.values());
    return workspaceId ? allProcesses.filter((p) => p.workspaceId === workspaceId) : allProcesses;
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
