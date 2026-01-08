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
import { getControlPath, sshConnectionPool, type SSHRuntimeConfig } from "./sshConnectionPool";
import { getBashPath } from "@/node/utils/main/bashPath";
import { syncProjectViaGitBundle } from "./gitBundleSync";
import { streamToString, shescape } from "./streamUtils";

function logSSHBackoffWait(initLogger: InitLogger, waitMs: number): void {
  const secs = Math.max(1, Math.ceil(waitMs / 1000));
  initLogger.logStep(`SSH unavailable; retrying in ${secs}s...`);
}

/** Truncate SSH stderr for error logging (keep first line, max 200 chars) */
function truncateSSHError(stderr: string): string {
  const trimmed = stderr.trim();
  if (!trimmed) return "exit code 255";
  // Take first line only (SSH errors are usually single-line)
  const firstLine = trimmed.split("\n")[0];
  if (firstLine.length <= 200) return firstLine;
  return firstLine.slice(0, 197) + "...";
}

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
  protected override onExitCode(exitCode: number, _options: ExecOptions, stderr: string): void {
    // SSH exit code 255 indicates connection failure - report to pool for backoff
    // This prevents thundering herd when a previously healthy host goes down
    if (exitCode === 255) {
      sshConnectionPool.reportFailure(this.config, truncateSSHError(stderr));
    } else {
      sshConnectionPool.markHealthy(this.config);
    }
  }

  protected async spawnRemoteProcess(
    fullCommand: string,
    options: ExecOptions
  ): Promise<SpawnResult> {
    // Acquire connection from pool BEFORE spawning (enforces backoff)
    await sshConnectionPool.acquireConnection(this.config, {
      abortSignal: options.abortSignal,
    });

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

    // Debug: log the SSH host (fullCommand may contain secrets via env exports)
    log.debug(`SSH exec on ${this.config.host}`);
    // Spawn ssh command
    const process = spawn("ssh", sshArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      // Prevent console window from appearing on Windows
      windowsHide: true,
    });

    return { process };
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
    // Use timestamp-based bundle path to avoid conflicts (simpler than $$)
    const timestamp = Date.now();
    const remoteBundlePath = `~/.mux-bundle-${timestamp}.bundle`;

    await syncProjectViaGitBundle({
      projectPath,
      workspacePath,
      remoteTmpDir: "~",
      remoteBundlePath,
      exec: (command, options) => this.exec(command, options),
      quoteRemotePath: (path) => this.quoteForRemote(path),
      logOriginErrors: true,
      initLogger,
      abortSignal,
      cloneStep: "Cloning repository on remote...",
      createRemoteBundle: async ({ remoteBundlePath, initLogger, abortSignal }) => {
        // Ensure the SSH host is reachable before doing expensive local work.
        await sshConnectionPool.acquireConnection(this.config, {
          abortSignal,
          onWait: (waitMs) => logSSHBackoffWait(initLogger, waitMs),
        });

        await new Promise<void>((resolve, reject) => {
          if (abortSignal?.aborted) {
            reject(new Error("Bundle creation aborted"));
            return;
          }

          // Build SSH args with timeout options to detect connection failures quickly.
          // Without these, SSH can hang indefinitely, causing git to receive SIGPIPE and report
          // the cryptic "pack-objects died" error.
          const sshArgs = [
            "-T",
            ...this.buildSSHArgs(),
            "-o",
            "ConnectTimeout=15",
            "-o",
            "ServerAliveInterval=5",
            "-o",
            "ServerAliveCountMax=2",
            this.config.host,
          ];
          const command = `cd ${shescape.quote(projectPath)} && git bundle create - --all | ssh ${sshArgs.join(" ")} "cat > ${remoteBundlePath}"`;

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
      },
    });
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
    const { projectPath, branchName, trunkBranch, workspacePath, initLogger, abortSignal, env } =
      params;

    try {
      // If the workspace directory already exists and contains a git repo (e.g. forked from
      // another SSH workspace), skip the expensive local→remote sync step.
      const workspacePathArg = expandTildeForSSH(workspacePath);
      let shouldSync = true;

      try {
        const dirCheck = await execBuffered(this, `test -d ${workspacePathArg}`, {
          cwd: "/tmp",
          timeout: 10,
          abortSignal,
        });
        if (dirCheck.exitCode === 0) {
          const gitCheck = await execBuffered(
            this,
            `git -C ${workspacePathArg} rev-parse --is-inside-work-tree`,
            {
              cwd: "/tmp",
              timeout: 20,
              abortSignal,
            }
          );
          shouldSync = gitCheck.exitCode !== 0;
        }
      } catch {
        // Default to syncing on unexpected errors.
        shouldSync = true;
      }

      if (shouldSync) {
        // 1. Sync project to remote with retry for transient SSH failures
        // Errors like "pack-objects died" occur when SSH drops mid-transfer
        initLogger.logStep("Syncing project files to remote...");
        const maxSyncAttempts = 3;
        for (let attempt = 1; attempt <= maxSyncAttempts; attempt++) {
          try {
            await this.syncProjectToRemote(projectPath, workspacePath, initLogger, abortSignal);
            break;
          } catch (error) {
            const errorMsg = getErrorMessage(error);
            const isRetryable =
              errorMsg.includes("pack-objects died") ||
              errorMsg.includes("Connection reset") ||
              errorMsg.includes("Connection closed") ||
              errorMsg.includes("Broken pipe");

            if (!isRetryable || attempt === maxSyncAttempts) {
              initLogger.logStderr(`Failed to sync project: ${errorMsg}`);
              initLogger.logComplete(-1);
              return {
                success: false,
                error: `Failed to sync project: ${errorMsg}`,
              };
            }

            // Clean up partial remote state before retry
            log.info(
              `Sync failed (attempt ${attempt}/${maxSyncAttempts}), will retry: ${errorMsg}`
            );
            try {
              const rmStream = await this.exec(`rm -rf ${workspacePathArg}`, {
                cwd: "~",
                timeout: 30,
              });
              await rmStream.exitCode;
            } catch {
              // Ignore cleanup errors
            }

            initLogger.logStep(
              `Sync failed, retrying (attempt ${attempt + 1}/${maxSyncAttempts})...`
            );
            await new Promise((r) => setTimeout(r, attempt * 1000));
          }
        }
        initLogger.logStep("Files synced successfully");
      } else {
        initLogger.logStep("Remote workspace already contains a git repo; skipping sync");
      }

      // 2. Fetch latest from origin before checkout (best-effort)
      // This ensures new branches start from the latest origin state, not a stale bundle
      const fetchedOrigin = await this.fetchOriginTrunk(
        workspacePath,
        trunkBranch,
        initLogger,
        abortSignal
      );

      // Determine best base for new branches: use origin if local can fast-forward to it,
      // otherwise preserve local state (user may have unpushed work)
      const shouldUseOrigin =
        fetchedOrigin &&
        (await this.canFastForwardToOrigin(workspacePath, trunkBranch, initLogger, abortSignal));

      // 3. Checkout branch remotely
      // If branch exists locally, check it out; otherwise create it from origin (if fetched) or local trunk
      initLogger.logStep(`Checking out branch: ${branchName}`);

      // Try to checkout existing branch, or create new branch from the best available base:
      // - origin/<trunk> if local is behind/equal (ensures fresh starting point)
      // - local <trunk> if local is ahead/diverged (preserves user's work)
      const newBranchBase = shouldUseOrigin ? `origin/${trunkBranch}` : trunkBranch;
      const checkoutCmd = `git checkout ${shescape.quote(branchName)} 2>/dev/null || git checkout -b ${shescape.quote(branchName)} ${shescape.quote(newBranchBase)}`;

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

      // 4. For existing branches, fast-forward to latest origin (best-effort)
      // Only if local can fast-forward (preserves unpushed work)
      if (shouldUseOrigin) {
        await this.fastForwardToOrigin(workspacePath, trunkBranch, initLogger, abortSignal);
      }

      // 5. Run .mux/init hook if it exists
      // Note: runInitHookOnRuntime calls logComplete() internally
      const hookExists = await checkInitHookExists(projectPath);
      if (hookExists) {
        const muxEnv = { ...env, ...getMuxEnv(projectPath, "ssh", branchName) };
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
   * Fetch trunk branch from origin before checkout.
   * Returns true if fetch succeeded (origin is available for branching).
   */
  private async fetchOriginTrunk(
    workspacePath: string,
    trunkBranch: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<boolean> {
    try {
      initLogger.logStep(`Fetching latest from origin/${trunkBranch}...`);

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
        return false;
      }

      initLogger.logStep("Fetched latest from origin");
      return true;
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      initLogger.logStderr(
        `Note: Could not fetch from origin (${errorMsg}), using local branch state`
      );
      return false;
    }
  }

  /**
   * Check if local trunk can fast-forward to origin/<trunk>.
   * Returns true if local is behind or equal to origin (safe to use origin).
   * Returns false if local is ahead or diverged (preserve local state).
   */
  private async canFastForwardToOrigin(
    workspacePath: string,
    trunkBranch: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<boolean> {
    try {
      // Check if local trunk is an ancestor of origin/trunk
      // Exit code 0 = local is ancestor (can fast-forward), non-zero = cannot
      const checkCmd = `git merge-base --is-ancestor ${shescape.quote(trunkBranch)} origin/${shescape.quote(trunkBranch)}`;
      const checkStream = await this.exec(checkCmd, {
        cwd: workspacePath,
        timeout: 30,
        abortSignal,
      });

      const exitCode = await checkStream.exitCode;
      if (exitCode === 0) {
        return true; // Local is behind or equal to origin
      }

      // Local is ahead or diverged - preserve local state
      initLogger.logStderr(
        `Note: Local ${trunkBranch} is ahead of or diverged from origin, using local state`
      );
      return false;
    } catch {
      // Error checking - assume we should preserve local state
      return false;
    }
  }

  /**
   * Fast-forward merge to latest origin/<trunkBranch> after checkout.
   * Best-effort operation for existing branches that may be behind origin.
   */
  private async fastForwardToOrigin(
    workspacePath: string,
    trunkBranch: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<void> {
    try {
      initLogger.logStep("Fast-forward merging...");

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
      initLogger.logStderr(`Note: Fast-forward failed (${errorMsg}), using local branch state`);
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

  async forkWorkspace(params: WorkspaceForkParams): Promise<WorkspaceForkResult> {
    const { projectPath, sourceWorkspaceName, newWorkspaceName, initLogger } = params;

    // Compute workspace paths using canonical method
    const sourceWorkspacePath = this.getWorkspacePath(projectPath, sourceWorkspaceName);
    const newWorkspacePath = this.getWorkspacePath(projectPath, newWorkspaceName);

    // For SSH commands, tilde must be expanded using $HOME - plain quoting won't expand it.
    const sourceWorkspacePathArg = expandTildeForSSH(sourceWorkspacePath);
    const newWorkspacePathArg = expandTildeForSSH(newWorkspacePath);

    try {
      // Guard: avoid clobbering an existing directory.
      {
        const exists = await execBuffered(this, `test -e ${newWorkspacePathArg}`, {
          cwd: "/tmp",
          timeout: 10,
        });
        if (exists.exitCode === 0) {
          return { success: false, error: `Workspace already exists at ${newWorkspacePath}` };
        }
      }

      // Detect current branch from the source workspace.
      initLogger.logStep("Detecting source workspace branch...");
      const branchResult = await execBuffered(
        this,
        `git -C ${sourceWorkspacePathArg} branch --show-current`,
        {
          cwd: "/tmp",
          timeout: 30,
        }
      );
      const sourceBranch = branchResult.stdout.trim();

      if (branchResult.exitCode !== 0 || sourceBranch.length === 0) {
        return {
          success: false,
          error: "Failed to detect branch in source workspace",
        };
      }

      // Ensure parent directory exists.
      initLogger.logStep("Preparing remote workspace...");
      const parentDir = path.posix.dirname(newWorkspacePath);
      const mkdirResult = await execBuffered(this, `mkdir -p ${expandTildeForSSH(parentDir)}`, {
        cwd: "/tmp",
        timeout: 10,
      });
      if (mkdirResult.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to prepare remote workspace: ${mkdirResult.stderr || mkdirResult.stdout}`,
        };
      }

      // Clone the repo from the source workspace on the remote host.
      // NOTE: This intentionally does not attempt to copy uncommitted changes.
      initLogger.logStep("Cloning workspace on remote...");
      const cloneResult = await execBuffered(
        this,
        `git clone --quiet ${sourceWorkspacePathArg} ${newWorkspacePathArg}`,
        {
          cwd: "/tmp",
          timeout: 300,
        }
      );
      if (cloneResult.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to clone workspace: ${cloneResult.stderr || cloneResult.stdout}`,
        };
      }

      // Best-effort: create local tracking branches for all remote branches.
      // This keeps initWorkspace semantics consistent with syncProjectToRemote().
      initLogger.logStep("Creating local tracking branches...");
      try {
        await execBuffered(
          this,
          `cd ${newWorkspacePathArg} && for branch in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin/ | grep -v 'origin/HEAD'); do localname=\${branch#origin/}; git show-ref --verify --quiet refs/heads/$localname || git branch $localname $branch; done`,
          {
            cwd: "/tmp",
            timeout: 30,
          }
        );
      } catch {
        // Ignore - best-effort.
      }

      // Best-effort: preserve the origin URL from the source workspace, if one exists.
      try {
        const originResult = await execBuffered(
          this,
          `git -C ${sourceWorkspacePathArg} remote get-url origin 2>/dev/null || true`,
          {
            cwd: "/tmp",
            timeout: 10,
          }
        );
        const originUrl = originResult.stdout.trim();
        if (originUrl.length > 0) {
          await execBuffered(
            this,
            `git -C ${newWorkspacePathArg} remote set-url origin ${shescape.quote(originUrl)}`,
            {
              cwd: "/tmp",
              timeout: 10,
            }
          );
        } else {
          await execBuffered(
            this,
            `git -C ${newWorkspacePathArg} remote remove origin 2>/dev/null || true`,
            {
              cwd: "/tmp",
              timeout: 10,
            }
          );
        }
      } catch {
        // Ignore - best-effort.
      }

      // Checkout the destination branch, creating it from sourceBranch if needed.
      initLogger.logStep(`Checking out branch: ${newWorkspaceName}`);
      const checkoutCmd =
        `git checkout ${shescape.quote(newWorkspaceName)} 2>/dev/null || ` +
        `git checkout -b ${shescape.quote(newWorkspaceName)} ${shescape.quote(sourceBranch)}`;
      const checkoutResult = await execBuffered(this, checkoutCmd, {
        cwd: newWorkspacePath,
        timeout: 120,
      });
      if (checkoutResult.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to checkout forked branch: ${checkoutResult.stderr || checkoutResult.stdout}`,
        };
      }

      return { success: true, workspacePath: newWorkspacePath, sourceBranch };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  }
}
