/**
 * Abstract base class for remote execution runtimes (SSH, Docker).
 *
 * Provides shared implementation for:
 * - exec() with streaming I/O, timeout/abort handling
 * - readFile(), writeFile(), stat() via exec
 * - normalizePath() for POSIX paths
 * - tempDir() returning /tmp
 *
 * Subclasses implement:
 * - spawnRemoteProcess() - how to spawn the external process (ssh/docker)
 * - getBasePath() - base directory for workspace operations
 * - quoteForRemote() - path quoting strategy
 * - onExitCode() - optional exit code handling (SSH connection pool)
 */

import type { ChildProcess } from "child_process";
import { Readable } from "stream";
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
} from "./Runtime";
import { RuntimeError } from "./Runtime";
import { EXIT_CODE_ABORTED, EXIT_CODE_TIMEOUT } from "@/common/constants/exitCodes";
import { log } from "@/node/services/log";
import { NON_INTERACTIVE_ENV_VARS } from "@/common/constants/env";
import { DisposableProcess } from "@/node/utils/disposableExec";
import { streamToString, shescape } from "./streamUtils";

/**
 * Result from spawning a remote process.
 */
export interface SpawnResult {
  /** The spawned child process */
  process: ChildProcess;
  /** Optional async work to do before exec (e.g., acquire connection) */
  preExec?: Promise<void>;
}

/**
 * Abstract base class for remote execution runtimes.
 */
export abstract class RemoteRuntime implements Runtime {
  /**
   * Spawn the external process for command execution.
   * SSH spawns `ssh`, Docker spawns `docker exec`.
   *
   * @param fullCommand The full shell command to execute (already wrapped in bash -c)
   * @param options Original exec options
   * @returns The spawned process and optional pre-exec work
   */
  protected abstract spawnRemoteProcess(
    fullCommand: string,
    options: ExecOptions
  ): Promise<SpawnResult>;

  /**
   * Get the base path for file operations (used as cwd for file commands).
   * SSH returns srcBaseDir, Docker returns /src.
   */
  protected abstract getBasePath(): string;

  /**
   * Quote a path for use in remote shell commands.
   * SSH uses expandTildeForSSH (handles ~ expansion), Docker uses shescape.quote.
   */
  protected abstract quoteForRemote(path: string): string;

  /**
   * Build the cd command for the given cwd.
   * SSH needs special handling for ~, Docker uses simple quoting.
   */
  protected abstract cdCommand(cwd: string): string;

  /**
   * Called when exec completes with an exit code.
   * Subclasses can use this for connection pool health tracking.
   * @param stderr - Captured stderr for error reporting (e.g., SSH connection failures)
   */
  protected onExitCode(_exitCode: number, _options: ExecOptions, _stderr: string): void {
    // Default: no-op. SSH overrides to report to connection pool.
  }

  /**
   * Command prefix (e.g., "SSH" or "Docker") for logging.
   */
  protected abstract readonly commandPrefix: string;

  /**
   * Execute command with streaming I/O.
   * Shared implementation that delegates process spawning to subclass.
   */
  async exec(command: string, options: ExecOptions): Promise<ExecStream> {
    const startTime = performance.now();

    // Short-circuit if already aborted
    if (options.abortSignal?.aborted) {
      throw new RuntimeError("Operation aborted before execution", "exec");
    }

    // Build command parts
    const parts: string[] = [];

    // Add cd command
    parts.push(this.cdCommand(options.cwd));

    // Add environment variable exports (user env first, then non-interactive overrides)
    const envVars = { ...options.env, ...NON_INTERACTIVE_ENV_VARS };
    for (const [key, value] of Object.entries(envVars)) {
      parts.push(`export ${key}=${shescape.quote(value)}`);
    }

    // Add the actual command
    parts.push(command);

    // Join all parts with && to ensure each step succeeds before continuing
    let fullCommand = parts.join(" && ");

    // Wrap in bash for consistent shell behavior
    fullCommand = `bash -c ${shescape.quote(fullCommand)}`;

    // Optionally wrap with timeout
    if (options.timeout !== undefined) {
      const remoteTimeout = Math.ceil(options.timeout) + 1;
      fullCommand = `timeout -s KILL ${remoteTimeout} ${fullCommand}`;
    }

    // Spawn the remote process (SSH or Docker)
    // For SSH, this awaits connection pool backoff before spawning
    const { process: childProcess } = await this.spawnRemoteProcess(fullCommand, options);

    // Wrap in DisposableProcess for cleanup
    const disposable = new DisposableProcess(childProcess);

    // Track if we killed the process due to timeout or abort
    let timedOut = false;
    let aborted = false;

    // Declared here so it's captured by the exitCode promise closure,
    // but the data listener is added AFTER Readable.toWeb() to avoid
    // putting the stream in flowing mode prematurely.
    let stderrForErrorReporting = "";

    // Create promises for exit code and duration immediately.
    const exitCode = new Promise<number>((resolve, reject) => {
      childProcess.on("close", (code, signal) => {
        if (aborted || options.abortSignal?.aborted) {
          resolve(EXIT_CODE_ABORTED);
          return;
        }
        if (timedOut) {
          resolve(EXIT_CODE_TIMEOUT);
          return;
        }
        const finalExitCode = code ?? (signal ? -1 : 0);

        // Let subclass handle exit code (e.g., SSH connection pool)
        this.onExitCode(finalExitCode, options, stderrForErrorReporting);

        resolve(finalExitCode);
      });

      childProcess.on("error", (err) => {
        reject(
          new RuntimeError(
            `Failed to execute ${this.commandPrefix} command: ${err.message}`,
            "exec",
            err
          )
        );
      });
    });

    const duration = exitCode.then(() => performance.now() - startTime);

    // Handle abort signal
    if (options.abortSignal) {
      options.abortSignal.addEventListener("abort", () => {
        aborted = true;
        disposable[Symbol.dispose]();
      });
    }

    // Handle timeout
    if (options.timeout !== undefined) {
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        disposable[Symbol.dispose]();
      }, options.timeout * 1000);

