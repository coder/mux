import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import { log } from "./log";
import { getBashPath } from "@/node/utils/main/bashPath";

/**
 * Configuration for bash execution
 */
export interface BashExecutionConfig {
  /** Working directory for command execution */
  cwd: string;
  /** Environment secrets to inject (e.g., API keys) */
  secrets?: Record<string, string>;
  /** Whether to spawn as detached process group (default: true) */
  detached?: boolean;
  /** Nice level for process priority (-20 to 19) */
  niceness?: number;
}

/**
 * Callbacks for streaming execution mode
 */
export interface StreamingCallbacks {
  /** Called for each complete line from stdout */
  onStdout: (line: string) => void;
  /** Called for each complete line from stderr */
  onStderr: (line: string) => void;
  /** Called when process exits */
  onExit: (exitCode: number) => void;
}

/**
 * Wraps a ChildProcess to make it disposable for use with `using` statements.
 * Always kills the entire process group with SIGKILL to prevent zombie processes.
 * SIGKILL cannot be caught or ignored, guaranteeing immediate cleanup.
 */
export class DisposableProcess implements Disposable {
  private disposed = false;

  constructor(private readonly process: ChildProcess) {}

  [Symbol.dispose](): void {
    // Prevent double-signalling if dispose is called multiple times
    if (this.disposed || this.process.pid === undefined) {
      return;
    }

    this.disposed = true;

    try {
      // Kill entire process group with SIGKILL - cannot be caught/ignored
      process.kill(-this.process.pid, "SIGKILL");
    } catch {
      // Fallback: try killing just the main process
      try {
        this.process.kill("SIGKILL");
      } catch {
        // Process already dead - ignore
      }
    }
  }

  get child(): ChildProcess {
    return this.process;
  }
}

/**
 * Centralized bash execution service.
 *
 * All workspace command execution goes through this service to:
 * - Maintain consistent environment setup across all bash execution
 * - Provide single abstraction point for future host migration (containers, remote, etc.)
 * - Eliminate duplication between init hooks and bash tool
 *
 * Provides two execution modes:
 * - Streaming: Line-by-line output callbacks (for init hooks, real-time feedback)
 * - Buffered: Collect all output, return at end (for bash tool, LLM consumption)
 */
export class BashExecutionService {
  /**
   * Create standardized bash environment.
   * Prevents interactive prompts that would block execution.
   */
  private createBashEnvironment(secrets?: Record<string, string>): NodeJS.ProcessEnv {
    return {
      ...process.env,
      // Inject secrets as environment variables
      ...(secrets ?? {}),
      // Prevent interactive editors from blocking bash execution
      // Critical for git operations like rebase/commit that try to open editors
      GIT_EDITOR: "true", // Git-specific editor (highest priority)
      GIT_SEQUENCE_EDITOR: "true", // For interactive rebase sequences
      EDITOR: "true", // General fallback for non-git commands
      VISUAL: "true", // Another common editor environment variable
      // Prevent git from prompting for credentials
      // Critical for operations like fetch/pull that might try to authenticate
      // Without this, git can hang waiting for user input if credentials aren't configured
      GIT_TERMINAL_PROMPT: "0", // Disables git credential prompts
    };
  }

  /**
   * Execute bash command with streaming output.
   *
   * Output is emitted line-by-line through callbacks as it arrives.
   * Used by init hooks for real-time progress feedback.
   *
   * @param script Bash script to execute
   * @param config Execution configuration
   * @param callbacks Output and exit callbacks
   * @returns DisposableProcess that can be killed with `using` statement
   */
  executeStreaming(
    script: string,
    config: BashExecutionConfig,
    callbacks: StreamingCallbacks
  ): DisposableProcess {
    log.debug(`BashExecutionService: Executing streaming command in ${config.cwd}`);
    log.debug(
      `BashExecutionService: Script: ${script.substring(0, 100)}${script.length > 100 ? "..." : ""}`
    );

    // Windows doesn't have nice command, so just spawn bash directly
    const isWindows = process.platform === "win32";
    const bashPath = getBashPath();
    const spawnCommand = config.niceness !== undefined && !isWindows ? "nice" : bashPath;
    const spawnArgs =
      config.niceness !== undefined && !isWindows
        ? ["-n", config.niceness.toString(), bashPath, "-c", script]
        : ["-c", script];

    const child = spawn(spawnCommand, spawnArgs, {
      cwd: config.cwd,
      env: this.createBashEnvironment(config.secrets),
      stdio: ["ignore", "pipe", "pipe"],
      // Spawn as detached process group leader to prevent zombie processes
      // When bash spawns background processes, detached:true allows killing
      // the entire group via process.kill(-pid)
      detached: config.detached ?? true,
      // Prevent console window from appearing on Windows (WSL bash spawns steal focus otherwise)
      windowsHide: true,
    });

    log.debug(`BashExecutionService: Spawned process with PID ${child.pid ?? "unknown"}`);

    // Line-by-line streaming with incremental buffers
    let outBuf = "";
    let errBuf = "";

    const flushLines = (buf: string, isStderr: boolean): string => {
      const lines = buf.split(/\r?\n/);
      // Keep the last partial line in buffer; emit full lines
      const partial = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length === 0) continue;
        if (isStderr) {
          callbacks.onStderr(line);
        } else {
          callbacks.onStdout(line);
        }
      }
      return partial;
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      outBuf += chunk.toString("utf8");
      outBuf = flushLines(outBuf, false);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      errBuf += chunk.toString("utf8");
      errBuf = flushLines(errBuf, true);
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      log.debug(
        `BashExecutionService: Process exited with code ${code ?? "null"}, signal ${signal ?? "none"}`
      );
      // Flush any remaining partial lines
      if (outBuf.trim().length > 0) {
        callbacks.onStdout(outBuf);
      }
      if (errBuf.trim().length > 0) {
        callbacks.onStderr(errBuf);
      }

      // Convert signal to exit code using Unix convention (128 + signal number)
      // Common signals: SIGTERM=15 → 143, SIGKILL=9 → 137
      let exitCode = code ?? 0;
      if (code === null && signal) {
        const signalNumbers: Record<string, number> = {
          SIGHUP: 1,
          SIGINT: 2,
          SIGQUIT: 3,
          SIGABRT: 6,
          SIGKILL: 9,
          SIGTERM: 15,
        };
        exitCode = 128 + (signalNumbers[signal] ?? 1);
      }
      callbacks.onExit(exitCode);
    });

    child.on("error", (error: Error) => {
      log.error(`BashExecutionService: Process error:`, error);
    });

    return new DisposableProcess(child);
  }
}
