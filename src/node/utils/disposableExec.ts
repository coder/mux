import { exec, execFileSync, spawn } from "child_process";
import type { ChildProcess } from "child_process";

export function killProcessTree(pid: number): void {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }

  // process.kill(-pid) is Unix-only; on Windows we must use taskkill to kill the full tree.
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // Ignore errors - process may already have exited.
    }

    return;
  }

  // Prefer killing the entire process group. This requires the target process to be a group leader.
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Fall back to just the individual process.
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
  }
}

/**
 * Disposable wrapper for child processes that ensures immediate cleanup.
 * Implements TypeScript's explicit resource management (using) for process lifecycle.
 *
 * All registered cleanup callbacks execute immediately when disposed, either:
 * - Explicitly via Symbol.dispose
 * - Automatically when exiting a `using` block
 * - On process exit
 *
 * Usage:
 *   const process = spawn("command");
 *   const disposable = new DisposableProcess(process);
 *   disposable.addCleanup(() => stream.destroy());
 *   // Cleanup runs automatically on process exit
 */
export class DisposableProcess implements Disposable {
  private cleanupCallbacks: Array<() => void> = [];
  private disposed = false;

  constructor(private readonly process: ChildProcess) {
    // No auto-cleanup - callers explicitly dispose via timeout/abort handlers
    // Process streams close naturally when process exits
  }

  /**
   * Register cleanup callback to run when process is disposed.
   * If already disposed, runs immediately.
   */
  addCleanup(callback: () => void): void {
    if (this.disposed) {
      // Already disposed, run immediately
      try {
        callback();
      } catch {
        // Ignore errors during cleanup
      }
    } else {
      this.cleanupCallbacks.push(callback);
    }
  }

  /**
   * Get the underlying child process
   */
  get underlying(): ChildProcess {
    return this.process;
  }

  /**
   * Cleanup: kill process + run all cleanup callbacks immediately.
   * Safe to call multiple times (idempotent).
   */
  [Symbol.dispose](): void {
    if (this.disposed) return;
    this.disposed = true;

    // Kill process if still running
    // Check both exitCode and signalCode to avoid calling kill() on already-dead processes
    // When a process exits via signal (e.g., segfault, kill $$), exitCode is null but signalCode is set
    if (
      !this.process.killed &&
      this.process.exitCode === null &&
      this.process.signalCode === null
    ) {
      // On Windows, childProcess.kill() does not terminate the full process tree.
      // Use taskkill /T to avoid leaking child processes (e.g., spawned by Git Bash).
      const pid = this.process.pid;
      if (pid !== undefined && pid > 0) {
        killProcessTree(pid);
      } else {
        try {
          this.process.kill("SIGKILL");
        } catch {
          // Ignore ESRCH errors - process may have exited between check and kill
        }
      }
    }

    // Run all cleanup callbacks
    for (const callback of this.cleanupCallbacks) {
      try {
        callback();
      } catch {
        // Ignore cleanup errors - we're tearing down anyway
      }
    }

    this.cleanupCallbacks = [];
  }
}

/**
 * Disposable wrapper for exec that ensures child process cleanup.
 * Prevents zombie processes by killing child when scope exits.
 *
 * Usage:
 *   using proc = execAsync("git status");
 *   const { stdout } = await proc.result;
 */
class DisposableExec implements Disposable {
  constructor(
    private readonly promise: Promise<{ stdout: string; stderr: string }>,
    private readonly child: ChildProcess
  ) {}

  [Symbol.dispose](): void {
    // Only kill if process hasn't exited naturally
    // Check the child's actual exit state, not promise state (avoids async timing issues)
    const hasExited = this.child.exitCode !== null || this.child.signalCode !== null;
    if (!hasExited && !this.child.killed) {
      this.child.kill();
    }
  }

  get result() {
    return this.promise;
  }
}

/**
 * Options for execAsync.
 */
export interface ExecAsyncOptions {
  /** Shell to use for command execution. If not specified, uses system default (cmd.exe on Windows). */
  shell?: string;
}

/**
 * Execute command with automatic cleanup via `using` declaration.
 * Prevents zombie processes by ensuring child is reaped even on error.
 *
 * @example
 * using proc = execAsync("git status");
 * const { stdout } = await proc.result;
 *
 * // With explicit shell (needed for POSIX commands on Windows)
 * using proc = execAsync("nohup bash -c ...", { shell: getBashPath() });
 */
export function execAsync(command: string, options?: ExecAsyncOptions): DisposableExec {
  // Child processes inherit process.env automatically, which includes
  // the enriched PATH set by initShellEnv() at startup
  const child = exec(command, { shell: options?.shell });
  const promise = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let exitSignal: string | null = null;

    child.stdout?.on("data", (data) => {
      stdout += data;
    });
    child.stderr?.on("data", (data) => {
      stderr += data;
    });

    // Use 'close' event instead of 'exit' - close fires after all stdio streams are closed
    // This ensures we've received all buffered output before resolving/rejecting
    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });

    child.on("close", () => {
      // Only resolve if process exited cleanly (code 0, no signal)
      if (exitCode === 0 && exitSignal === null) {
        resolve({ stdout, stderr });
      } else {
        // Include stderr in error message for better debugging
        const errorMsg =
          stderr.trim() ||
          (exitSignal
            ? `Command killed by signal ${exitSignal}`
            : `Command failed with exit code ${exitCode ?? "unknown"}`);
        const error = new Error(errorMsg) as Error & {
          code: number | null;
          signal: string | null;
          stdout: string;
          stderr: string;
        };
        error.code = exitCode;
        error.signal = exitSignal;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });

    child.on("error", reject);
  });

  return new DisposableExec(promise, child);
}

/**
 * Options for execFileAsync.
 */
export interface ExecFileAsyncOptions {
  /** Extra environment variables for the child process. */
  env?: Record<string, string | undefined>;
  /** Optional callback for each stderr data chunk from the process. */
  onStderrData?: (chunk: string) => void;
}

/**
 * Execute a file with arguments and automatic cleanup via `using` declaration.
 * Unlike execAsync, this does not use a shell—arguments are passed directly
 * to the executable, avoiding shell-quoting issues across platforms.
 * Uses `spawn` instead of `execFile` to avoid Node's default maxBuffer limit
 * which would kill long-running processes like `git clone` on verbose repos.
 *
 * @example
 * using proc = execFileAsync("git", ["clone", url, dest]);
 * const { stdout } = await proc.result;
 */
export function execFileAsync(
  file: string,
  args: string[],
  options?: ExecFileAsyncOptions
): DisposableExec {
  const child = spawn(file, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: options?.env ? { ...process.env, ...options.env } : undefined,
  });
  const promise = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let exitSignal: string | null = null;

    child.stdout?.on("data", (data) => {
      stdout += data;
    });
    child.stderr?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      options?.onStderrData?.(chunk);
    });

    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });

    child.on("close", () => {
      if (exitCode === 0 && exitSignal === null) {
        resolve({ stdout, stderr });
      } else {
        const errorMsg =
          stderr.trim() ||
          (exitSignal
            ? `Command killed by signal ${exitSignal}`
            : `Command failed with exit code ${exitCode ?? "unknown"}`);
        const error = new Error(errorMsg) as Error & {
          code: number | null;
          signal: string | null;
          stdout: string;
          stderr: string;
        };
        error.code = exitCode;
        error.signal = exitSignal;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });

    child.on("error", reject);
  });

  return new DisposableExec(promise, child);
}
