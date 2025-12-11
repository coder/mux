/**
 * SSH runtime implementation that executes commands and file operations
 * over SSH using the ssh command-line tool.
 *
 * Features:
 * - Uses system ssh command (respects ~/.ssh/config)
 * - Supports SSH config aliases, ProxyJump, ControlMaster, etc.
 * - No password prompts (assumes key-based auth or ssh-agent)
 * - Atomic file writes via temp + rename
 *
 * IMPORTANT: All SSH operations MUST include a timeout to prevent hangs from network issues.
 * Timeouts should be either set literally for internal operations or forwarded from upstream
 * for user-initiated operations.
 *
 * Extends RemoteRuntime for shared exec/file operations.
 */

import { spawn } from "child_process";
import * as path from "path";
import type {
  ExecOptions,
  WorkspaceCreationParams,
  WorkspaceCreationResult,
  WorkspaceInitParams,
  WorkspaceInitResult,
  WorkspaceForkParams,
  WorkspaceForkResult,
  InitLogger,
} from "./Runtime";
import { RuntimeError as RuntimeErrorClass } from "./Runtime";
import { RemoteRuntime, type SpawnResult } from "./RemoteRuntime";
import { log } from "@/node/services/log";
import { checkInitHookExists, getMuxEnv, runInitHookOnRuntime } from "./initHook";
import { expandTildeForSSH as expandHookPath } from "./tildeExpansion";
import { streamProcessToLogger } from "./streamProcess";
import { expandTildeForSSH, cdCommandForSSH } from "./tildeExpansion";
import { getProjectName, execBuffered } from "@/node/utils/runtime/helpers";
import { getErrorMessage } from "@/common/utils/errors";
import { execAsync } from "@/node/utils/disposableExec";
import { getControlPath, sshConnectionPool, type SSHRuntimeConfig } from "./sshConnectionPool";
import { getBashPath } from "@/node/utils/main/bashPath";
import { streamToString, shescape } from "./streamUtils";

// Re-export SSHRuntimeConfig from connection pool (defined there to avoid circular deps)
export type { SSHRuntimeConfig } from "./sshConnectionPool";

/**
 * SSH runtime implementation that executes commands and file operations
 * over SSH using the ssh command-line tool.
 *
 * Extends RemoteRuntime for shared exec/file operations.
 */
export class SSHRuntime extends RemoteRuntime {
  private readonly config: SSHRuntimeConfig;
  private readonly controlPath: string;
  /** Cached resolved bgOutputDir (tilde expanded to absolute path) */
  private resolvedBgOutputDir: string | null = null;

  constructor(config: SSHRuntimeConfig) {
    super();
    // Note: srcBaseDir may contain tildes - they will be resolved via resolvePath() before use
    // The WORKSPACE_CREATE IPC handler resolves paths before storing in config
    this.config = config;
    // Get deterministic controlPath from connection pool
    // Multiple SSHRuntime instances with same config share the same controlPath,
    // enabling ControlMaster to multiplex SSH connections across operations
    this.controlPath = getControlPath(config);
  }

  /**
   * Get resolved background output directory (tilde expanded), caching the result.
   * This ensures all background process paths are absolute from the start.
   * Public for use by BackgroundProcessExecutor.
   */
  async getBgOutputDir(): Promise<string> {
    if (this.resolvedBgOutputDir !== null) {
      return this.resolvedBgOutputDir;
    }

    let dir = this.config.bgOutputDir ?? "/tmp/mux-bashes";

    if (dir === "~" || dir.startsWith("~/")) {
      const result = await execBuffered(this, 'echo "$HOME"', { cwd: "/", timeout: 10 });
      let home: string;
      if (result.exitCode === 0 && result.stdout.trim()) {
        home = result.stdout.trim();
      } else {
        log.warn(
          `SSHRuntime: Failed to resolve $HOME (exitCode=${result.exitCode}). Falling back to /tmp.`
        );
        home = "/tmp";
      }
      dir = dir === "~" ? home : `${home}/${dir.slice(2)}`;
    }

    this.resolvedBgOutputDir = dir;
    return this.resolvedBgOutputDir;
  }

