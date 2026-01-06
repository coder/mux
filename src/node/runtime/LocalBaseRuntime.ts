import { spawn } from "child_process";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import { Readable, Writable } from "stream";

import type {
  Runtime,
  ExecOptions,
  ExecStream,
  FileStat,
  WorkspaceCreationParams,
  WorkspaceCreationResult,
  WorkspaceInitParams,
  WorkspaceInitResult,
  WorkspaceForkParams,
  WorkspaceForkResult,
  InitLogger,
} from "./Runtime";
import { RuntimeError as RuntimeErrorClass } from "./Runtime";
import { NON_INTERACTIVE_ENV_VARS } from "@/common/constants/env";
import { getBashPath } from "@/node/utils/main/bashPath";
import { EXIT_CODE_ABORTED, EXIT_CODE_TIMEOUT } from "@/common/constants/exitCodes";
import { DisposableProcess } from "@/node/utils/disposableExec";
import { expandTilde } from "./tildeExpansion";
import { getInitHookPath, createLineBufferedLoggers } from "./initHook";

/**
 * Abstract base class for local runtimes (both WorktreeRuntime and LocalRuntime).
 *
 * Provides shared implementation for:
 * - exec() - Command execution with streaming I/O
 * - readFile() - File reading with streaming
 * - writeFile() - Atomic file writes with streaming
 * - stat() - File statistics
 * - resolvePath() - Path resolution with tilde expansion
 * - normalizePath() - Path normalization
 *
 * Subclasses must implement workspace-specific methods:
 * - getWorkspacePath()
 * - createWorkspace()
 * - initWorkspace()
 * - deleteWorkspace()
 * - renameWorkspace()
 * - forkWorkspace()
 */
export abstract class LocalBaseRuntime implements Runtime {
  async exec(command: string, options: ExecOptions): Promise<ExecStream> {
    const startTime = performance.now();

    // Use the specified working directory (must be a specific workspace path)
    const cwd = options.cwd;

    // Check if working directory exists before spawning
    // This prevents confusing ENOENT errors from spawn()
    try {
      await fsPromises.access(cwd);
    } catch (err) {
      throw new RuntimeErrorClass(
        `Working directory does not exist: ${cwd}`,
        "exec",
        err instanceof Error ? err : undefined
      );
    }

    const bashPath = getBashPath();
    const spawnCommand = bashPath;
    const spawnArgs = ["-c", command];

    const defaultPath = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    const effectivePath =
      (options.env?.PATH && options.env.PATH.length > 0 ? options.env.PATH : process.env.PATH) ??
      defaultPath;

    const childProcess = spawn(spawnCommand, spawnArgs, {
      cwd,
      env: {
        ...process.env,
        ...(options.env ?? {}),
        ...NON_INTERACTIVE_ENV_VARS,
        PATH: effectivePath,
      },
      stdio: ["pipe", "pipe", "pipe"],
      // CRITICAL: Spawn as detached process group leader to enable cleanup of background processes.
      // When a bash script spawns background processes (e.g., `sleep 100 &`), we need to kill
      // the entire process group (including all backgrounded children) via process.kill(-pid).
      // NOTE: detached:true does NOT cause bash to wait for background jobs when using 'exit' event
      // instead of 'close' event. The 'exit' event fires when bash exits, ignoring background children.
      detached: true,
      // Prevent console window from appearing on Windows (WSL bash spawns steal focus otherwise)
      windowsHide: true,
    });

    // Wrap in DisposableProcess for automatic cleanup
    const disposable = new DisposableProcess(childProcess);

    // Convert Node.js streams to Web Streams
    const stdout = Readable.toWeb(childProcess.stdout) as unknown as ReadableStream<Uint8Array>;
    const stderr = Readable.toWeb(childProcess.stderr) as unknown as ReadableStream<Uint8Array>;
    const stdin = Writable.toWeb(childProcess.stdin) as unknown as WritableStream<Uint8Array>;

    // No stream cleanup in DisposableProcess - streams close naturally when process exits
    // bash.ts handles cleanup after waiting for exitCode

    // Track if we killed the process due to timeout or abort
    let timedOut = false;
    let aborted = false;

    // Create promises for exit code and duration
    // Uses special exit codes (EXIT_CODE_ABORTED, EXIT_CODE_TIMEOUT) for expected error conditions
    const exitCode = new Promise<number>((resolve, reject) => {
      // Use 'exit' event instead of 'close' to handle background processes correctly.
      // The 'close' event waits for ALL child processes (including background ones) to exit,
      // which causes hangs when users spawn background processes like servers.
      // The 'exit' event fires when the main bash process exits, which is what we want.
      childProcess.on("exit", (code) => {
        // Clean up any background processes (process group cleanup)
        // This prevents zombie processes when scripts spawn background tasks
        if (childProcess.pid !== undefined) {
          try {
            // Kill entire process group with SIGKILL - cannot be caught/ignored
            // Use negative PID to signal the entire process group
            process.kill(-childProcess.pid, "SIGKILL");
          } catch {
            // Process group already dead or doesn't exist - ignore
          }
        }

        // Check abort first (highest priority)
        if (aborted || options.abortSignal?.aborted) {
          resolve(EXIT_CODE_ABORTED);
          return;
        }
        // Check if we killed the process due to timeout
        if (timedOut) {
          resolve(EXIT_CODE_TIMEOUT);
          return;
        }
        resolve(code ?? 0);
        // Cleanup runs automatically via DisposableProcess
      });

      childProcess.on("error", (err) => {
        reject(new RuntimeErrorClass(`Failed to execute command: ${err.message}`, "exec", err));
      });
    });

    const duration = exitCode.then(() => performance.now() - startTime);

    // Avoid unhandled promise rejections in fire-and-forget exec() callsites.
    // Callers that await these promises will still observe the rejection.
    void exitCode.catch(() => undefined);
    void duration.catch(() => undefined);

    // Register process group cleanup with DisposableProcess
    // This ensures ALL background children are killed when process exits
    disposable.addCleanup(() => {
      if (childProcess.pid === undefined) return;

      try {
        // Kill entire process group with SIGKILL - cannot be caught/ignored
        process.kill(-childProcess.pid, "SIGKILL");
      } catch {
        // Process group already dead or doesn't exist - ignore
      }
    });

    // Handle abort signal
    if (options.abortSignal) {
      options.abortSignal.addEventListener("abort", () => {
        aborted = true;
        disposable[Symbol.dispose](); // Kill process and run cleanup
      });
    }

    // Handle timeout
    if (options.timeout !== undefined) {
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        disposable[Symbol.dispose](); // Kill process and run cleanup
      }, options.timeout * 1000);

