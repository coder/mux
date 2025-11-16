import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import type { InitLogger } from "./Runtime";

/**
 * Check if .mux/init hook exists and is executable
 * @param projectPath - Path to the project root
 * @returns true if hook exists and is executable, false otherwise
 */
export async function checkInitHookExists(projectPath: string): Promise<boolean> {
  const hookPath = path.join(projectPath, ".mux", "init");

  try {
    await fsPromises.access(hookPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the init hook path for a project
 */
export function getInitHookPath(projectPath: string): string {
  return path.join(projectPath, ".mux", "init");
}

/**
 * Get environment variables for init hook execution
 * Centralizes env var injection to avoid duplication across runtimes
 * @param projectPath - Path to project root (local path for LocalRuntime, remote path for SSHRuntime)
 * @param runtime - Runtime type: "local" or "ssh"
 */
export function getInitHookEnv(
  projectPath: string,
  runtime: "local" | "ssh"
): Record<string, string> {
  return {
    MUX_PROJECT_PATH: projectPath,
    MUX_RUNTIME: runtime,
  };
}

/**
 * Line-buffered logger that splits stream output into lines and logs them
 * Handles incomplete lines by buffering until a newline is received
 */
export class LineBuffer {
  private buffer = "";
  private readonly logLine: (line: string) => void;

  constructor(logLine: (line: string) => void) {
    this.logLine = logLine;
  }

  /**
   * Process a chunk of data, splitting on newlines and logging complete lines
   */
  append(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? ""; // Keep last incomplete line
    for (const line of lines) {
      if (line) this.logLine(line);
    }
  }

  /**
   * Flush any remaining buffered data (called when stream closes)
   */
  flush(): void {
    if (this.buffer) {
      this.logLine(this.buffer);
      this.buffer = "";
    }
  }
}

/**
 * Create line-buffered loggers for stdout and stderr
 * Returns an object with append and flush methods for each stream
 */
export function createLineBufferedLoggers(initLogger: InitLogger) {
  const stdoutBuffer = new LineBuffer((line) => initLogger.logStdout(line));
  const stderrBuffer = new LineBuffer((line) => initLogger.logStderr(line));

  return {
    stdout: {
      append: (data: string) => stdoutBuffer.append(data),
      flush: () => stdoutBuffer.flush(),
    },
    stderr: {
      append: (data: string) => stderrBuffer.append(data),
      flush: () => stderrBuffer.flush(),
    },
  };
}