  /**
   * Get SSH configuration (for PTY terminal spawning)
   */
  public getConfig(): SSHRuntimeConfig {
    return this.config;
  }

  // ===== RemoteRuntime abstract method implementations =====

  protected readonly commandPrefix = "SSH";

  protected getBasePath(): string {
    return this.config.srcBaseDir;
  }

  protected quoteForRemote(filePath: string): string {
    return expandTildeForSSH(filePath);
  }

  protected cdCommand(cwd: string): string {
    return cdCommandForSSH(cwd);
  }

  /**
   * Handle exit codes for SSH connection pool health tracking.
   */
  protected onExitCode(exitCode: number, _options: ExecOptions): void {
    // SSH exit code 255 indicates connection failure - report to pool for backoff
    // This prevents thundering herd when a previously healthy host goes down
    if (exitCode === 255) {
      sshConnectionPool.reportFailure(this.config, "SSH connection failed (exit code 255)");
    } else {
      sshConnectionPool.markHealthy(this.config);
    }
  }

  protected spawnRemoteProcess(fullCommand: string, options: ExecOptions): SpawnResult {
    // Build SSH args from shared base config
    // -T: Disable pseudo-terminal allocation (default)
    // -t: Force pseudo-terminal allocation (for interactive shells)
    const sshArgs: string[] = [options.forcePTY ? "-t" : "-T", ...this.buildSSHArgs()];

    // Set comprehensive timeout options to ensure SSH respects the timeout
    // ConnectTimeout: Maximum time to wait for connection establishment (DNS, TCP handshake, SSH auth)
    // Cap at 15 seconds - users wanting long timeouts for builds shouldn't wait that long for connection
    // ServerAliveInterval: Send keepalive every 5 seconds to detect dead connections
    // ServerAliveCountMax: Consider connection dead after 2 missed keepalives (10 seconds total)
    const connectTimeout =
      options.timeout !== undefined ? Math.min(Math.ceil(options.timeout), 15) : 15;
    sshArgs.push("-o", `ConnectTimeout=${connectTimeout}`);
    // Set aggressive keepalives to detect dead connections
    sshArgs.push("-o", "ServerAliveInterval=5");
    sshArgs.push("-o", "ServerAliveCountMax=2");

    sshArgs.push(this.config.host, fullCommand);

    // Spawn ssh command
    const process = spawn("ssh", sshArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      // Prevent console window from appearing on Windows
      windowsHide: true,
    });

    // Pre-exec: acquire connection from pool for backoff protection
    const preExec = sshConnectionPool.acquireConnection(this.config);