      // Clear timeout if process exits naturally
      void exitCode.catch(() => undefined).finally(() => clearTimeout(timeoutHandle));
    }

    return { stdout, stderr, stdin, exitCode, duration };
  }

  readFile(filePath: string, _abortSignal?: AbortSignal): ReadableStream<Uint8Array> {
    // Note: _abortSignal ignored for local operations (fast, no need for cancellation)
    // Expand tildes before reading (Node.js fs doesn't expand ~)
    const expandedPath = expandTilde(filePath);
    const nodeStream = fs.createReadStream(expandedPath);

    // Handle errors by wrapping in a transform
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;

    return new ReadableStream<Uint8Array>({
      async start(controller: ReadableStreamDefaultController<Uint8Array>) {
        try {
          const reader = webStream.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch (err) {
          controller.error(
            new RuntimeErrorClass(
              `Failed to read file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
              "file_io",
              err instanceof Error ? err : undefined
            )
          );
        }
      },
    });
  }

  writeFile(filePath: string, _abortSignal?: AbortSignal): WritableStream<Uint8Array> {
    // Note: _abortSignal ignored for local operations (fast, no need for cancellation)
    // Expand tildes before writing (Node.js fs doesn't expand ~)
    const expandedPath = expandTilde(filePath);
    let tempPath: string;
    let writer: WritableStreamDefaultWriter<Uint8Array>;
    let resolvedPath: string;
    let originalMode: number | undefined;

    return new WritableStream<Uint8Array>({
      async start() {
        // Resolve symlinks to write through them (preserves the symlink)
        try {
          resolvedPath = await fsPromises.realpath(expandedPath);
          // Save original permissions to restore after write
          const stat = await fsPromises.stat(resolvedPath);
          originalMode = stat.mode;
        } catch {
          // If file doesn't exist, use the expanded path and default permissions
          resolvedPath = expandedPath;
          originalMode = undefined;
        }

        // Create parent directories if they don't exist
        const parentDir = path.dirname(resolvedPath);
        await fsPromises.mkdir(parentDir, { recursive: true });

        // Create temp file for atomic write
        tempPath = `${resolvedPath}.tmp.${Date.now()}`;
        const nodeStream = fs.createWriteStream(tempPath);
        const webStream = Writable.toWeb(nodeStream) as WritableStream<Uint8Array>;
        writer = webStream.getWriter();
      },
      async write(chunk: Uint8Array) {
        await writer.write(chunk);
      },
      async close() {
        // Close the writer and rename to final location
        await writer.close();
        try {
          // If we have original permissions, apply them to temp file before rename
          if (originalMode !== undefined) {
            await fsPromises.chmod(tempPath, originalMode);
          }
          await fsPromises.rename(tempPath, resolvedPath);
        } catch (err) {
          throw new RuntimeErrorClass(
            `Failed to write file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
            "file_io",
            err instanceof Error ? err : undefined
          );
        }
      },
      async abort(reason?: unknown) {
        // Clean up temp file on abort
        await writer.abort();
        try {
          await fsPromises.unlink(tempPath);
        } catch {
          // Ignore errors cleaning up temp file
        }
        throw new RuntimeErrorClass(
          `Failed to write file ${filePath}: ${String(reason)}`,
          "file_io"
        );
      },
    });
  }

  async stat(filePath: string, _abortSignal?: AbortSignal): Promise<FileStat> {
    // Note: _abortSignal ignored for local operations (fast, no need for cancellation)
    // Expand tildes before stat (Node.js fs doesn't expand ~)
    const expandedPath = expandTilde(filePath);
    try {
      const stats = await fsPromises.stat(expandedPath);
      return {
        size: stats.size,
        modifiedTime: stats.mtime,
        isDirectory: stats.isDirectory(),
      };
    } catch (err) {
      throw new RuntimeErrorClass(
        `Failed to stat ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        "file_io",
        err instanceof Error ? err : undefined
      );
    }
  }

  resolvePath(filePath: string): Promise<string> {
    // Expand tilde to actual home directory path
    const expanded = expandTilde(filePath);

    // Resolve to absolute path (handles relative paths like "./foo")
    return Promise.resolve(path.resolve(expanded));
  }

  normalizePath(targetPath: string, basePath: string): string {
    // For local runtime, use Node.js path resolution
    // Handle special case: current directory
    const target = targetPath.trim();
    if (target === ".") {
      return path.resolve(basePath);
    }
    // Expand tildes before resolving (~ is not expanded by path.resolve)
    const expanded = expandTilde(target);
    return path.resolve(basePath, expanded);
  }

  // Abstract methods that subclasses must implement
  abstract getWorkspacePath(projectPath: string, workspaceName: string): string;

  abstract createWorkspace(params: WorkspaceCreationParams): Promise<WorkspaceCreationResult>;

  abstract initWorkspace(params: WorkspaceInitParams): Promise<WorkspaceInitResult>;

  abstract renameWorkspace(
    projectPath: string,
    oldName: string,
    newName: string,
    abortSignal?: AbortSignal
  ): Promise<
    { success: true; oldPath: string; newPath: string } | { success: false; error: string }
  >;

  abstract deleteWorkspace(
    projectPath: string,
    workspaceName: string,
    force: boolean,
    abortSignal?: AbortSignal
  ): Promise<{ success: true; deletedPath: string } | { success: false; error: string }>;

  abstract forkWorkspace(params: WorkspaceForkParams): Promise<WorkspaceForkResult>;

  /**
   * Get the runtime's temp directory.
   * Uses OS temp dir on local systems.
   */
  tempDir(): Promise<string> {
    // Use /tmp on Unix, or OS temp dir on Windows
    const isWindows = process.platform === "win32";
    return Promise.resolve(isWindows ? (process.env.TEMP ?? "C:\\Temp") : "/tmp");
  }

  /**
   * Helper to run .mux/init hook if it exists and is executable.
   * Shared between WorktreeRuntime and LocalRuntime.
   * @param workspacePath - Path to the workspace directory
   * @param muxEnv - MUX_ environment variables (from getMuxEnv)
   * @param initLogger - Logger for streaming output
   */
  protected async runInitHook(
    workspacePath: string,
    muxEnv: Record<string, string>,
    initLogger: InitLogger
  ): Promise<void> {
    // Hook path is derived from MUX_PROJECT_PATH in muxEnv
    const projectPath = muxEnv.MUX_PROJECT_PATH;
    const hookPath = getInitHookPath(projectPath);
    initLogger.logStep(`Running init hook: ${hookPath}`);

    // Create line-buffered loggers
    const loggers = createLineBufferedLoggers(initLogger);

    return new Promise<void>((resolve) => {
      const bashPath = getBashPath();
      const proc = spawn(bashPath, ["-c", `"${hookPath}"`], {
        cwd: workspacePath,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ...muxEnv,
        },
        // Prevent console window from appearing on Windows
        windowsHide: true,
      });

      proc.stdout.on("data", (data: Buffer) => {
        loggers.stdout.append(data.toString());
      });

      proc.stderr.on("data", (data: Buffer) => {
        loggers.stderr.append(data.toString());
      });

      proc.on("close", (code) => {
        // Flush any remaining buffered output
        loggers.stdout.flush();
        loggers.stderr.flush();

        initLogger.logComplete(code ?? 0);
        resolve();
      });

      proc.on("error", (err) => {
        initLogger.logStderr(`Error running init hook: ${err.message}`);
        initLogger.logComplete(-1);
        resolve();
      });
    });
  }
}
