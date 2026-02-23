import { spawn } from "child_process";
import * as path from "path";
import { Readable, Writable } from "stream";
import type {
  RuntimeCreateFlags,
  WorkspaceCreationParams,
  WorkspaceCreationResult,
  WorkspaceForkParams,
  WorkspaceForkResult,
  WorkspaceInitParams,
  WorkspaceInitResult,
  ExecOptions,
  ExecStream,
  EnsureReadyResult,
  EnsureReadyOptions,
  FileStat,
} from "./Runtime";
import { RuntimeError, WORKSPACE_REPO_MISSING_ERROR } from "./Runtime";
import { LocalBaseRuntime } from "./LocalBaseRuntime";
import { WorktreeManager } from "@/node/worktree/WorktreeManager";
import { expandTildeForSSH } from "./tildeExpansion";
import { shescape, streamToString } from "./streamUtils";
import {
  readHostGitconfig,
  resolveGhToken,
  resolveSshAgentForwarding,
} from "./credentialForwarding";
import { devcontainerUp, devcontainerDown } from "./devcontainerCli";
import { checkInitHookExists, getMuxEnv } from "./initHook";
import { runInitHookOnRuntime } from "./initHook";
import { DisposableProcess, killProcessTree } from "@/node/utils/disposableExec";
import { EXIT_CODE_ABORTED, EXIT_CODE_TIMEOUT } from "@/common/constants/exitCodes";
import { NON_INTERACTIVE_ENV_VARS } from "@/common/constants/env";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { isGitRepository, stripTrailingSlashes } from "@/node/utils/pathUtils";

export interface DevcontainerRuntimeOptions {
  srcBaseDir: string;
  configPath: string;
  shareCredentials?: boolean;
}

/**
 * Devcontainer runtime implementation.
 *
 * This runtime creates git worktrees on the host and runs commands inside
 * a devcontainer built from the project's devcontainer.json configuration.
 *
 * Architecture:
 * - Worktree operations (create/delete/fork) → WorktreeManager (host filesystem)
 * - Command execution (exec) → devcontainer exec (inside container)
 * - File I/O → host fs (worktree is bind-mounted into container)
 * - ensureReady → devcontainer up (starts/rebuilds container as needed)
 */
export class DevcontainerRuntime extends LocalBaseRuntime {
  private readonly worktreeManager: WorktreeManager;
  private readonly configPath: string;

  // Cached env used for credential forwarding
  private lastCredentialEnv?: Record<string, string>;
  private readonly shareCredentials: boolean;

  // Cached from devcontainer up output
  private remoteHomeDir?: string;
  private remoteWorkspaceFolder?: string;
  private remoteUser?: string;

  // Current workspace context (set during postCreateSetup/ensureReady)
  private currentWorkspacePath?: string;

  readonly createFlags: RuntimeCreateFlags = {
    deferredRuntimeAccess: true,
  };

  private buildCredentialForwarding(env?: Record<string, string>): {
    additionalMounts: string[];
    remoteEnv: Record<string, string>;
  } {
    const additionalMounts: string[] = [];
    const remoteEnv: Record<string, string> = {};

    if (!this.shareCredentials) {
      return { additionalMounts, remoteEnv };
    }

    const sshForwarding = resolveSshAgentForwarding("/tmp/ssh-agent.sock");
    if (sshForwarding) {
      additionalMounts.push(
        `type=bind,source=${sshForwarding.hostSocketPath},target=${sshForwarding.targetSocketPath}`
      );
      remoteEnv.SSH_AUTH_SOCK = sshForwarding.targetSocketPath;
    }

    const ghToken = resolveGhToken(env);
    if (ghToken) {
      remoteEnv.GH_TOKEN = ghToken;
    }

    return { additionalMounts, remoteEnv };
  }

  private mapContainerPathToHost(containerPath: string): string | null {
    if (!this.remoteWorkspaceFolder || !this.currentWorkspacePath) return null;

    const remoteRoot = this.remoteWorkspaceFolder.replace(/\/+$/, "");
    if (containerPath !== remoteRoot && !containerPath.startsWith(`${remoteRoot}/`)) return null;

    const suffix = containerPath.slice(remoteRoot.length).replace(/^\/+/, "");
    return suffix.length === 0
      ? this.currentWorkspacePath
      : path.join(this.currentWorkspacePath, suffix);
  }

