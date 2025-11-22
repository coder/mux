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
import { listLocalBranches } from "@/node/git";
import {
  checkInitHookExists,
  getInitHookPath,
  createLineBufferedLoggers,
  getInitHookEnv,
} from "./initHook";
import { execAsync, DisposableProcess } from "@/node/utils/disposableExec";
import { getProjectName } from "@/node/utils/runtime/helpers";
import type { RuntimeConfig } from "@/common/types/runtime";
import { getErrorMessage } from "@/common/utils/errors";
import { expandTilde } from "./tildeExpansion";

type LocalRuntimeConfig = Extract<RuntimeConfig, { type: "worktree" | "local" }>;

/**
 * Local runtime implementation that executes commands and file operations
 * directly on the host machine using Node.js APIs.
 */
export class LocalRuntime implements Runtime {
  private readonly config: LocalRuntimeConfig;
  private readonly srcBaseDir: string | null;

  constructor(config: LocalRuntimeConfig) {
    if (config.type === "worktree") {
      this.config = { ...config, srcBaseDir: expandTilde(config.srcBaseDir) };
      this.srcBaseDir = this.config.srcBaseDir;
    } else {
      this.config = config;
      this.srcBaseDir = null;
    }
  }

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

    // If niceness is specified on Unix/Linux, spawn nice directly to avoid escaping issues
    // Windows doesn't have nice command, so just spawn bash directly
    const isWindows = process.platform === "win32";
    const bashPath = getBashPath();
    const spawnCommand = options.niceness !== undefined && !isWindows ? "nice" : bashPath;
    const spawnArgs =
      options.niceness !== undefined && !isWindows
        ? ["-n", options.niceness.toString(), bashPath, "-c", command]
        : ["-c", command];

    const childProcess = spawn(spawnCommand, spawnArgs, {
      cwd,
      env: {
        ...process.env,
        ...(options.env ?? {}),
        ...NON_INTERACTIVE_ENV_VARS,
      },
      stdio: ["pipe", "pipe", "pipe"],
      // CRITICAL: Spawn as detached process group leader to enable cleanup of background processes.
      // When a bash script spawns background processes (e.g., `sleep 100 &`), we need to kill
      // the entire process group (including all backgrounded children) via process.kill(-pid).
      // NOTE: detached:true does NOT cause bash to wait for background jobs when using 'exit' event
      // instead of 'close' event. The 'exit' event fires when bash exits, ignoring background children.
      detached: true,
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
      void exitCode.finally(() => clearTimeout(timeoutHandle));
    }

    return { stdout, stderr, stdin, exitCode, duration };
  }

