import type {
  BashExecutionService,
  BashExecutionConfig,
  DisposableProcess,
} from "./bashExecutionService";
import { log } from "./log";
import { randomBytes } from "crypto";
import { once } from "node:events";
import { CircularBuffer } from "./circularBuffer";

/**
 * Represents a background process with buffered output
 */
export interface BackgroundProcess {
  id: string; // Short unique ID (e.g., "bg-abc123")
  workspaceId: string; // Owning workspace
  script: string; // Original command
  pid?: number; // Process ID (undefined if spawn failed)
  startTime: number; // Timestamp when started
  stdoutBuffer: CircularBuffer<string>; // Circular buffer (max 1000 lines)
  stderrBuffer: CircularBuffer<string>; // Circular buffer (max 1000 lines)
  exitCode?: number; // Undefined if still running
  exitTime?: number; // Timestamp when exited (undefined if running)
  status: "running" | "exited" | "killed" | "failed";
  disposable: DisposableProcess | null; // For process cleanup
}

const MAX_BUFFER_LINES = 1000;

/**
 * Manages background bash processes for workspaces
 */
export class BackgroundProcessManager {
  private processes = new Map<string, BackgroundProcess>();

  constructor(private readonly bashExecutionService: BashExecutionService) {}

  /**
   * Spawn a new background process
   */
  async spawn(
    workspaceId: string,
    script: string,
    config: BashExecutionConfig
  ): Promise<{ success: true; processId: string } | { success: false; error: string }> {
    log.debug(`BackgroundProcessManager.spawn() called for workspace ${workspaceId}`);

    // Generate unique process ID
    const processId = `bg-${randomBytes(4).toString("hex")}`;

    // Create circular buffers for output
    const stdoutBuffer = new CircularBuffer<string>(MAX_BUFFER_LINES);
    const stderrBuffer = new CircularBuffer<string>(MAX_BUFFER_LINES);

    const process: BackgroundProcess = {
      id: processId,
      workspaceId,
      script,
      startTime: Date.now(),
      stdoutBuffer,
      stderrBuffer,
      status: "running",
      disposable: null,
    };

    // Spawn with streaming callbacks
    const disposable = this.bashExecutionService.executeStreaming(script, config, {
      onStdout: (line: string) => {
        stdoutBuffer.push(line);
      },
      onStderr: (line: string) => {
        stderrBuffer.push(line);
      },
      onExit: (exitCode: number) => {
        log.debug(`Background process ${processId} exited with code ${exitCode}`);
        process.exitCode = exitCode;
        process.exitTime ??= Date.now();
        // Don't overwrite status if already marked as killed/failed by terminate()
        if (process.status === "running") {
          process.status = "exited";
        }
      },
    });

    const child = disposable.child;

    // Wait until we know whether the spawn succeeded or failed
    // ChildProcess emits either 'spawn' (success) or 'error' (failure) - mutually exclusive
    try {
      await Promise.race([
        // Successful spawn
        once(child, "spawn"),

        // Spawn error (ENOENT, invalid cwd, etc.)
        once(child, "error").then(([err]) => {
          throw err;
        }),

        // Safety timeout to prevent infinite hang
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Spawn did not complete in time")), 2000)
        ),
      ]);
    } catch (e) {
      const err = e as Error;
      log.debug(`Failed to spawn background process: ${err.message}`);
      disposable[Symbol.dispose]();
      return {
        success: false,
        error: err.message,
      };
    }

    // At this point we know the process spawned successfully
    process.disposable = disposable;
    process.pid = child.pid ?? undefined;

    // Store process in map
    this.processes.set(processId, process);

    log.debug(`Background process ${processId} spawned with PID ${process.pid ?? "unknown"}`);
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

    // Check if we have a valid PID
    if (!proc.pid || !proc.disposable) {
      log.debug(`Process ${processId} has no PID or disposable, marking as failed`);
      proc.status = "failed";
      proc.exitTime = Date.now();
      return { success: true };
    }

    try {
      // Send SIGTERM to the process group for graceful shutdown
      // Use negative PID to kill the entire process group (detached processes are group leaders)
      // This ensures child processes (e.g., from npm run dev) are also terminated
      const pgid = -proc.pid;
      log.debug(`Sending SIGTERM to process group ${processId} (PGID: ${pgid})`);
      process.kill(pgid, "SIGTERM");

      // Wait 2 seconds for graceful shutdown
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Check if process is still running
      const stillRunning = proc.disposable.child.exitCode === null;

      if (stillRunning) {
        // Force kill the process group with SIGKILL
        log.debug(`Process group ${processId} still running, sending SIGKILL`);
        process.kill(pgid, "SIGKILL");
      }

      // Update process status
      proc.status = "killed";
      proc.exitTime ??= Date.now();

      // Dispose of the process
      proc.disposable[Symbol.dispose]();

      log.debug(`Process ${processId} terminated successfully`);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.debug(`Error terminating process ${processId}: ${errorMessage}`);
      // Mark as killed even if there was an error (process likely already dead)
      proc.status = "killed";
      proc.exitTime ??= Date.now();
      // Ensure disposable is cleaned up even on error
      if (proc.disposable) {
        proc.disposable[Symbol.dispose]();
      }
      return { success: true };
    }
  }

  /**
   * Clean up all processes for a workspace
   * Terminates running processes and removes them from memory
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
    log.debug(`Cleaned up ${matching.length} process(es) for workspace ${workspaceId}`);
  }
}