  private getContainerBasePath(): string {
    return this.remoteWorkspaceFolder ?? "/";
  }

  private resolveHostPathForMounted(filePath: string): string | null {
    if (this.currentWorkspacePath) {
      const normalizedFilePath = filePath.replaceAll("\\", "/");
      const normalizedHostRoot = stripTrailingSlashes(
        this.currentWorkspacePath.replaceAll("\\", "/")
      );
      if (
        normalizedFilePath === normalizedHostRoot ||
        normalizedFilePath.startsWith(`${normalizedHostRoot}/`)
      ) {
        return filePath;
      }
    }

    return this.mapContainerPathToHost(filePath);
  }

  private quoteForContainer(filePath: string): string {
    if (filePath === "~" || filePath.startsWith("~/")) {
      return expandTildeForSSH(filePath);
    }
    return shescape.quote(filePath);
  }

  /**
   * Expand tilde in file paths for container operations.
   * Returns unexpanded path when container user is unknown (before ensureReady).
   * Callers must check for unexpanded tilde and handle appropriately.
   */
  private expandTildeForContainer(filePath: string): string {
    if (filePath === "~" || filePath.startsWith("~/")) {
      // If we know the home directory, use it
      if (this.remoteHomeDir) {
        return filePath === "~" ? this.remoteHomeDir : this.remoteHomeDir + filePath.slice(1);
      }
      // If we know the user, derive home directory
      if (this.remoteUser !== undefined) {
        const homeDir = this.remoteUser === "root" ? "/root" : `/home/${this.remoteUser}`;
        return filePath === "~" ? homeDir : homeDir + filePath.slice(1);
      }
      // User unknown - return unexpanded to signal caller should handle
      return filePath;
    }
    return filePath;
  }

  /**
   * Check if a path contains unexpanded tilde (container user unknown).
   */
  private hasUnexpandedTilde(filePath: string): boolean {
    return filePath === "~" || filePath.startsWith("~/");
  }

  private async setupCredentials(env?: Record<string, string>): Promise<void> {
    if (!this.shareCredentials) return;

    const gitconfigContents = await readHostGitconfig();
    if (gitconfigContents) {
      const stream = await this.exec('cat > "$HOME/.gitconfig"', {
        cwd: this.getContainerBasePath(),
        timeout: 30,
      });
      const writer = stream.stdin.getWriter();
      try {
        await writer.write(gitconfigContents);
      } finally {
        writer.releaseLock();
      }
      await stream.stdin.close();
      const exitCode = await stream.exitCode;
      if (exitCode !== 0) {
        const stderr = await streamToString(stream.stderr);
        throw new RuntimeError(`Failed to copy gitconfig: ${stderr}`, "file_io");
      }
    }

    const ghToken = resolveGhToken(env);
    if (ghToken) {
      const stream = await this.exec("command -v gh >/dev/null && gh auth setup-git || true", {
        cwd: this.getContainerBasePath(),
        timeout: 30,
        env: { GH_TOKEN: ghToken },
      });
      await stream.stdin.close();
      await stream.exitCode;
    }
  }

  private async fetchRemoteHome(): Promise<void> {
    if (!this.currentWorkspacePath) return;
    try {
      const stream = await this.exec('printf "%s" "$HOME"', {
        cwd: this.remoteWorkspaceFolder ?? "/",
        timeout: 10,
      });
      await stream.stdin.close();
      const stdout = await streamToString(stream.stdout);
      const exitCode = await stream.exitCode;
      if (exitCode === 0 && stdout.trim()) {
        this.remoteHomeDir = stdout.trim();
      }
    } catch {
      // Best-effort; keep going if $HOME cannot be resolved
    }
  }