    return { process, preExec };
  }

  /**
   * Override buildWriteCommand for SSH to handle symlinks and preserve permissions.
   */
  protected buildWriteCommand(quotedPath: string, quotedTempPath: string): string {
    // Resolve symlinks to get the actual target path, preserving the symlink itself
    // If target exists, save its permissions to restore after write
    // If path doesn't exist, use 600 as default
    // Then write atomically using mv (all-or-nothing for readers)
    return `RESOLVED=$(readlink -f ${quotedPath} 2>/dev/null || echo ${quotedPath}) && PERMS=$(stat -c '%a' "$RESOLVED" 2>/dev/null || echo 600) && mkdir -p $(dirname "$RESOLVED") && cat > ${quotedTempPath} && chmod "$PERMS" ${quotedTempPath} && mv ${quotedTempPath} "$RESOLVED"`;
  }

  // ===== SSH-specific helper methods =====

  /**
   * Build base SSH args shared by all SSH operations.
   * Includes: port, identity file, LogLevel, ControlMaster options.
   */
  private buildSSHArgs(): string[] {
    const args: string[] = [];

    // Add port if specified
    if (this.config.port) {
      args.push("-p", this.config.port.toString());
    }

    // Add identity file if specified
    if (this.config.identityFile) {
      args.push("-i", this.config.identityFile);
      // Disable strict host key checking for test environments
      args.push("-o", "StrictHostKeyChecking=no");
      args.push("-o", "UserKnownHostsFile=/dev/null");
    }

    // Suppress SSH warnings (e.g., ControlMaster messages) that would pollute command output
    // These go to stderr and get merged with stdout in bash tool results
    // Use FATAL (not ERROR) because mux_client_request_session messages are at ERROR level
    args.push("-o", "LogLevel=FATAL");

    // Add ControlMaster options for connection multiplexing
    // This ensures all SSH operations reuse the master connection
    args.push("-o", "ControlMaster=auto");
    args.push("-o", `ControlPath=${this.controlPath}`);
    args.push("-o", "ControlPersist=60");

    return args;
  }

  /**
   * Execute a simple SSH command and return stdout
   * @param command - The command to execute on the remote host
   * @param timeoutMs - Timeout in milliseconds (required to prevent network hangs)
   * @private
   */
  private async execSSHCommand(command: string, timeoutMs: number): Promise<string> {
    // Ensure connection is healthy before executing
    await sshConnectionPool.acquireConnection(this.config, timeoutMs);

    const sshArgs = this.buildSSHArgs();
    sshArgs.push(this.config.host, command);

    return new Promise((resolve, reject) => {
      const proc = spawn("ssh", sshArgs, {
        // Prevent console window from appearing on Windows
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      // Set timeout to prevent hanging on network issues
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
        reject(
          new RuntimeErrorClass(`SSH command timed out after ${timeoutMs}ms: ${command}`, "network")
        );
      }, timeoutMs);

      proc.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) return; // Already rejected

        if (code !== 0) {
          // SSH exit code 255 indicates connection failure - report to pool for backoff
          if (code === 255) {
            sshConnectionPool.reportFailure(this.config, "SSH connection failed (exit code 255)");
          }
          reject(new RuntimeErrorClass(`SSH command failed: ${stderr.trim()}`, "network"));
          return;
        }

        // Connection worked - mark healthy to clear any backoff state
        sshConnectionPool.markHealthy(this.config);
        const output = stdout.trim();
        resolve(output);
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        if (timedOut) return; // Already rejected

        // Spawn errors are connection-level failures
        sshConnectionPool.reportFailure(this.config, `SSH spawn error: ${getErrorMessage(err)}`);
        reject(
          new RuntimeErrorClass(
            `Cannot execute SSH command: ${getErrorMessage(err)}`,
            "network",
            err instanceof Error ? err : undefined
          )
        );
      });
    });
  }

  // ===== Runtime interface implementations =====

  async resolvePath(filePath: string): Promise<string> {
    // Expand ~ on the remote host.
    // Note: `p='~/x'; echo "$p"` does NOT expand ~ (tilde expansion happens before assignment).
    // We do explicit expansion using parameter substitution (no reliance on `realpath`, `readlink -f`, etc.).
    const script = [
      `p=${shescape.quote(filePath)}`,
      'if [ "$p" = "~" ]; then',
      '  echo "$HOME"',
      'elif [ "${p#\\~/}" != "$p" ]; then',
      '  echo "$HOME/${p#\\~/}"',
      'elif [ "${p#/}" != "$p" ]; then',
      '  echo "$p"',
      "else",
      '  echo "$PWD/$p"',
      "fi",
    ].join("\n");

    const command = `bash -lc ${shescape.quote(script)}`;

    // Use 10 second timeout for path resolution to allow for slower SSH connections
    return this.execSSHCommand(command, 10000);
  }

  getWorkspacePath(projectPath: string, workspaceName: string): string {
    const projectName = getProjectName(projectPath);
    return path.posix.join(this.config.srcBaseDir, projectName, workspaceName);
  }

  /**
   * Sync project to remote using git bundle
   *
   * Uses `git bundle` to create a packfile and clones it on the remote.
   *
   * Benefits over git archive:
   * - Creates a real git repository on remote (can run git commands)
   * - Better parity with git worktrees (full .git directory with metadata)
   * - Enables remote git operations (commit, branch, status, diff, etc.)
   * - Only tracked files in checkout (no node_modules, build artifacts)
   * - Includes full history for flexibility
   *
   * Benefits over rsync/scp:
   * - Much faster (only tracked files)
   * - No external dependencies (git is always available)
   * - Simpler implementation
   */
  private async syncProjectToRemote(
    projectPath: string,
    workspacePath: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<void> {
    // Short-circuit if already aborted
    if (abortSignal?.aborted) {
      throw new Error("Sync operation aborted before starting");
    }

    // Use timestamp-based bundle path to avoid conflicts (simpler than $$)
    const timestamp = Date.now();
    const bundleTempPath = `~/.mux-bundle-${timestamp}.bundle`;

    try {
      // Step 1: Get origin URL from local repository (if it exists)
      let originUrl: string | null = null;
      try {
        using proc = execAsync(
          `cd ${shescape.quote(projectPath)} && git remote get-url origin 2>/dev/null || true`
        );
        const { stdout } = await proc.result;
        const url = stdout.trim();
        // Only use URL if it's not a bundle path (avoids propagating bundle paths)
        if (url && !url.includes(".bundle") && !url.includes(".mux-bundle")) {
          originUrl = url;
        }
      } catch (error) {
        // If we can't get origin, continue without it
        initLogger.logStderr(`Could not get origin URL: ${getErrorMessage(error)}`);
      }

      // Step 2: Create bundle locally and pipe to remote file via SSH
      initLogger.logStep(`Creating git bundle...`);
      await new Promise<void>((resolve, reject) => {
        // Check if aborted before spawning
        if (abortSignal?.aborted) {
          reject(new Error("Bundle creation aborted"));
          return;
        }

        const sshArgs = [...this.buildSSHArgs(), this.config.host];
        const command = `cd ${shescape.quote(projectPath)} && git bundle create - --all | ssh ${sshArgs.join(" ")} "cat > ${bundleTempPath}"`;

        log.debug(`Creating bundle: ${command}`);
        const bashPath = getBashPath();
        const proc = spawn(bashPath, ["-c", command], {
          // Prevent console window from appearing on Windows
          windowsHide: true,
        });

        const cleanup = streamProcessToLogger(proc, initLogger, {
          logStdout: false,
          logStderr: true,
          abortSignal,
        });

        let stderr = "";
        proc.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });

        proc.on("close", (code) => {
          cleanup();
          if (abortSignal?.aborted) {
            reject(new Error("Bundle creation aborted"));
          } else if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Failed to create bundle: ${stderr}`));
          }
        });

        proc.on("error", (err) => {
          cleanup();
          reject(err);
        });
      });

      // Step 3: Clone from bundle on remote using this.exec
      initLogger.logStep(`Cloning repository on remote...`);

      // Expand tilde in destination path for git clone
      // git doesn't expand tilde when it's quoted, so we need to expand it ourselves
      const cloneDestPath = expandTildeForSSH(workspacePath);

      const cloneStream = await this.exec(`git clone --quiet ${bundleTempPath} ${cloneDestPath}`, {
        cwd: "~",
        timeout: 300, // 5 minutes for clone
        abortSignal,
      });

      const [cloneStdout, cloneStderr, cloneExitCode] = await Promise.all([
        streamToString(cloneStream.stdout),
        streamToString(cloneStream.stderr),
        cloneStream.exitCode,
      ]);

      if (cloneExitCode !== 0) {
        throw new Error(`Failed to clone repository: ${cloneStderr || cloneStdout}`);
      }

      // Step 4: Create local tracking branches for all remote branches
      // This ensures that branch names like "custom-trunk" can be used directly
      // in git checkout commands, rather than needing "origin/custom-trunk"
      initLogger.logStep(`Creating local tracking branches...`);
      const createTrackingBranchesStream = await this.exec(
        `cd ${cloneDestPath} && for branch in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin/ | grep -v 'origin/HEAD'); do localname=\${branch#origin/}; git show-ref --verify --quiet refs/heads/$localname || git branch $localname $branch; done`,
        {
          cwd: "~",
          timeout: 30,
          abortSignal,
        }
      );
      await createTrackingBranchesStream.exitCode;
      // Don't fail if this fails - some branches may already exist

      // Step 5: Update origin remote if we have an origin URL
      if (originUrl) {
        initLogger.logStep(`Setting origin remote to ${originUrl}...`);
        const setOriginStream = await this.exec(
          `git -C ${cloneDestPath} remote set-url origin ${shescape.quote(originUrl)}`,
          {
            cwd: "~",
            timeout: 10,
            abortSignal,
          }
        );

        const setOriginExitCode = await setOriginStream.exitCode;
        if (setOriginExitCode !== 0) {
          const stderr = await streamToString(setOriginStream.stderr);
          log.info(`Failed to set origin remote: ${stderr}`);
          // Continue anyway - this is not fatal
        }
      } else {
        // No origin in local repo, remove the origin that points to bundle
        initLogger.logStep(`Removing bundle origin remote...`);
        const removeOriginStream = await this.exec(
          `git -C ${cloneDestPath} remote remove origin 2>/dev/null || true`,
          {
            cwd: "~",
            timeout: 10,
            abortSignal,
          }
        );
        await removeOriginStream.exitCode;
      }

      // Step 5: Remove bundle file
      initLogger.logStep(`Cleaning up bundle file...`);
      const rmStream = await this.exec(`rm ${bundleTempPath}`, {
        cwd: "~",
        timeout: 10,
        abortSignal,
      });

      const rmExitCode = await rmStream.exitCode;
      if (rmExitCode !== 0) {
        log.info(`Failed to remove bundle file ${bundleTempPath}, but continuing`);
      }

      initLogger.logStep(`Repository cloned successfully`);
    } catch (error) {
      // Try to clean up bundle file on error
      try {
        const rmStream = await this.exec(`rm -f ${bundleTempPath}`, {
          cwd: "~",
          timeout: 10,
          abortSignal,
        });
        await rmStream.exitCode;
      } catch {
        // Ignore cleanup errors
      }

      throw error;
    }
  }

  async createWorkspace(params: WorkspaceCreationParams): Promise<WorkspaceCreationResult> {
    try {
      const { projectPath, branchName, initLogger, abortSignal } = params;
      // Compute workspace path using canonical method
      const workspacePath = this.getWorkspacePath(projectPath, branchName);

      // Prepare parent directory for git clone (fast - returns immediately)
      // Note: git clone will create the workspace directory itself during initWorkspace,
      // but the parent directory must exist first
      initLogger.logStep("Preparing remote workspace...");
      try {
        // Extract parent directory from workspace path
        // Example: ~/workspace/project/branch -> ~/workspace/project
        const lastSlash = workspacePath.lastIndexOf("/");
        const parentDir = lastSlash > 0 ? workspacePath.substring(0, lastSlash) : "~";

        // Expand tilde for mkdir command
        const expandedParentDir = expandTildeForSSH(parentDir);
        const parentDirCommand = `mkdir -p ${expandedParentDir}`;

        const mkdirStream = await this.exec(parentDirCommand, {
          cwd: "/tmp",
          timeout: 10,
          abortSignal,
        });
        const mkdirExitCode = await mkdirStream.exitCode;
        if (mkdirExitCode !== 0) {
          const stderr = await streamToString(mkdirStream.stderr);
          return {
            success: false,
            error: `Failed to prepare remote workspace: ${stderr}`,
          };
        }
      } catch (error) {
        return {
          success: false,
          error: `Failed to prepare remote workspace: ${getErrorMessage(error)}`,
        };
      }

      initLogger.logStep("Remote workspace prepared");

      return {
        success: true,
        workspacePath,
      };
    } catch (error) {
      return {
        success: false,
        error: getErrorMessage(error),
      };
    }
  }

  async initWorkspace(params: WorkspaceInitParams): Promise<WorkspaceInitResult> {
    const { projectPath, branchName, trunkBranch, workspacePath, initLogger, abortSignal } = params;

    try {
      // 1. Sync project to remote (opportunistic rsync with scp fallback)
      initLogger.logStep("Syncing project files to remote...");
      try {
        await this.syncProjectToRemote(projectPath, workspacePath, initLogger, abortSignal);
      } catch (error) {
        const errorMsg = getErrorMessage(error);
        initLogger.logStderr(`Failed to sync project: ${errorMsg}`);
        initLogger.logComplete(-1);
        return {
          success: false,
          error: `Failed to sync project: ${errorMsg}`,
        };
      }
      initLogger.logStep("Files synced successfully");

      // 2. Checkout branch remotely
      // If branch exists locally, check it out; otherwise create it from the specified trunk branch
      // Note: We've already created local branches for all remote refs in syncProjectToRemote
      initLogger.logStep(`Checking out branch: ${branchName}`);

      // Try to checkout existing branch, or create new branch from trunk
      // Since we've created local branches for all remote refs, we can use branch names directly
      const checkoutCmd = `git checkout ${shescape.quote(branchName)} 2>/dev/null || git checkout -b ${shescape.quote(branchName)} ${shescape.quote(trunkBranch)}`;

      const checkoutStream = await this.exec(checkoutCmd, {
        cwd: workspacePath, // Use the full workspace path for git operations
        timeout: 300, // 5 minutes for git checkout (can be slow on large repos)
        abortSignal,
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        streamToString(checkoutStream.stdout),
        streamToString(checkoutStream.stderr),
        checkoutStream.exitCode,
      ]);

      if (exitCode !== 0) {
        const errorMsg = `Failed to checkout branch: ${stderr || stdout}`;
        initLogger.logStderr(errorMsg);
        initLogger.logComplete(-1);
        return {
          success: false,
          error: errorMsg,
        };
      }
      initLogger.logStep("Branch checked out successfully");

      // 3. Pull latest from origin (best-effort, non-blocking on failure)
      await this.pullLatestFromOrigin(workspacePath, trunkBranch, initLogger, abortSignal);

      // 4. Run .mux/init hook if it exists
      // Note: runInitHookOnRuntime calls logComplete() internally
      const hookExists = await checkInitHookExists(projectPath);
      if (hookExists) {
        const muxEnv = getMuxEnv(projectPath, "ssh", branchName);
        // Expand tilde in hook path (quoted paths don't auto-expand on remote)
        const hookPath = expandHookPath(`${workspacePath}/.mux/init`);
        await runInitHookOnRuntime(this, hookPath, workspacePath, muxEnv, initLogger, abortSignal);
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
   * Fetch and rebase on latest origin/<trunkBranch> on remote
   * Best-effort operation - logs status but doesn't fail workspace initialization
   */
  private async pullLatestFromOrigin(
    workspacePath: string,
    trunkBranch: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<void> {
    try {
      initLogger.logStep(`Fetching latest from origin/${trunkBranch}...`);

      // Fetch the trunk branch from origin
      const fetchCmd = `git fetch origin ${shescape.quote(trunkBranch)}`;
      const fetchStream = await this.exec(fetchCmd, {
        cwd: workspacePath,
        timeout: 120, // 2 minutes for network operation
        abortSignal,
      });

      const fetchExitCode = await fetchStream.exitCode;
      if (fetchExitCode !== 0) {
        const fetchStderr = await streamToString(fetchStream.stderr);
        initLogger.logStderr(
          `Note: Could not fetch from origin (${fetchStderr}), using local branch state`
        );
        return;
      }

      initLogger.logStep("Fast-forward merging...");

      // Attempt fast-forward merge from origin/<trunkBranch>
      const mergeCmd = `git merge --ff-only origin/${shescape.quote(trunkBranch)}`;
      const mergeStream = await this.exec(mergeCmd, {
        cwd: workspacePath,
        timeout: 60, // 1 minute for fast-forward merge
        abortSignal,
      });

      const [mergeStderr, mergeExitCode] = await Promise.all([
        streamToString(mergeStream.stderr),
        mergeStream.exitCode,
      ]);

      if (mergeExitCode !== 0) {
        // Fast-forward not possible (diverged branches) - just warn
        initLogger.logStderr(
          `Note: Fast-forward skipped (${mergeStderr || "branches diverged"}), using local branch state`
        );
      } else {
        initLogger.logStep("Fast-forwarded to latest origin successfully");
      }
    } catch (error) {
      // Non-fatal: log and continue
      const errorMsg = getErrorMessage(error);
      initLogger.logStderr(
        `Note: Could not fetch from origin (${errorMsg}), using local branch state`
      );
    }
  }

  async renameWorkspace(
    projectPath: string,
    oldName: string,
    newName: string,
    abortSignal?: AbortSignal
  ): Promise<
    { success: true; oldPath: string; newPath: string } | { success: false; error: string }
  > {
    // Check if already aborted
    if (abortSignal?.aborted) {
      return { success: false, error: "Rename operation aborted" };
    }
    // Compute workspace paths using canonical method
    const oldPath = this.getWorkspacePath(projectPath, oldName);
    const newPath = this.getWorkspacePath(projectPath, newName);

    try {
      // SSH runtimes use plain directories, not git worktrees
      // Expand tilde and quote paths (expandTildeForSSH handles both expansion and quoting)
      const expandedOldPath = expandTildeForSSH(oldPath);
      const expandedNewPath = expandTildeForSSH(newPath);

      // Just use mv to rename the directory on the remote host
      const moveCommand = `mv ${expandedOldPath} ${expandedNewPath}`;

      // Execute via the runtime's exec method (handles SSH connection multiplexing, etc.)
      const stream = await this.exec(moveCommand, {
        cwd: this.config.srcBaseDir,
        timeout: 30,
        abortSignal,
      });

      // Command doesn't use stdin - abort to close immediately without waiting
      await stream.stdin.abort();
      const exitCode = await stream.exitCode;

      if (exitCode !== 0) {
        // Read stderr for error message
        const stderrReader = stream.stderr.getReader();
        const decoder = new TextDecoder();
        let stderr = "";
        try {
          while (true) {
            const { done, value } = await stderrReader.read();
            if (done) break;
            stderr += decoder.decode(value, { stream: true });
          }
        } finally {
          stderrReader.releaseLock();
        }

        return {
          success: false,
          error: `Failed to rename directory: ${stderr.trim() || "Unknown error"}`,
        };
      }

      return { success: true, oldPath, newPath };
    } catch (error) {
      return {
        success: false,
        error: `Failed to rename directory: ${getErrorMessage(error)}`,
      };
    }
  }

  async deleteWorkspace(
    projectPath: string,
    workspaceName: string,
    force: boolean,
    abortSignal?: AbortSignal
  ): Promise<{ success: true; deletedPath: string } | { success: false; error: string }> {
    // Check if already aborted
    if (abortSignal?.aborted) {
      return { success: false, error: "Delete operation aborted" };
    }

    // Compute workspace path using canonical method
    const deletedPath = this.getWorkspacePath(projectPath, workspaceName);

    try {
      // Combine all pre-deletion checks into a single bash script to minimize round trips
      // Exit codes: 0=ok to delete, 1=uncommitted changes, 2=unpushed commits, 3=doesn't exist
      const checkScript = force
        ? // When force=true, only check existence
          `test -d ${shescape.quote(deletedPath)} || exit 3`
        : // When force=false, perform all safety checks
          `
            test -d ${shescape.quote(deletedPath)} || exit 3
            cd ${shescape.quote(deletedPath)} || exit 1
            git diff --quiet --exit-code && git diff --quiet --cached --exit-code || exit 1
            if git remote | grep -q .; then
              # First, check the original condition: any commits not in any remote
              unpushed=$(git log --branches --not --remotes --oneline)
              if [ -n "$unpushed" ]; then
                # Get current branch for better error messaging
                BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

                # Get default branch (prefer main/master over origin/HEAD since origin/HEAD
                # might point to a feature branch in some setups)
                if git rev-parse --verify origin/main >/dev/null 2>&1; then
                  DEFAULT="main"
                elif git rev-parse --verify origin/master >/dev/null 2>&1; then
                  DEFAULT="master"
                else
                  # Fallback to origin/HEAD if main/master don't exist
                  DEFAULT=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
                fi

                # Check for squash-merge: if all changed files match origin/$DEFAULT, content is merged
                if [ -n "$DEFAULT" ]; then
                  # Fetch latest to ensure we have current remote state
                  git fetch origin "$DEFAULT" --quiet 2>/dev/null || true

                  # Get merge-base between current branch and default
                  MERGE_BASE=$(git merge-base "origin/$DEFAULT" HEAD 2>/dev/null)
                  if [ -n "$MERGE_BASE" ]; then
                    # Get files changed on this branch since fork point
                    CHANGED_FILES=$(git diff --name-only "$MERGE_BASE" HEAD 2>/dev/null)

                    if [ -n "$CHANGED_FILES" ]; then
                      # Check if all changed files match what's in origin/$DEFAULT
                      ALL_MERGED=true
                      while IFS= read -r f; do
                        # Compare file content between HEAD and origin/$DEFAULT
                        # If file doesn't exist in one but exists in other, they differ
                        if ! git diff --quiet "HEAD:$f" "origin/$DEFAULT:$f" 2>/dev/null; then
                          ALL_MERGED=false
                          break
                        fi
                      done <<< "$CHANGED_FILES"

                      if $ALL_MERGED; then
                        # All changes are in default branch - safe to delete (squash-merge case)
                        exit 0
                      fi
                    else
                      # No changed files means nothing to merge - safe to delete
                      exit 0
                    fi
                  fi
                fi

                # If we get here, there are real unpushed changes
                # Show helpful output for debugging
                if [ -n "$BRANCH" ] && [ -n "$DEFAULT" ] && git show-branch "$BRANCH" "origin/$DEFAULT" >/dev/null 2>&1; then
                  echo "Branch status compared to origin/$DEFAULT:" >&2
                  echo "" >&2
                  git show-branch "$BRANCH" "origin/$DEFAULT" 2>&1 | head -20 >&2
                  echo "" >&2
                  echo "Note: Branch has changes not yet in origin/$DEFAULT." >&2
                else
                  # Fallback to just showing the commit list
                  echo "$unpushed" | head -10 >&2
                fi
                exit 2
              fi
            fi
            exit 0
          `;

      const checkStream = await this.exec(checkScript, {
        cwd: this.config.srcBaseDir,
        timeout: 10,
        abortSignal,
      });

      // Command doesn't use stdin - abort to close immediately without waiting
      await checkStream.stdin.abort();
      const checkExitCode = await checkStream.exitCode;

      // Handle check results
      if (checkExitCode === 3) {
        // Directory doesn't exist - deletion is idempotent (success)
        return { success: true, deletedPath };
      }

      if (checkExitCode === 1) {
        return {
          success: false,
          error: "Workspace contains uncommitted changes. Use force flag to delete anyway.",
        };
      }

      if (checkExitCode === 2) {
        // Read stderr which contains the unpushed commits output
        const stderr = await streamToString(checkStream.stderr);
        const commitList = stderr.trim();
        const errorMsg = commitList
          ? `Workspace contains unpushed commits:\n\n${commitList}`
          : "Workspace contains unpushed commits. Use force flag to delete anyway.";

        return {
          success: false,
          error: errorMsg,
        };
      }

      if (checkExitCode !== 0) {
        // Unexpected error
        const stderr = await streamToString(checkStream.stderr);
        return {
          success: false,
          error: `Failed to check workspace state: ${stderr.trim() || `exit code ${checkExitCode}`}`,
        };
      }

      // SSH runtimes use plain directories, not git worktrees
      // Use rm -rf to remove the directory on the remote host
      const removeCommand = `rm -rf ${shescape.quote(deletedPath)}`;

      // Execute via the runtime's exec method (handles SSH connection multiplexing, etc.)
      const stream = await this.exec(removeCommand, {
        cwd: this.config.srcBaseDir,
        timeout: 30,
        abortSignal,
      });

      // Command doesn't use stdin - abort to close immediately without waiting
      await stream.stdin.abort();
      const exitCode = await stream.exitCode;

      if (exitCode !== 0) {
        // Read stderr for error message
        const stderr = await streamToString(stream.stderr);
        return {
          success: false,
          error: `Failed to delete directory: ${stderr.trim() || "Unknown error"}`,
        };
      }

      return { success: true, deletedPath };
    } catch (error) {
      return { success: false, error: `Failed to delete directory: ${getErrorMessage(error)}` };
    }
  }

  forkWorkspace(_params: WorkspaceForkParams): Promise<WorkspaceForkResult> {
    return Promise.resolve({
      success: false,
      error: "Forking SSH workspaces is not yet implemented. Create a new workspace instead.",
    });
  }
}
