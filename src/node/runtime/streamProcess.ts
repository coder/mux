/**
 * Helper utilities for streaming child process output to InitLogger
 */

import type { ChildProcess } from "child_process";
import type { InitLogger } from "./Runtime";

/**
 * Stream child process stdout/stderr to initLogger
 * Prevents pipe buffer overflow by draining both streams.
 *
 * This is essential to prevent child processes from hanging when their
 * output buffers fill up (typically 64KB). Always call this when spawning
 * processes that may produce output.
 *
 * @param process Child process to stream from
 * @param initLogger Logger to stream output to
 * @param options Configuration for which streams to log
 * @returns Cleanup function to remove abort signal listener (call this in process close/error handlers)
 */
export function streamProcessToLogger(
  process: ChildProcess,
  initLogger: InitLogger,
  options?: {
    /** If true, log stdout via logStdout. If false, drain silently. Default: false */
    logStdout?: boolean;
    /** If true, log stderr via logStderr. If false, drain silently. Default: true */
    logStderr?: boolean;
    /** Optional: Command string to log before streaming starts */
    command?: string;
    /** Optional: Abort signal to kill process on cancellation */
    abortSignal?: AbortSignal;
  }
): () => void {
  const { logStdout = false, logStderr = true, command, abortSignal } = options ?? {};

  // Log the command being executed (if provided)
  if (command) {
    initLogger.logStep(`Executing: ${command}`);
  }

  // Set up abort signal handler
  const abortHandler = abortSignal
    ? () => {
        process.kill();
      }
    : null;
  if (abortHandler && abortSignal) {
    abortSignal.addEventListener("abort", abortHandler);
  }

  // Drain stdout (prevent pipe overflow)
  if (process.stdout) {
    process.stdout.on("data", (data: Buffer) => {
      if (logStdout) {
        const output = data.toString();
        // Split by lines and log each non-empty line
        const lines = output.split("\n").filter((line) => line.trim().length > 0);
        for (const line of lines) {
          initLogger.logStdout(line);
        }
      }
      // Otherwise drain silently to prevent buffer overflow
    });
  }

  // Stream stderr to logger
  if (process.stderr) {
    process.stderr.on("data", (data: Buffer) => {
      if (logStderr) {
        const output = data.toString();
        // Split by lines and log each non-empty line
        const lines = output.split("\n").filter((line) => line.trim().length > 0);
        for (const line of lines) {
          initLogger.logStderr(line);
        }
      }
      // Otherwise drain silently to prevent buffer overflow
    });
  }

  // Return cleanup function to remove abort listener
  return () => {
    if (abortHandler && abortSignal) {
      abortSignal.removeEventListener("abort", abortHandler);
    }
  };
}