  private readFileViaExec(filePath: string, abortSignal?: AbortSignal): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        try {
          const stream = await this.exec(`cat ${this.quoteForContainer(filePath)}`, {
            cwd: this.getContainerBasePath(),
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
                `Failed to read file ${filePath}: ${getErrorMessage(err)}`,
                "file_io",
                err instanceof Error ? err : undefined
              )
            );
          }
        }
      },
    });
  }

  private writeFileViaExec(
    filePath: string,
    abortSignal?: AbortSignal
  ): WritableStream<Uint8Array> {
    const quotedPath = this.quoteForContainer(filePath);
    const tempPath = `${filePath}.tmp.${Date.now()}`;
    const quotedTempPath = this.quoteForContainer(tempPath);
    const writeCommand = `mkdir -p $(dirname ${quotedPath}) && cat > ${quotedTempPath} && mv ${quotedTempPath} ${quotedPath}`;

    let execPromise: Promise<ExecStream> | null = null;

    const getExecStream = () => {
      execPromise ??= this.exec(writeCommand, {
        cwd: this.getContainerBasePath(),
        timeout: 300,
        abortSignal,
      });
      return execPromise;
    };

    return new WritableStream<Uint8Array>({
      write: async (chunk) => {
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

  private async ensureDirViaExec(dirPath: string): Promise<void> {
    const stream = await this.exec(`mkdir -p ${this.quoteForContainer(dirPath)}`, {
      cwd: "/",
      timeout: 10,
    });

    await stream.stdin.close();

    const [stdout, stderr, exitCode] = await Promise.all([
      streamToString(stream.stdout),
      streamToString(stream.stderr),
      stream.exitCode,
    ]);

    if (exitCode !== 0) {
      const extra = stderr.trim() || stdout.trim();
      throw new RuntimeError(
        `Failed to create directory ${dirPath}: exit code ${exitCode}${extra ? `: ${extra}` : ""}`,
        "file_io"
      );
    }
  }

  private async statViaExec(filePath: string, abortSignal?: AbortSignal): Promise<FileStat> {
    // -L follows symlinks so symlinked paths report the target's type
    const stream = await this.exec(`stat -L -c '%s %Y %F' ${this.quoteForContainer(filePath)}`, {
      cwd: this.getContainerBasePath(),
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
  private mapHostPathToContainer(hostPath: string): string | null {
    if (!this.remoteWorkspaceFolder || !this.currentWorkspacePath) return null;

    // Normalize to forward slashes for cross-platform comparison (Windows uses backslashes)
    const normalizedHostPath = hostPath.replaceAll("\\", "/");
    const hostRoot = this.currentWorkspacePath.replaceAll("\\", "/").replace(/\/+$/, "");
    if (normalizedHostPath !== hostRoot && !normalizedHostPath.startsWith(`${hostRoot}/`))
      return null;

    const suffix = normalizedHostPath.slice(hostRoot.length).replace(/^\/+/, "");
    return suffix.length === 0
      ? this.remoteWorkspaceFolder
      : path.posix.join(this.remoteWorkspaceFolder, suffix);
  }

  /**
   * Resolve cwd for container exec, filtering out unmappable host paths.
   * Only uses options.cwd if it looks like a valid container path (POSIX absolute, no Windows drive letters).
   */
  private resolveContainerCwd(optionsCwd: string | undefined, workspaceFolder: string): string {
    if (optionsCwd && this.looksLikeContainerPath(optionsCwd)) {
      return optionsCwd;
    }
    return this.remoteWorkspaceFolder ?? workspaceFolder;
  }

  /**
   * Check if a path looks like a valid container path (POSIX absolute, no Windows artifacts).
   */
  private looksLikeContainerPath(p: string): boolean {
    // Reject Windows drive letters (e.g., C:\, D:/)
    if (/^[A-Za-z]:/.test(p)) return false;
    // Reject backslashes (Windows path separators)
    if (p.includes("\\")) return false;
    // Must be absolute POSIX path
    return p.startsWith("/");
  }

  constructor(options: DevcontainerRuntimeOptions) {
    super();
    this.worktreeManager = new WorktreeManager(options.srcBaseDir);
    this.configPath = options.configPath;
    this.shareCredentials = options.shareCredentials ?? false;
  }

  getWorkspacePath(projectPath: string, workspaceName: string): string {
    return this.worktreeManager.getWorkspacePath(projectPath, workspaceName);
  }

  async createWorkspace(params: WorkspaceCreationParams): Promise<WorkspaceCreationResult> {
    return this.worktreeManager.createWorkspace({
      projectPath: params.projectPath,
      branchName: params.branchName,
      trunkBranch: params.trunkBranch,
      initLogger: params.initLogger,
    });
  }

  /**
   * Build and start the devcontainer after workspace creation.
   * This runs `devcontainer up` which builds the image and starts the container.
   */
  async postCreateSetup(params: WorkspaceInitParams): Promise<void> {
    const { workspacePath, initLogger, abortSignal, env } = params;

    initLogger.logStep("Building devcontainer...");

    this.lastCredentialEnv = env;
    const { additionalMounts, remoteEnv } = this.buildCredentialForwarding(env);

    try {
      const result = await devcontainerUp({
        workspaceFolder: workspacePath,
        configPath: this.configPath,
        initLogger,
        abortSignal,
        additionalMounts: additionalMounts.length > 0 ? additionalMounts : undefined,
        remoteEnv: Object.keys(remoteEnv).length > 0 ? remoteEnv : undefined,
      });

      // Cache container info
      this.remoteWorkspaceFolder = result.remoteWorkspaceFolder;
      this.remoteUser = result.remoteUser;
      this.currentWorkspacePath = workspacePath;
      await this.fetchRemoteHome();

      await this.setupCredentials(env);

      initLogger.logStep("Devcontainer ready");
    } catch (error) {
      throw new Error(`Failed to start devcontainer: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Run .mux/init hook inside the devcontainer.
   */
  async initWorkspace(params: WorkspaceInitParams): Promise<WorkspaceInitResult> {
    const { projectPath, branchName, workspacePath, initLogger, env } = params;

    try {
      // Check if init hook exists (on host - worktree is bind-mounted)
      const hookExists = await checkInitHookExists(workspacePath);
      if (hookExists) {
        initLogger.enterHookPhase?.();
        const muxEnv = { ...env, ...getMuxEnv(projectPath, "devcontainer", branchName) };
        const containerWorkspacePath = this.remoteWorkspaceFolder ?? workspacePath;
        const hookPath = `${containerWorkspacePath}/.mux/init`;
        await runInitHookOnRuntime(this, hookPath, containerWorkspacePath, muxEnv, initLogger);
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
   * Execute a command inside the devcontainer.
   * Overrides LocalBaseRuntime.exec() to use `devcontainer exec`.
   */
  override exec(command: string, options: ExecOptions): Promise<ExecStream> {
    const startTime = performance.now();

    // Short-circuit if already aborted
    if (options.abortSignal?.aborted) {
      throw new RuntimeError("Operation aborted before execution", "exec");
    }

    // Build devcontainer exec args
    const workspaceFolder = this.currentWorkspacePath;
    if (!workspaceFolder) {
      throw new RuntimeError("Devcontainer not initialized. Call ensureReady() first.", "exec");
    }

    const args = ["exec", "--workspace-folder", workspaceFolder];

    if (this.configPath) {
      args.push("--config", this.configPath);
    }

    // Add environment variables
    const envVars = { ...options.env, ...NON_INTERACTIVE_ENV_VARS };
    for (const [key, value] of Object.entries(envVars)) {
      args.push("--remote-env", `${key}=${value}`);
    }

    // Build the full command with cd
    // Map host workspace path to container path; fall back to container workspace if unmappable
    const mappedCwd = options.cwd ? this.mapHostPathToContainer(options.cwd) : null;
    const cwd = mappedCwd ?? this.resolveContainerCwd(options.cwd, workspaceFolder);
    const fullCommand = `cd ${JSON.stringify(cwd)} && ${command}`;
    args.push("--", "bash", "-c", fullCommand);

    const childProcess = spawn("devcontainer", args, {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
      cwd: workspaceFolder,
    });

    const disposable = new DisposableProcess(childProcess);

    // Convert Node.js streams to Web Streams (casts required for ExecStream compatibility)
    /* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
    const stdout = Readable.toWeb(childProcess.stdout!) as unknown as ReadableStream<Uint8Array>;
    const stderr = Readable.toWeb(childProcess.stderr!) as unknown as ReadableStream<Uint8Array>;
    const stdin = Writable.toWeb(childProcess.stdin!) as unknown as WritableStream<Uint8Array>;
    /* eslint-enable @typescript-eslint/no-unnecessary-type-assertion */

    let timedOut = false;
    let aborted = false;

    const exitCode = new Promise<number>((resolve, reject) => {
      childProcess.on("exit", (code) => {
        if (childProcess.pid !== undefined) {
          killProcessTree(childProcess.pid);
        }

        if (aborted || options.abortSignal?.aborted) {
          resolve(EXIT_CODE_ABORTED);
          return;
        }
        if (timedOut) {
          resolve(EXIT_CODE_TIMEOUT);
          return;
        }
        resolve(code ?? 0);
      });

      childProcess.on("error", (err) => {
        reject(
          new RuntimeError(`Failed to execute devcontainer exec: ${err.message}`, "exec", err)
        );
      });
    });

    const duration = exitCode.then(() => performance.now() - startTime);
    void exitCode.catch(() => undefined);
    void duration.catch(() => undefined);

    // Handle timeout
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (options.timeout && options.timeout > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        disposable[Symbol.dispose]();
      }, options.timeout * 1000);

      void exitCode.finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });
    }

    // Handle abort signal
    const abortHandler = () => {
      aborted = true;
      disposable[Symbol.dispose]();
    };
    options.abortSignal?.addEventListener("abort", abortHandler);
    void exitCode.finally(() => {
      options.abortSignal?.removeEventListener("abort", abortHandler);
    });

    return Promise.resolve({
      stdout,
      stderr,
      stdin,
      exitCode,
      duration,
    });
  }

  override readFile(filePath: string, abortSignal?: AbortSignal): ReadableStream<Uint8Array> {
    const hostPath = this.resolveHostPathForMounted(filePath);
    if (hostPath) {
      return super.readFile(hostPath, abortSignal);
    }
    return this.readFileViaExec(filePath, abortSignal);
  }

  override writeFile(filePath: string, abortSignal?: AbortSignal): WritableStream<Uint8Array> {
    const hostPath = this.resolveHostPathForMounted(filePath);
    if (hostPath) {
      return super.writeFile(hostPath, abortSignal);
    }
    return this.writeFileViaExec(filePath, abortSignal);
  }

  override async stat(filePath: string): Promise<FileStat> {
    const hostPath = this.resolveHostPathForMounted(filePath);
    if (hostPath) {
      return super.stat(hostPath);
    }
    return this.statViaExec(filePath);
  }

  override async ensureDir(dirPath: string): Promise<void> {
    const hostPath = this.resolveHostPathForMounted(dirPath);
    if (hostPath) {
      return super.ensureDir(hostPath);
    }
    return this.ensureDirViaExec(dirPath);
  }

  override async resolvePath(filePath: string): Promise<string> {
    let expanded = this.expandTildeForContainer(filePath);

    if (this.hasUnexpandedTilde(expanded)) {
      await this.fetchRemoteHome();
      if (this.remoteHomeDir) {
        expanded = filePath === "~" ? this.remoteHomeDir : this.remoteHomeDir + filePath.slice(1);
      } else {
        throw new RuntimeError(
          `Failed to resolve path ${filePath}: container home directory unavailable`,
          "exec"
        );
      }
    }

    // Resolve relative paths against container workspace (avoid host cwd leakage)
    if (!expanded.startsWith("/")) {
      const basePath = this.remoteWorkspaceFolder ?? "/";
      return path.posix.resolve(basePath, expanded);
    }

    // For absolute paths, resolve using posix (container is Linux)
    return path.posix.resolve(expanded);
  }

  override tempDir(): Promise<string> {
    const workspaceRoot = this.remoteWorkspaceFolder ?? this.currentWorkspacePath;
    if (!workspaceRoot) {
      return super.tempDir();
    }

    const tmpPath = this.remoteWorkspaceFolder
      ? path.posix.join(workspaceRoot, ".mux", "tmp")
      : path.join(workspaceRoot, ".mux", "tmp");
    return Promise.resolve(tmpPath);
  }

  /**
   * Ensure the devcontainer is ready for operations.
   * Runs `devcontainer up` which starts the container if stopped,
   * or rebuilds if the container was deleted.
   */
  override async ensureReady(options?: EnsureReadyOptions): Promise<EnsureReadyResult> {
    if (!this.currentWorkspacePath) {
      return {
        ready: false,
        error: "Workspace path not set. Call postCreateSetup() first.",
        errorType: "runtime_not_ready",
      };
    }

    const statusSink = options?.statusSink;
    statusSink?.({
      phase: "checking",
      runtimeType: "devcontainer",
      detail: "Checking repository...",
    });

    const hasRepo = await isGitRepository(this.currentWorkspacePath);
    if (!hasRepo) {
      statusSink?.({
        phase: "error",
        runtimeType: "devcontainer",
        detail: WORKSPACE_REPO_MISSING_ERROR,
      });
      return {
        ready: false,
        error: WORKSPACE_REPO_MISSING_ERROR,
        errorType: "runtime_not_ready",
      };
    }

    try {
      statusSink?.({
        phase: "starting",
        runtimeType: "devcontainer",
        detail: "Starting devcontainer...",
      });

      // Create a minimal logger for ensureReady (we don't want verbose output here)
      const silentLogger = {
        logStep: (_message: string) => {
          /* silent */
        },
        logStdout: (_line: string) => {
          /* silent */
        },
        logStderr: (line: string) => log.debug("devcontainer up stderr:", { line }),
        logComplete: (_exitCode: number) => {
          /* silent */
        },
      };

      const { additionalMounts, remoteEnv } = this.buildCredentialForwarding(
        this.lastCredentialEnv
      );
      const result = await devcontainerUp({
        workspaceFolder: this.currentWorkspacePath,
        configPath: this.configPath,
        initLogger: silentLogger,
        abortSignal: options?.signal,
        additionalMounts: additionalMounts.length > 0 ? additionalMounts : undefined,
        remoteEnv: Object.keys(remoteEnv).length > 0 ? remoteEnv : undefined,
      });

      // Update cached info (container may have been rebuilt)
      this.remoteWorkspaceFolder = result.remoteWorkspaceFolder;
      this.remoteUser = result.remoteUser;
      await this.fetchRemoteHome();

      await this.setupCredentials(this.lastCredentialEnv);

      statusSink?.({ phase: "ready", runtimeType: "devcontainer" });
      return { ready: true };
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      statusSink?.({ phase: "error", runtimeType: "devcontainer", detail: errorMsg });

      return {
        ready: false,
        error: errorMsg,
        errorType: "runtime_not_ready",
      };
    }
  }

  async renameWorkspace(
    projectPath: string,
    oldName: string,
    newName: string,
    _abortSignal?: AbortSignal
  ): Promise<
    { success: true; oldPath: string; newPath: string } | { success: false; error: string }
  > {
    // Stop container before rename (container labels reference old path)
    const oldPath = this.getWorkspacePath(projectPath, oldName);
    await devcontainerDown(oldPath, this.configPath);

    // Rename worktree on host
    const result = await this.worktreeManager.renameWorkspace(projectPath, oldName, newName);

    if (result.success) {
      // Update current workspace path if this was the active workspace
      if (this.currentWorkspacePath === oldPath) {
        this.currentWorkspacePath = result.newPath;
      }
    }

    return result;
  }

  async deleteWorkspace(
    projectPath: string,
    workspaceName: string,
    force: boolean,
    _abortSignal?: AbortSignal
  ): Promise<{ success: true; deletedPath: string } | { success: false; error: string }> {
    const workspacePath = this.getWorkspacePath(projectPath, workspaceName);

    // Stop and remove container (best-effort)
    try {
      await devcontainerDown(workspacePath, this.configPath);
    } catch (error) {
      log.debug("devcontainerDown failed (container may not exist):", { error });
    }

    // Delete worktree on host
    return this.worktreeManager.deleteWorkspace(projectPath, workspaceName, force);
  }

  async forkWorkspace(params: WorkspaceForkParams): Promise<WorkspaceForkResult> {
    // Fork creates a new worktree - container will be built on first ensureReady
    return this.worktreeManager.forkWorkspace(params);
  }

  /**
   * Set the current workspace path for exec operations.
   * Called by workspaceService when switching to an existing workspace.
   */
  setCurrentWorkspacePath(workspacePath: string): void {
    this.currentWorkspacePath = workspacePath;
  }

  /**
   * Get the remote workspace folder path (inside container).
   */
  getRemoteWorkspaceFolder(): string | undefined {
    return this.remoteWorkspaceFolder;
  }
}
