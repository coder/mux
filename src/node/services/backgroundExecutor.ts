/**
 * Background process execution abstraction.
 *
 * This interface allows BackgroundProcessManager to work with different
 * execution backends (local processes, SSH remote processes, etc.)
 */

/**
 * Configuration for background execution
 */
export interface BackgroundExecConfig {
  /** Working directory for command execution */
  cwd: string;
  /** Environment variables to inject */
  env?: Record<string, string>;
  /** Process niceness level (-20 to 19) */
  niceness?: number;
}

/**
 * Handle to a background process.
 * Abstracts away whether process is local or remote.
 */
export interface BackgroundHandle {
  /**
   * Register callback for stdout lines.
   * For local: called in real-time as output arrives.
   * For SSH: called when output is polled/read.
   */
  onStdout(callback: (line: string) => void): void;

  /**
   * Register callback for stderr lines.
   */
  onStderr(callback: (line: string) => void): void;

  /**
   * Register callback for process exit.
   * @param callback Receives exit code (128+signal for signal termination)
   */
  onExit(callback: (exitCode: number) => void): void;

  /**
   * Check if process is still running.
   * For local: checks ChildProcess.exitCode
   * For SSH: runs `kill -0 $PID` on remote
   */
  isRunning(): Promise<boolean>;

  /**
   * Terminate the process (SIGTERM → wait → SIGKILL).
   * For local: process.kill(-pid, signal)
   * For SSH: ssh "kill -TERM -$PID"
   */
  terminate(): Promise<void>;

  /**
   * Clean up resources (called after process exits or on error).
   * For local: disposes ChildProcess
   * For SSH: removes remote temp files
   */
  dispose(): Promise<void>;
}

/**
 * Result of spawning a background process
 */
export type BackgroundSpawnResult =
  | { success: true; handle: BackgroundHandle }
  | { success: false; error: string };

/**
 * Executor interface for spawning background processes.
 *
 * Implementations:
 * - LocalBackgroundExecutor: Uses BashExecutionService for local processes
 * - SSHBackgroundExecutor: Uses nohup/setsid + file-based output (TODO)
 */
export interface BackgroundExecutor {
  /**
   * Spawn a background process.
   * @param script Bash script to execute
   * @param config Execution configuration
   * @returns BackgroundHandle on success, or error
   */
  spawn(script: string, config: BackgroundExecConfig): Promise<BackgroundSpawnResult>;
}
