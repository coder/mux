/**
 * Local background executor implementation.
 *
 * Uses BashExecutionService to spawn detached process groups on the local machine.
 * Output is streamed in real-time via callbacks.
 */

import { once } from "node:events";
import type {
  BackgroundExecutor,
  BackgroundExecConfig,
  BackgroundHandle,
  BackgroundSpawnResult,
} from "./backgroundExecutor";
import type { BashExecutionService, DisposableProcess } from "./bashExecutionService";
import { log } from "./log";

/**
 * Handle to a local background process
 *
 * Buffers early events until callbacks are registered, since the manager
 * registers callbacks after spawn() returns (but output may arrive before).
 */
class LocalBackgroundHandle implements BackgroundHandle {
  private stdoutCallback?: (line: string) => void;
  private stderrCallback?: (line: string) => void;
  private exitCallback?: (exitCode: number) => void;
  private terminated = false;

  // Buffers for events that arrive before callbacks are registered
  private pendingStdout: string[] = [];
  private pendingStderr: string[] = [];
  private pendingExitCode?: number;

  constructor(private readonly disposable: DisposableProcess) {}

  onStdout(callback: (line: string) => void): void {
    this.stdoutCallback = callback;
    // Flush buffered events
    for (const line of this.pendingStdout) {
      callback(line);
    }
    this.pendingStdout = [];
  }

  onStderr(callback: (line: string) => void): void {
    this.stderrCallback = callback;
    // Flush buffered events
    for (const line of this.pendingStderr) {
      callback(line);
    }
    this.pendingStderr = [];
  }

  onExit(callback: (exitCode: number) => void): void {
    this.exitCallback = callback;
    // Flush buffered event
    if (this.pendingExitCode !== undefined) {
      callback(this.pendingExitCode);
      this.pendingExitCode = undefined;
    }
  }

  /** Internal: called by executor when stdout line arrives */
  _emitStdout(line: string): void {
    if (this.stdoutCallback) {
      this.stdoutCallback(line);
    } else {
      this.pendingStdout.push(line);
    }
  }

  /** Internal: called by executor when stderr line arrives */
  _emitStderr(line: string): void {
    if (this.stderrCallback) {
      this.stderrCallback(line);
    } else {
      this.pendingStderr.push(line);
    }
  }

  /** Internal: called by executor when process exits */
  _emitExit(exitCode: number): void {
    if (this.exitCallback) {
      this.exitCallback(exitCode);
    } else {
      this.pendingExitCode = exitCode;
    }
  }

  async isRunning(): Promise<boolean> {
    return this.disposable.child.exitCode === null;
  }

  async terminate(): Promise<void> {
    if (this.terminated) return;

    const pid = this.disposable.child.pid;
    if (pid === undefined) {
      this.terminated = true;
      return;
    }

    try {
      // Send SIGTERM to the process group for graceful shutdown
      // Use negative PID to kill the entire process group (detached processes are group leaders)
      const pgid = -pid;
      log.debug(`LocalBackgroundHandle: Sending SIGTERM to process group (PGID: ${pgid})`);
      process.kill(pgid, "SIGTERM");

      // Wait 2 seconds for graceful shutdown
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Check if process is still running
      if (await this.isRunning()) {
        log.debug(`LocalBackgroundHandle: Process still running, sending SIGKILL`);
        process.kill(pgid, "SIGKILL");
      }
    } catch (error) {
      // Process may already be dead - that's fine
      log.debug(
        `LocalBackgroundHandle: Error during terminate: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    this.terminated = true;
  }

  async dispose(): Promise<void> {
    this.disposable[Symbol.dispose]();
  }

  /** Get the child process (for spawn event waiting) */
  get child() {
    return this.disposable.child;
  }
}

/**
 * Local background executor using BashExecutionService
 */
export class LocalBackgroundExecutor implements BackgroundExecutor {
  constructor(private readonly bashService: BashExecutionService) {}

  async spawn(script: string, config: BackgroundExecConfig): Promise<BackgroundSpawnResult> {
    log.debug(`LocalBackgroundExecutor: Spawning background process in ${config.cwd}`);

    // Create handle first so we can wire up callbacks
    let handle: LocalBackgroundHandle;

    // Spawn with streaming callbacks that forward to handle
    const disposable = this.bashService.executeStreaming(
      script,
      {
        cwd: config.cwd,
        secrets: config.env,
        niceness: config.niceness,
        detached: true,
      },
      {
        onStdout: (line: string) => handle._emitStdout(line),
        onStderr: (line: string) => handle._emitStderr(line),
        onExit: (exitCode: number) => handle._emitExit(exitCode),
      }
    );

    handle = new LocalBackgroundHandle(disposable);

    // Wait until we know whether the spawn succeeded or failed
    // ChildProcess emits either 'spawn' (success) or 'error' (failure) - mutually exclusive
    try {
      await Promise.race([
        // Successful spawn
        once(handle.child, "spawn"),

        // Spawn error (ENOENT, invalid cwd, etc.)
        once(handle.child, "error").then(([err]) => {
          throw err;
        }),

        // Safety timeout to prevent infinite hang
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Spawn did not complete in time")), 2000)
        ),
      ]);
    } catch (e) {
      const err = e as Error;
      log.debug(`LocalBackgroundExecutor: Failed to spawn: ${err.message}`);
      await handle.dispose();
      return { success: false, error: err.message };
    }

    log.debug(
      `LocalBackgroundExecutor: Process spawned with PID ${handle.child.pid ?? "unknown"}`
    );
    return { success: true, handle };
  }
}