      void exitCode.finally(() => clearTimeout(timeoutHandle));
    }

    // Convert Node.js streams to Web Streams
    const stdout = Readable.toWeb(childProcess.stdout!) as unknown as ReadableStream<Uint8Array>;
    const stderr = Readable.toWeb(childProcess.stderr!) as unknown as ReadableStream<Uint8Array>;

    // Capture stderr for error reporting (e.g., SSH exit code 255 failures).
    // Must be AFTER Readable.toWeb() to avoid putting the stream in flowing mode prematurely.
    childProcess.stderr?.on("data", (data: Buffer) => {
      stderrForErrorReporting += data.toString();
    });

    // Writable.toWeb(childProcess.stdin) is surprisingly easy to get into an invalid state
    // for short-lived remote commands (notably via SSH) where stdin may already be closed
    // by the time callers attempt `await stream.stdin.close()`.
    //
    // Wrap stdin ourselves so close() is idempotent.
    const stdin = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        const nodeStdin = childProcess.stdin;
        if (!nodeStdin || nodeStdin.destroyed) {
          return;
        }

        await new Promise<void>((resolve, reject) => {
          const onError = (err: Error) => {
            nodeStdin.off("error", onError);
            reject(err);
          };
          nodeStdin.on("error", onError);

          nodeStdin.write(Buffer.from(chunk), (err) => {
            nodeStdin.off("error", onError);
            if (err) {
              reject(err);
              return;
            }
            resolve();
          });
        });
      },
      close: async () => {
        const nodeStdin = childProcess.stdin;
        if (!nodeStdin || nodeStdin.destroyed || nodeStdin.writableEnded) {
          return;
        }

        await new Promise<void>((resolve) => {
          nodeStdin.end(() => resolve());
        });
      },
      abort: () => {
        childProcess.stdin?.destroy();
      },
    });

    log.debug(`${this.commandPrefix} command: ${fullCommand}`);

    return { stdout, stderr, stdin, exitCode, duration };
  }

  /**
   * Read file contents as a stream via exec.
   */
  readFile(filePath: string, abortSignal?: AbortSignal): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start: async (controller: ReadableStreamDefaultController<Uint8Array>) => {
        try {
          const stream = await this.exec(`cat ${this.quoteForRemote(filePath)}`, {
            cwd: this.getBasePath(),
            timeout: 300,
            abortSignal,
          });

          const reader = stream.stdout.getReader();
          const exitCodePromise = stream.exitCode;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }

          const code = await exitCodePromise;
          if (code !== 0) {
            const stderr = await streamToString(stream.stderr);
            throw new RuntimeError(`Failed to read file ${filePath}: ${stderr}`, "file_io");
          }

          controller.close();
        } catch (err) {
          if (err instanceof RuntimeError) {
            controller.error(err);
          } else {
            controller.error(
              new RuntimeError(
                `Failed to read file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
                "file_io",
                err instanceof Error ? err : undefined
              )
            );
          }
        }
      },
    });
  }

  /**
   * Write file contents atomically via exec.
   * Uses temp file + mv for atomic write.
   */
  writeFile(filePath: string, abortSignal?: AbortSignal): WritableStream<Uint8Array> {
    const quotedPath = this.quoteForRemote(filePath);
    const tempPath = `${filePath}.tmp.${Date.now()}`;
    const quotedTempPath = this.quoteForRemote(tempPath);

    // Build write command - subclasses can override buildWriteCommand for special handling
    const writeCommand = this.buildWriteCommand(quotedPath, quotedTempPath);

    let execPromise: Promise<ExecStream> | null = null;

    const getExecStream = () => {
      execPromise ??= this.exec(writeCommand, {
        cwd: this.getBasePath(),
        timeout: 300,
        abortSignal,
      });
      return execPromise;
    };

    return new WritableStream<Uint8Array>({
      write: async (chunk: Uint8Array) => {
        const stream = await getExecStream();
        const writer = stream.stdin.getWriter();
        try {
          await writer.write(chunk);
        } finally {
          writer.releaseLock();
        }
      },
      close: async () => {
        const stream = await getExecStream();
        await stream.stdin.close();
        const exitCode = await stream.exitCode;

        if (exitCode !== 0) {
          const stderr = await streamToString(stream.stderr);
          throw new RuntimeError(`Failed to write file ${filePath}: ${stderr}`, "file_io");
        }
      },
      abort: async (reason?: unknown) => {
        const stream = await getExecStream();
        await stream.stdin.abort();
        throw new RuntimeError(`Failed to write file ${filePath}: ${String(reason)}`, "file_io");
      },
    });
  }

  /**
   * Build the write command for atomic file writes.
   * Can be overridden by subclasses for special handling (e.g., SSH symlink preservation).
   */
  protected buildWriteCommand(quotedPath: string, quotedTempPath: string): string {
    return `mkdir -p $(dirname ${quotedPath}) && cat > ${quotedTempPath} && mv ${quotedTempPath} ${quotedPath}`;
  }

  /**
   * Get file statistics via exec.
   */
  async stat(filePath: string, abortSignal?: AbortSignal): Promise<FileStat> {
    const stream = await this.exec(`stat -c '%s %Y %F' ${this.quoteForRemote(filePath)}`, {
      cwd: this.getBasePath(),
      timeout: 10,
      abortSignal,
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      streamToString(stream.stdout),
      streamToString(stream.stderr),
      stream.exitCode,
    ]);

    if (exitCode !== 0) {
      throw new RuntimeError(`Failed to stat ${filePath}: ${stderr}`, "file_io");
    }

    const parts = stdout.trim().split(" ");
    if (parts.length < 3) {
      throw new RuntimeError(`Failed to parse stat output for ${filePath}: ${stdout}`, "file_io");
    }

    const size = parseInt(parts[0], 10);
    const mtime = parseInt(parts[1], 10);
    const fileType = parts.slice(2).join(" ");

    return {
      size,
      modifiedTime: new Date(mtime * 1000),
      isDirectory: fileType === "directory",
    };
  }

  /**
   * Normalize path for comparison (POSIX semantics).
   * Shared between SSH and Docker.
   */
  normalizePath(targetPath: string, basePath: string): string {
    const target = targetPath.trim();
    let base = basePath.trim();

    // Normalize base path - remove trailing slash (except for root "/")
    if (base.length > 1 && base.endsWith("/")) {
      base = base.slice(0, -1);
    }

    // Handle special case: current directory
    if (target === ".") {
      return base;
    }

    // Handle absolute paths and tilde
    if (target.startsWith("/") || target === "~" || target.startsWith("~/")) {
      let normalizedTarget = target;
      // Remove trailing slash for comparison (except for root "/")
      if (normalizedTarget.length > 1 && normalizedTarget.endsWith("/")) {
        normalizedTarget = normalizedTarget.slice(0, -1);
      }
      return normalizedTarget;
    }

    // Relative path - resolve against base
    const normalizedTarget = base.endsWith("/") ? base + target : base + "/" + target;

    // Remove trailing slash
    if (normalizedTarget.length > 1 && normalizedTarget.endsWith("/")) {
      return normalizedTarget.slice(0, -1);
    }

    return normalizedTarget;
  }

  /**
   * Return /tmp as the temp directory for remote runtimes.
   */
  tempDir(): Promise<string> {
    return Promise.resolve("/tmp");
  }

  getMuxHome(): string {
    return "~/.mux";
  }

  // Abstract methods that subclasses must implement

  /**
   * Remote runtimes are always ready (SSH connections are re-established as needed).
   */
  ensureReady(): Promise<{ ready: boolean; error?: string }> {
    return Promise.resolve({ ready: true });
  }

  abstract resolvePath(path: string): Promise<string>;
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
}
