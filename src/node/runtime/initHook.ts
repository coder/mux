import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import type { ExecOptions, ExecStream, InitLogger } from "./Runtime";
import {
  isWorktreeRuntime,
  isSSHRuntime,
  isDockerRuntime,
  type RuntimeConfig,
  type RuntimeMode,
} from "@/common/types/runtime";
import type { ThinkingLevel } from "@/common/types/thinking";

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
 * Get MUX_ environment variables for bash execution.
 * Used by both init hook and regular bash tool calls.
 * @param projectPath - Path to project root (local path for LocalRuntime, remote path for SSHRuntime)
 * @param runtime - Runtime type: "local", "worktree", "ssh", or "docker"
 * @param workspaceName - Name of the workspace (branch name or custom name)
 */
export function getMuxEnv(
  projectPath: string,
  runtime: RuntimeMode,
  workspaceName: string,
  options?: {
    modelString?: string;
    thinkingLevel?: ThinkingLevel;
  }
): Record<string, string> {
  if (!projectPath) {
    throw new Error("getMuxEnv: projectPath is required");
  }
  if (!workspaceName) {
    throw new Error("getMuxEnv: workspaceName is required");
  }

  const env: Record<string, string> = {
    MUX_PROJECT_PATH: projectPath,
    MUX_RUNTIME: runtime,
    MUX_WORKSPACE_NAME: workspaceName,
  };

  if (options?.modelString) {
    env.MUX_MODEL_STRING = options.modelString;
  }

  if (options?.thinkingLevel !== undefined) {
    env.MUX_THINKING_LEVEL = options.thinkingLevel;
  }

  return env;
}

/**
 * Get the effective runtime type from a RuntimeConfig.
 * Handles legacy "local" with srcBaseDir → "worktree" mapping.
 */
export function getRuntimeType(config: RuntimeConfig | undefined): RuntimeMode {
  if (!config) return "worktree"; // Default to worktree for undefined config
  if (isSSHRuntime(config)) return "ssh";
  if (isDockerRuntime(config)) return "docker";
  if (isWorktreeRuntime(config)) return "worktree";
  return "local";
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

/**
 * Minimal runtime interface needed for running init hooks.
 * This allows the helper to work with any runtime implementation.
 */
export interface InitHookRuntime {
  exec(command: string, options: ExecOptions): Promise<ExecStream>;
}

/**
 * Run .mux/init hook on a runtime and stream output to logger.
 * Shared implementation used by SSH and Docker runtimes.
 *
 * @param runtime - Runtime instance with exec capability
 * @param hookPath - Full path to the init hook (e.g., "/src/.mux/init" or "~/mux/project/workspace/.mux/init")
 * @param workspacePath - Working directory for the hook
 * @param muxEnv - MUX_ environment variables from getMuxEnv()
 * @param initLogger - Logger for streaming output
 * @param abortSignal - Optional abort signal
 */
export async function runInitHookOnRuntime(
  runtime: InitHookRuntime,
  hookPath: string,
  workspacePath: string,
  muxEnv: Record<string, string>,
  initLogger: InitLogger,
  abortSignal?: AbortSignal
): Promise<void> {
  initLogger.logStep(`Running init hook: ${hookPath}`);

  const hookStream = await runtime.exec(hookPath, {
    cwd: workspacePath,
    timeout: 3600, // 1 hour - generous timeout for init hooks
    abortSignal,
    env: muxEnv,
  });

  // Create line-buffered loggers for proper output handling
  const loggers = createLineBufferedLoggers(initLogger);
  const stdoutReader = hookStream.stdout.getReader();
  const stderrReader = hookStream.stderr.getReader();
  const decoder = new TextDecoder();

  // Read stdout in parallel
  const readStdout = async () => {
    try {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        loggers.stdout.append(decoder.decode(value, { stream: true }));
      }
      loggers.stdout.flush();
    } finally {
      stdoutReader.releaseLock();
    }
  };

  // Read stderr in parallel
  const readStderr = async () => {
    try {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        loggers.stderr.append(decoder.decode(value, { stream: true }));
      }
      loggers.stderr.flush();
    } finally {
      stderrReader.releaseLock();
    }
  };

  // Wait for all streams and exit code
  const [exitCode] = await Promise.all([hookStream.exitCode, readStdout(), readStderr()]);

  initLogger.logComplete(exitCode);
}