  readFile(filePath: string, _abortSignal?: AbortSignal): ReadableStream<Uint8Array> {
    // Note: _abortSignal ignored for local operations (fast, no need for cancellation)
    const nodeStream = fs.createReadStream(filePath);

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
    let tempPath: string;
    let writer: WritableStreamDefaultWriter<Uint8Array>;
    let resolvedPath: string;
    let originalMode: number | undefined;

    return new WritableStream<Uint8Array>({
      async start() {
        // Resolve symlinks to write through them (preserves the symlink)
        try {
          resolvedPath = await fsPromises.realpath(filePath);
          // Save original permissions to restore after write
          const stat = await fsPromises.stat(resolvedPath);
          originalMode = stat.mode;
        } catch {
          // If file doesn't exist, use the original path and default permissions
          resolvedPath = filePath;
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
    try {
      const stats = await fsPromises.stat(filePath);
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
    return path.resolve(basePath, target);
  }

  getWorkspacePath(projectPath: string, workspaceName: string): string {
    if (this.config.type === "local") {
      return projectPath;
    }

    const projectName = getProjectName(projectPath);
    if (!this.srcBaseDir) {
      throw new RuntimeErrorClass("Worktree base directory not configured", "unknown");
    }
    return path.join(this.srcBaseDir, projectName, workspaceName);
  }

  async createWorkspace(params: WorkspaceCreationParams): Promise<WorkspaceCreationResult> {
    if (this.config.type === "local") {
      return this.createInPlaceWorkspace(params);
    }

    return this.createWorktreeWorkspace(params);
  }

  private async createWorktreeWorkspace(
    params: WorkspaceCreationParams
  ): Promise<WorkspaceCreationResult> {
    const { projectPath, branchName, trunkBranch, initLogger } = params;

    try {
      const workspacePath = this.getWorkspacePath(projectPath, branchName);
      initLogger.logStep("Creating git worktree...");

      const parentDir = path.dirname(workspacePath);
      try {
        await fsPromises.access(parentDir);
      } catch {
        await fsPromises.mkdir(parentDir, { recursive: true });
      }

      try {
        await fsPromises.access(workspacePath);
        return {
          success: false,
          error: `Workspace already exists at ${workspacePath}`,
        };
      } catch {
        // Workspace doesn't exist, proceed with creation
      }

      const localBranches = await listLocalBranches(projectPath);
      const branchExists = localBranches.includes(branchName);

      if (branchExists) {
        using proc = execAsync(
          `git -C "${projectPath}" worktree add "${workspacePath}" "${branchName}"`
        );
        await proc.result;
      } else {
        using proc = execAsync(
          `git -C "${projectPath}" worktree add -b "${branchName}" "${workspacePath}" "${trunkBranch}"`
        );
        await proc.result;
      }

      initLogger.logStep("Worktree created successfully");

      return { success: true, workspacePath };
    } catch (error) {
      return {
        success: false,
        error: getErrorMessage(error),
      };
    }
  }

  private async createInPlaceWorkspace(
    params: WorkspaceCreationParams
  ): Promise<WorkspaceCreationResult> {
    const { projectPath, initLogger } = params;

    initLogger.logStep("Reusing project directory in place");
    try {
      const stats = await fsPromises.stat(projectPath);
      if (!stats.isDirectory()) {
        return {
          success: false,
          error: `Project path is not a directory: ${projectPath}`,
        };
      }
    } catch (error) {
      return {
        success: false,
        error: `Failed to access project directory: ${getErrorMessage(error)}`,
      };
    }

    try {
      using branchProc = execAsync(`git -C "${projectPath}" branch --show-current`);
      const { stdout } = await branchProc.result;
      const branch = stdout.trim();
      if (branch) {
        initLogger.logStep(`Active branch: ${branch}`);
      } else {
        initLogger.logStep("Working tree is in detached HEAD state");
      }
    } catch {
      // Ignore errors - project may not be a git repository
    }

    try {
      using statusProc = execAsync(`git -C "${projectPath}" status --porcelain`);
      const { stdout } = await statusProc.result;
      if (stdout.trim().length > 0) {
        initLogger.logStep(
          "Project has uncommitted changes; agent will operate on existing working tree"
        );
      }
    } catch {
      // Ignore errors - project may not be a git repository
    }

    return { success: true, workspacePath: projectPath };
  }

  async initWorkspace(params: WorkspaceInitParams): Promise<WorkspaceInitResult> {
    const { projectPath, workspacePath, initLogger } = params;

    try {
      // Run .mux/init hook if it exists
      // Note: runInitHook calls logComplete() internally if hook exists
      const hookExists = await checkInitHookExists(projectPath);
      if (hookExists) {
        await this.runInitHook(projectPath, workspacePath, initLogger);
      } else {
        // No hook - signal completion immediately
        initLogger.logComplete(0);
      }
      return { success: true };
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      initLogger.logStderr(`Initialization failed: ${errorMsg}`);
      initLogger.logComplete(-1);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Run .mux/init hook if it exists and is executable
   */
  private async runInitHook(
    projectPath: string,
    workspacePath: string,
    initLogger: InitLogger
  ): Promise<void> {
    // Check if hook exists and is executable
    const hookExists = await checkInitHookExists(projectPath);
    if (!hookExists) {
      return;
    }

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
          ...getInitHookEnv(projectPath, this.config.type === "local" ? "local" : "worktree"),
        },
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

  async renameWorkspace(
    projectPath: string,
    oldName: string,
    newName: string,
    _abortSignal?: AbortSignal
  ): Promise<
    { success: true; oldPath: string; newPath: string } | { success: false; error: string }
  > {
    // Note: _abortSignal ignored for local operations (fast, no need for cancellation)
    // Compute workspace paths using canonical method
    const oldPath = this.getWorkspacePath(projectPath, oldName);

    if (this.config.type === "local") {
      return { success: true, oldPath, newPath: oldPath };
    }

    const newPath = this.getWorkspacePath(projectPath, newName);

    try {
      // Use git worktree move to rename the worktree directory
      // This updates git's internal worktree metadata correctly
      using proc = execAsync(`git -C "${projectPath}" worktree move "${oldPath}" "${newPath}"`);
      await proc.result;

      return { success: true, oldPath, newPath };
    } catch (error) {
      return { success: false, error: `Failed to move worktree: ${getErrorMessage(error)}` };
    }
  }

  async deleteWorkspace(
    projectPath: string,
    workspaceName: string,
    force: boolean,
    _abortSignal?: AbortSignal
  ): Promise<{ success: true; deletedPath: string } | { success: false; error: string }> {
    // Note: _abortSignal ignored for local operations (fast, no need for cancellation)

    const deletedPath = this.getWorkspacePath(projectPath, workspaceName);

    if (this.config.type === "local" || deletedPath === projectPath) {
      return { success: true, deletedPath };
    }

    try {
      await fsPromises.access(deletedPath);
    } catch {
      try {
        using pruneProc = execAsync(`git -C "${projectPath}" worktree prune`);
        await pruneProc.result;
      } catch {
        // Ignore prune errors - directory is already deleted, which is the goal
      }
      return { success: true, deletedPath };
    }

    try {
      // Use git worktree remove to delete the worktree
      // This updates git's internal worktree metadata correctly
      // Only use --force if explicitly requested by the caller
      const forceFlag = force ? " --force" : "";
      using proc = execAsync(
        `git -C "${projectPath}" worktree remove${forceFlag} "${deletedPath}"`
      );
      await proc.result;

      return { success: true, deletedPath };
    } catch (error) {
      const message = getErrorMessage(error);

      // Check if the error is due to missing/stale worktree
      const normalizedError = message.toLowerCase();
      const looksLikeMissingWorktree =
        normalizedError.includes("not a working tree") ||
        normalizedError.includes("does not exist") ||
        normalizedError.includes("no such file");

      if (looksLikeMissingWorktree) {
        // Worktree records are stale - prune them
        try {
          using pruneProc = execAsync(`git -C "${projectPath}" worktree prune`);
          await pruneProc.result;
        } catch {
          // Ignore prune errors
        }
        // Treat as success - workspace is gone (idempotent)
        return { success: true, deletedPath };
      }

      // If force is enabled and git worktree remove failed, fall back to rm -rf
      // This handles edge cases like submodules where git refuses to delete
      if (force) {
        try {
          // Prune git's worktree records first (best effort)
          try {
            using pruneProc = execAsync(`git -C "${projectPath}" worktree prune`);
            await pruneProc.result;
          } catch {
            // Ignore prune errors - we'll still try rm -rf
          }

          // Force delete the directory
          using rmProc = execAsync(`rm -rf "${deletedPath}"`);
          await rmProc.result;

          return { success: true, deletedPath };
        } catch (rmError) {
          return {
            success: false,
            error: `Failed to remove worktree via git and rm: ${getErrorMessage(rmError)}`,
          };
        }
      }

      // force=false - return the git error without attempting rm -rf
      return { success: false, error: `Failed to remove worktree: ${message}` };
    }
  }

  async forkWorkspace(params: WorkspaceForkParams): Promise<WorkspaceForkResult> {
    if (this.config.type === "local") {
      return {
        success: false,
        error: "Forking is not supported for local (in-place) runtime",
      };
    }

    const { projectPath, sourceWorkspaceName, newWorkspaceName, initLogger } = params;

    // Get source workspace path
    const sourceWorkspacePath = this.getWorkspacePath(projectPath, sourceWorkspaceName);

    // Get current branch from source workspace
    try {
      using proc = execAsync(`git -C "${sourceWorkspacePath}" branch --show-current`);
      const { stdout } = await proc.result;
      const sourceBranch = stdout.trim();

      if (!sourceBranch) {
        return {
          success: false,
          error: "Failed to detect branch in source workspace",
        };
      }

      // Use createWorkspace with sourceBranch as trunk to fork from source branch
      const createResult = await this.createWorkspace({
        projectPath,
        branchName: newWorkspaceName,
        trunkBranch: sourceBranch, // Fork from source branch instead of main/master
        directoryName: newWorkspaceName,
        initLogger,
      });

      if (!createResult.success || !createResult.workspacePath) {
        return {
          success: false,
          error: createResult.error ?? "Failed to create workspace",
        };
      }

      return {
        success: true,
        workspacePath: createResult.workspacePath,
        sourceBranch,
      };
    } catch (error) {
      return {
        success: false,
        error: getErrorMessage(error),
      };
    }
  }
}
