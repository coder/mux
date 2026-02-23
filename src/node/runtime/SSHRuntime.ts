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

import { spawn, type ChildProcess } from "child_process";
import * as path from "path";
import type {
  EnsureReadyOptions,
  EnsureReadyResult,
  ExecOptions,
  WorkspaceCreationParams,
  WorkspaceCreationResult,
  WorkspaceInitParams,
  WorkspaceInitResult,
  WorkspaceForkParams,
  WorkspaceForkResult,
  InitLogger,
} from "./Runtime";
import { WORKSPACE_REPO_MISSING_ERROR } from "./Runtime";
import { RemoteRuntime, type SpawnResult } from "./RemoteRuntime";
import { log } from "@/node/services/log";
import { checkInitHookExists, getMuxEnv, runInitHookOnRuntime } from "./initHook";
import { expandTildeForSSH as expandHookPath } from "./tildeExpansion";

import { expandTildeForSSH, cdCommandForSSH } from "./tildeExpansion";
import { getProjectName, execBuffered } from "@/node/utils/runtime/helpers";
import { getErrorMessage } from "@/common/utils/errors";
import { type SSHRuntimeConfig } from "./sshConnectionPool";
import { getOriginUrlForBundle } from "./gitBundleSync";
import type { PtyHandle, PtySessionParams, SSHTransport } from "./transports";
import { streamToString, shescape } from "./streamUtils";

/** Name of the shared bare repo directory under each project on the remote. */
const BASE_REPO_DIR = ".mux-base.git";

/** Staging namespace for bundle-imported branch refs. Branches land here instead
 *  of refs/heads/* so they don't collide with branches checked out in worktrees. */
const BUNDLE_REF_PREFIX = "refs/mux-bundle/";

function logSSHBackoffWait(initLogger: InitLogger, waitMs: number): void {
  const secs = Math.max(1, Math.ceil(waitMs / 1000));
  initLogger.logStep(`SSH unavailable; retrying in ${secs}s...`);
}

async function pipeReadableToWebWritable(
  readable: NodeJS.ReadableStream | null | undefined,
  writable: WritableStream<Uint8Array>,
  abortSignal?: AbortSignal
): Promise<void> {
  if (!readable) {
    throw new Error("Missing git bundle output stream");
  }

  const writer = writable.getWriter();
  try {
    for await (const chunk of readable) {
      if (abortSignal?.aborted) {
        throw new Error("Bundle creation aborted");
      }
      const data =
        typeof chunk === "string"
          ? Buffer.from(chunk)
          : chunk instanceof Uint8Array
            ? chunk
            : Buffer.from(chunk);
      await writer.write(data);
    }
    await writer.close();
  } catch (error) {
    try {
      await writer.abort(error);
    } catch {
      writer.releaseLock();
    }
    throw error;
  }
}

function createAbortController(
  timeoutMs: number | undefined,
  abortSignal?: AbortSignal
): { signal: AbortSignal; dispose: () => void; didTimeout: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;

  const onAbort = () => controller.abort();
  if (abortSignal) {
    if (abortSignal.aborted) {
      controller.abort();
    } else {
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const timeoutHandle =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      abortSignal?.removeEventListener("abort", onAbort);
    },
  };
}
async function waitForProcessExit(proc: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    proc.on("close", (code) => resolve(code ?? 0));
    proc.on("error", (err) => reject(err));
  });
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
 * Compute the path to the shared bare base repo for a project on the remote.
 * Convention: <srcBaseDir>/<projectName>/.mux-base.git
 *
 * Exported for unit testing; runtime code should use the private
 * `SSHRuntime.getBaseRepoPath()` method instead.
 */
export function computeBaseRepoPath(srcBaseDir: string, projectPath: string): string {
  const projectName = getProjectName(projectPath);
  return path.posix.join(srcBaseDir, projectName, BASE_REPO_DIR);
}

/**
 * SSH runtime implementation that executes commands and file operations
 * over SSH using the ssh command-line tool.
 *
 * Extends RemoteRuntime for shared exec/file operations.
 */
export class SSHRuntime extends RemoteRuntime {
  private readonly config: SSHRuntimeConfig;
  private readonly transport: SSHTransport;
  private readonly ensureReadyProjectPath?: string;
  private readonly ensureReadyWorkspaceName?: string;
  /** Cached resolved bgOutputDir (tilde expanded to absolute path) */
  private resolvedBgOutputDir: string | null = null;

  constructor(
    config: SSHRuntimeConfig,
    transport: SSHTransport,
    options?: {
      projectPath?: string;
      workspaceName?: string;
    }
  ) {
    super();
    // Note: srcBaseDir may contain tildes - they will be resolved via resolvePath() before use
    // The WORKSPACE_CREATE IPC handler resolves paths before storing in config
    this.config = config;
    this.transport = transport;
    this.ensureReadyProjectPath = options?.projectPath;
    this.ensureReadyWorkspaceName = options?.workspaceName;
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

  /** Create a PTY session using the underlying transport. */
  public createPtySession(params: PtySessionParams): Promise<PtyHandle> {
    return this.transport.createPtySession(params);
  }

  /** Get SSH configuration (for PTY terminal spawning). */
  public getConfig(): SSHRuntimeConfig {
    return this.config;
  }

  // ===== RemoteRuntime abstract method implementations =====

  protected readonly commandPrefix: string = "SSH";

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
    // Connection-level failures should inform transport backoff. The meaning of
    // specific exit codes (like 255) is transport-dependent.
    if (this.transport.isConnectionFailure(exitCode, stderr)) {
      this.transport.reportFailure(truncateSSHError(stderr));
    } else {
      this.transport.markHealthy();
    }
  }

  protected async spawnRemoteProcess(
    fullCommand: string,
    options: ExecOptions
  ): Promise<SpawnResult> {
    return this.transport.spawnRemoteProcess(fullCommand, {
      forcePTY: options.forcePTY,
      timeout: options.timeout,
      abortSignal: options.abortSignal,
    });
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

    // Wait for connection establishment (including host-key confirmation) before
    // starting the 10s command timeout. Otherwise users who take >10s to accept
    // the host key prompt will hit a false timeout immediately after acceptance.
    const resolvePathTimeoutMs = 10_000;

    await this.transport.acquireConnection({
      timeoutMs: resolvePathTimeoutMs,
      maxWaitMs: resolvePathTimeoutMs,
    });

    const abortController = createAbortController(resolvePathTimeoutMs);
    try {
      const result = await execBuffered(this, command, {
        cwd: "/tmp",
        abortSignal: abortController.signal,
      });

      if (abortController.didTimeout()) {
        throw new Error(`SSH command timed out after 10000ms: ${command}`);
      }

      if (result.exitCode !== 0) {
        const message = result.stderr || result.stdout || "Unknown error";
        throw new Error(`Failed to resolve SSH path: ${message}`);
      }

      return result.stdout.trim();
    } finally {
      abortController.dispose();
    }
  }

  getWorkspacePath(projectPath: string, workspaceName: string): string {
    const projectName = getProjectName(projectPath);
    return path.posix.join(this.config.srcBaseDir, projectName, workspaceName);
  }

  /**
   * Path to the shared bare repo for a project on the remote.
   * All worktree-based workspaces share this object store.
   */
  private getBaseRepoPath(projectPath: string): string {
    return computeBaseRepoPath(this.config.srcBaseDir, projectPath);
  }

  /**
   * Ensure the shared bare repo exists on the remote for a project.
   * Creates it lazily on first use. Returns the shell-expanded path arg
   * for use in subsequent commands.
   */
  private async ensureBaseRepo(
    projectPath: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<string> {
    const baseRepoPath = this.getBaseRepoPath(projectPath);
    const baseRepoPathArg = expandTildeForSSH(baseRepoPath);

    const check = await execBuffered(this, `test -d ${baseRepoPathArg}`, {
      cwd: "/tmp",
      timeout: 10,
      abortSignal,
    });

    if (check.exitCode !== 0) {
      initLogger.logStep("Creating shared base repository...");
      const parentDir = path.posix.dirname(baseRepoPath);
      await execBuffered(this, `mkdir -p ${expandTildeForSSH(parentDir)}`, {
        cwd: "/tmp",
        timeout: 10,
        abortSignal,
      });
      const initResult = await execBuffered(this, `git init --bare ${baseRepoPathArg}`, {
        cwd: "/tmp",
        timeout: 30,
        abortSignal,
      });
      if (initResult.exitCode !== 0) {
        throw new Error(`Failed to create base repo: ${initResult.stderr || initResult.stdout}`);
      }
    }

    return baseRepoPathArg;
  }

  /**
   * Detect whether a remote workspace is a git worktree (`.git` is a file)
   * vs a legacy full clone (`.git` is a directory).
   */
  private async isWorktreeWorkspace(
    workspacePath: string,
    abortSignal?: AbortSignal
  ): Promise<boolean> {
    const gitPath = path.posix.join(workspacePath, ".git");
    const result = await execBuffered(this, `test -f ${this.quoteForRemote(gitPath)}`, {
      cwd: "/tmp",
      timeout: 10,
      abortSignal,
    });
    return result.exitCode === 0;
  }

  /**
   * Resolve the bundle staging ref for the trunk branch.
   * Returns refs/mux-bundle/<trunkBranch> if it exists, otherwise falls back
   * to the first available ref under refs/mux-bundle/ (handles main vs master
   * mismatches). Returns null if no bundle refs exist.
   */
  private async resolveBundleTrunkRef(
    baseRepoPathArg: string,
    trunkBranch: string,
    abortSignal?: AbortSignal
  ): Promise<string | null> {
    // Preferred: exact match for the expected trunk branch.
    const preferredRef = `${BUNDLE_REF_PREFIX}${trunkBranch}`;
    const check = await execBuffered(
      this,
      `git -C ${baseRepoPathArg} rev-parse --verify ${shescape.quote(preferredRef)}`,
      { cwd: "/tmp", timeout: 10, abortSignal }
    );
    if (check.exitCode === 0) {
      return preferredRef;
    }

    // Fallback: pick the first ref under refs/mux-bundle/ (handles main↔master mismatch).
    const listResult = await execBuffered(
      this,
      `git -C ${baseRepoPathArg} for-each-ref --format='%(refname)' ${BUNDLE_REF_PREFIX} --count=1`,
      { cwd: "/tmp", timeout: 10, abortSignal }
    );
    const fallbackRef = listResult.stdout.trim();
    if (listResult.exitCode === 0 && fallbackRef.length > 0) {
      log.info(`Bundle trunk ref mismatch: expected ${preferredRef}, using ${fallbackRef}`);
      return fallbackRef;
    }

    return null;
  }

  override async ensureReady(options?: EnsureReadyOptions): Promise<EnsureReadyResult> {
    const repoCheck = await this.checkWorkspaceRepo(options);
    if (repoCheck) {
      if (!repoCheck.ready) {
        options?.statusSink?.({
          phase: "error",
          runtimeType: "ssh",
          detail: repoCheck.error,
        });
        return repoCheck;
      }

      options?.statusSink?.({ phase: "ready", runtimeType: "ssh" });
      return { ready: true };
    }

    return { ready: true };
  }

  protected async checkWorkspaceRepo(
    options?: EnsureReadyOptions
  ): Promise<EnsureReadyResult | null> {
    if (!this.ensureReadyProjectPath || !this.ensureReadyWorkspaceName) {
      return null;
    }

    const statusSink = options?.statusSink;
    statusSink?.({
      phase: "checking",
      runtimeType: "ssh",
      detail: "Checking repository...",
    });

    if (options?.signal?.aborted) {
      return { ready: false, error: "Aborted", errorType: "runtime_start_failed" };
    }

    const workspacePath = this.getWorkspacePath(
      this.ensureReadyProjectPath,
      this.ensureReadyWorkspaceName
    );
    const gitDir = path.posix.join(workspacePath, ".git");
    const gitDirProbe = this.quoteForRemote(gitDir);

    let testResult: { exitCode: number; stderr: string };
    try {
      // .git is a file for worktrees; accept either file or directory so existing SSH/Coder
      // worktree checkouts don't get flagged as setup failures.
      testResult = await execBuffered(this, `test -d ${gitDirProbe} || test -f ${gitDirProbe}`, {
        cwd: "~",
        timeout: 10,
        abortSignal: options?.signal,
      });
    } catch (error) {
      return {
        ready: false,
        error: `Failed to reach SSH host: ${getErrorMessage(error)}`,
        errorType: "runtime_start_failed",
      };
    }

    if (testResult.exitCode !== 0) {
      if (this.transport.isConnectionFailure(testResult.exitCode, testResult.stderr)) {
        return {
          ready: false,
          error: `Failed to reach SSH host: ${testResult.stderr || "connection failure"}`,
          errorType: "runtime_start_failed",
        };
      }

      return {
        ready: false,
        error: WORKSPACE_REPO_MISSING_ERROR,
        errorType: "runtime_not_ready",
      };
    }

    let revResult: { exitCode: number; stderr: string; stdout: string };
    try {
      revResult = await execBuffered(
        this,
        `git -C ${this.quoteForRemote(workspacePath)} rev-parse --git-dir`,
        {
          cwd: "~",
          timeout: 10,
          abortSignal: options?.signal,
        }
      );
    } catch (error) {
      return {
        ready: false,
        error: `Failed to verify repository: ${getErrorMessage(error)}`,
        errorType: "runtime_start_failed",
      };
    }

    if (revResult.exitCode !== 0) {
      const stderr = revResult.stderr.trim();
      const stdout = revResult.stdout.trim();
      const errorDetail = stderr || stdout || "git unavailable";
      const isCommandMissing =
        revResult.exitCode === 127 || /command not found/i.test(stderr || stdout);
      if (
        isCommandMissing ||
        this.transport.isConnectionFailure(revResult.exitCode, revResult.stderr)
      ) {
        return {
          ready: false,
          error: `Failed to verify repository: ${errorDetail}`,
          errorType: "runtime_start_failed",
        };
      }

      return {
        ready: false,
        error: WORKSPACE_REPO_MISSING_ERROR,
        errorType: "runtime_not_ready",
      };
    }

    return { ready: true };
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
  /**
   * Transfer a git bundle to the remote and return its path.
   * Callers are responsible for cleanup of the remote bundle file.
   */
  private async transferBundleToRemote(
    projectPath: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<string> {
    const timestamp = Date.now();
    const remoteBundlePath = `~/.mux-bundle-${timestamp}.bundle`;

    await this.transport.acquireConnection({
      abortSignal,
      onWait: (waitMs) => logSSHBackoffWait(initLogger, waitMs),
    });

    if (abortSignal?.aborted) {
      throw new Error("Bundle creation aborted");
    }

    initLogger.logStep("Creating git bundle...");
    // Use --branches --tags instead of --all to exclude refs/remotes/origin/*
    // from the bundle. Those tracking refs are from the local machine's last
    // fetch and can be arbitrarily stale — importing them into the shared bare
    // base repo would give worktrees a wrong "commits behind" count.
    const gitProc = spawn(
      "git",
      ["-C", projectPath, "bundle", "create", "-", "--branches", "--tags"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }
    );

    // Handle stderr manually - do NOT use streamProcessToLogger here.
    // It attaches a stdout listener that drains data before pipeReadableToWebWritable
    // can consume it, corrupting the bundle.
    let stderr = "";
    gitProc.stderr?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      for (const line of chunk.split("\n").filter(Boolean)) {
        initLogger.logStderr(line);
      }
    });

    const remoteAbortController = createAbortController(300_000, abortSignal);
    const remoteStream = await this.exec(`cat > ${this.quoteForRemote(remoteBundlePath)}`, {
      cwd: "~",
      abortSignal: remoteAbortController.signal,
    });

    try {
      try {
        await pipeReadableToWebWritable(gitProc.stdout, remoteStream.stdin, abortSignal);
      } catch (error) {
        gitProc.kill();
        throw error;
      }

      const [gitExitCode, remoteExitCode] = await Promise.all([
        waitForProcessExit(gitProc),
        remoteStream.exitCode,
      ]);

      if (remoteAbortController.didTimeout()) {
        throw new Error(
          `SSH command timed out after 300000ms: cat > ${this.quoteForRemote(remoteBundlePath)}`
        );
      }

      if (abortSignal?.aborted) {
        throw new Error("Bundle creation aborted");
      }

      if (gitExitCode !== 0) {
        throw new Error(`Failed to create bundle: ${stderr}`);
      }

      if (remoteExitCode !== 0) {
        const remoteStderr = await streamToString(remoteStream.stderr);
        throw new Error(`Failed to upload bundle: ${remoteStderr}`);
      }
    } finally {
      remoteAbortController.dispose();
    }

    return remoteBundlePath;
  }

  /**
   * Sync local project to the shared bare base repo on the remote via git bundle.
   *
   * Branches land in a staging namespace (refs/mux-bundle/*) to avoid colliding
   * with branches checked out in existing worktrees. Tags go to refs/tags/*
   * directly. Remote tracking refs are excluded entirely.
   * Idempotent — re-running is a no-op when nothing changed.
   */
  protected async syncProjectToRemote(
    projectPath: string,
    _workspacePath: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const baseRepoPathArg = await this.ensureBaseRepo(projectPath, initLogger, abortSignal);

    const remoteBundlePath = await this.transferBundleToRemote(
      projectPath,
      initLogger,
      abortSignal
    );
    const remoteBundlePathArg = this.quoteForRemote(remoteBundlePath);

    try {
      // Import branches and tags from the bundle into the shared bare repo.
      // Branches land in refs/mux-bundle/* (staging namespace) instead of
      // refs/heads/* to avoid colliding with branches checked out in existing
      // worktrees — git refuses to update any ref checked out in a worktree.
      // Tags go directly to refs/tags/* (they're never checked out).
      initLogger.logStep("Importing bundle into shared base repository...");
      const fetchResult = await execBuffered(
        this,
        `git -C ${baseRepoPathArg} fetch ${remoteBundlePathArg} '+refs/heads/*:${BUNDLE_REF_PREFIX}*' '+refs/tags/*:refs/tags/*'`,
        { cwd: "/tmp", timeout: 300, abortSignal }
      );
      if (fetchResult.exitCode !== 0) {
        throw new Error(
          `Failed to import bundle into base repo: ${fetchResult.stderr || fetchResult.stdout}`
        );
      }

      // Set the origin remote on the bare repo so worktrees inherit it.
      const { originUrl } = await this.getOriginUrlForSync(projectPath, initLogger);
      if (originUrl) {
        initLogger.logStep(`Setting origin remote to ${originUrl}...`);
        // Use add-or-update pattern: try set-url first, fall back to add.
        await execBuffered(
          this,
          `git -C ${baseRepoPathArg} remote set-url origin ${shescape.quote(originUrl)} 2>/dev/null || git -C ${baseRepoPathArg} remote add origin ${shescape.quote(originUrl)}`,
          { cwd: "/tmp", timeout: 10, abortSignal }
        );
      }

      initLogger.logStep("Repository synced to base successfully");
    } finally {
      // Best-effort cleanup of the remote bundle file.
      try {
        await execBuffered(this, `rm -f ${remoteBundlePathArg}`, {
          cwd: "/tmp",
          timeout: 10,
        });
      } catch {
        // Ignore cleanup errors.
      }
    }
  }

  /** Get origin URL from local project for setting on the remote base repo. */
  private async getOriginUrlForSync(
    projectPath: string,
    initLogger: InitLogger
  ): Promise<{ originUrl: string | null }> {
    return getOriginUrlForBundle(projectPath, initLogger, /* logErrors */ false);
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
    const {
      projectPath,
      branchName,
      trunkBranch,
      workspacePath,
      initLogger,
      abortSignal,
      env,
      skipInitHook,
    } = params;

    try {
      // If the workspace directory already exists and contains a git repo (e.g. forked from
      // another SSH workspace via worktree add or legacy cp), skip the expensive sync step.
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
        // 1. Sync project to the shared bare base repo with retry for transient SSH failures.
        // Errors like "pack-objects died" occur when SSH drops mid-transfer.
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
              errorMsg.includes("Broken pipe") ||
              errorMsg.includes("EPIPE");

            if (!isRetryable || attempt === maxSyncAttempts) {
              initLogger.logStderr(`Failed to sync project: ${errorMsg}`);
              initLogger.logComplete(-1);
              return {
                success: false,
                error: `Failed to sync project: ${errorMsg}`,
              };
            }

            log.info(
              `Sync failed (attempt ${attempt}/${maxSyncAttempts}), will retry: ${errorMsg}`
            );

            initLogger.logStep(
              `Sync failed, retrying (attempt ${attempt + 1}/${maxSyncAttempts})...`
            );
            await new Promise((r) => setTimeout(r, attempt * 1000));
          }
        }
        initLogger.logStep("Files synced successfully");

        // 2. Create a worktree from the shared bare base repo for this workspace.
        const baseRepoPath = this.getBaseRepoPath(projectPath);
        const baseRepoPathArg = expandTildeForSSH(baseRepoPath);

        // Fetch latest from origin in the base repo (best-effort) so new branches
        // can start from the latest upstream state.
        const fetchedOrigin = await this.fetchOriginTrunk(
          baseRepoPath,
          trunkBranch,
          initLogger,
          abortSignal
        );

        // Resolve the bundle's staging ref to use as the local fallback start
        // point. The staging ref is refs/mux-bundle/<trunk> — but the local
        // project's default branch may differ from what was passed as trunkBranch
        // (e.g. "master" vs "main"), so probe for the expected ref and fall back
        // to whatever is available in refs/mux-bundle/.
        const bundleTrunkRef = await this.resolveBundleTrunkRef(
          baseRepoPathArg,
          trunkBranch,
          abortSignal
        );

        const shouldUseOrigin =
          fetchedOrigin &&
          bundleTrunkRef != null &&
          (await this.canFastForwardToOrigin(
            baseRepoPath,
            bundleTrunkRef,
            trunkBranch,
            initLogger,
            abortSignal
          ));

        // When origin is reachable, branch from the fresh remote tracking ref.
        // Otherwise, use the bundle's staging ref (or HEAD as last resort).
        const newBranchBase = shouldUseOrigin
          ? `origin/${trunkBranch}`
          : (bundleTrunkRef ?? "HEAD");

        // git worktree add creates the directory and checks out the branch in one step.
        // -B creates the branch or resets it to the start point if it already exists
        // (e.g. orphaned from a previously deleted workspace). Git still prevents
        // checking out a branch that's active in another worktree.
        initLogger.logStep(`Creating worktree for branch: ${branchName}`);
        const worktreeCmd = `git -C ${baseRepoPathArg} worktree add ${workspacePathArg} -B ${shescape.quote(branchName)} ${shescape.quote(newBranchBase)}`;

        const worktreeResult = await execBuffered(this, worktreeCmd, {
          cwd: "/tmp",
          timeout: 300,
          abortSignal,
        });

        if (worktreeResult.exitCode !== 0) {
          const errorMsg = `Failed to create worktree: ${worktreeResult.stderr || worktreeResult.stdout}`;
          initLogger.logStderr(errorMsg);
          initLogger.logComplete(-1);
          return { success: false, error: errorMsg };
        }
        initLogger.logStep("Worktree created successfully");
      } else {
        initLogger.logStep("Remote workspace already contains a git repo; skipping sync");

        // Existing workspace (e.g. forked): fetch origin and checkout as before.
        const fetchedOrigin = await this.fetchOriginTrunk(
          workspacePath,
          trunkBranch,
          initLogger,
          abortSignal
        );
        const shouldUseOrigin =
          fetchedOrigin &&
          (await this.canFastForwardToOrigin(
            workspacePath,
            trunkBranch,
            trunkBranch,
            initLogger,
            abortSignal
          ));

        if (shouldUseOrigin) {
          await this.fastForwardToOrigin(workspacePath, trunkBranch, initLogger, abortSignal);
        }
      }

      // 3. Run .mux/init hook if it exists
      // Note: runInitHookOnRuntime calls logComplete() internally
      if (skipInitHook) {
        initLogger.logStep("Skipping .mux/init hook (disabled for this task)");
        initLogger.logComplete(0);
      } else {
        const hookExists = await checkInitHookExists(projectPath);
        if (hookExists) {
          initLogger.enterHookPhase?.();
          const muxEnv = { ...env, ...getMuxEnv(projectPath, "ssh", branchName) };
          // Expand tilde in hook path (quoted paths don't auto-expand on remote)
          const hookPath = expandHookPath(`${workspacePath}/.mux/init`);
          await runInitHookOnRuntime(
            this,
            hookPath,
            workspacePath,
            muxEnv,
            initLogger,
            abortSignal
          );
        } else {
          // No hook - signal completion immediately
          initLogger.logComplete(0);
        }
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
        // Branch doesn't exist on origin (common for subagent local-only branches)
        if (fetchStderr.includes("couldn't find remote ref")) {
          initLogger.logStep(`Branch "${trunkBranch}" not found on origin; using local state.`);
        } else {
          initLogger.logStderr(
            `Note: Could not fetch from origin (${fetchStderr}), using local branch state`
          );
        }
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
   * Check if a local ref can fast-forward to origin/<originBranch>.
   * Returns true if localRef is behind or equal to origin (safe to use origin).
   * Returns false if localRef is ahead or diverged (preserve local state).
   *
   * @param localRef - The ref to compare (e.g. "main" or "refs/mux-bundle/main")
   * @param originBranch - The branch name on origin (e.g. "main")
   */
  private async canFastForwardToOrigin(
    workspacePath: string,
    localRef: string,
    originBranch: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<boolean> {
    try {
      // Check if localRef is an ancestor of origin/<originBranch>
      // Exit code 0 = local is ancestor (can fast-forward), non-zero = cannot
      const checkCmd = `git merge-base --is-ancestor ${shescape.quote(localRef)} origin/${shescape.quote(originBranch)}`;
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
        `Note: Local ${localRef} is ahead of or diverged from origin/${originBranch}, using local state`
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
      const expandedOldPath = expandTildeForSSH(oldPath);
      const expandedNewPath = expandTildeForSSH(newPath);

      // Detect if workspace is a worktree vs legacy full clone.
      const isWorktree = await this.isWorktreeWorkspace(oldPath, abortSignal);

      let moveCommand: string;
      if (isWorktree) {
        // Worktree: use `git worktree move` to keep base repo metadata consistent.
        const baseRepoPathArg = expandTildeForSSH(this.getBaseRepoPath(projectPath));
        moveCommand = `git -C ${baseRepoPathArg} worktree move ${expandedOldPath} ${expandedNewPath}`;
      } else {
        // Legacy full clone: plain mv.
        moveCommand = `mv ${expandedOldPath} ${expandedNewPath}`;
      }

      const stream = await this.exec(moveCommand, {
        cwd: this.config.srcBaseDir,
        timeout: 30,
        abortSignal,
      });

      await stream.stdin.abort();
      const exitCode = await stream.exitCode;

      if (exitCode !== 0) {
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
        // Non-force path includes `git fetch origin` (network op) that can
        // easily exceed 10s on slow SSH connections. Force path only checks
        // existence, so a short timeout is fine.
        timeout: force ? 10 : 30,
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

      // Detect if workspace is a worktree (.git is a file) vs a legacy full clone (.git is a directory).
      const isWorktree = await this.isWorktreeWorkspace(deletedPath, abortSignal);

      if (isWorktree) {
        // Worktree: use `git worktree remove` to clean up the base repo's worktree metadata.
        const baseRepoPathArg = expandTildeForSSH(this.getBaseRepoPath(projectPath));
        const removeCmd = force
          ? `git -C ${baseRepoPathArg} worktree remove --force ${this.quoteForRemote(deletedPath)}`
          : `git -C ${baseRepoPathArg} worktree remove ${this.quoteForRemote(deletedPath)}`;
        const stream = await this.exec(removeCmd, {
          cwd: this.config.srcBaseDir,
          timeout: 30,
          abortSignal,
        });
        await stream.stdin.abort();
        const exitCode = await stream.exitCode;

        if (exitCode !== 0) {
          const stderr = await streamToString(stream.stderr);
          // Fallback: if worktree remove fails (e.g., locked), rm -rf + prune.
          const fallbackStream = await this.exec(
            // Use quoteForRemote (expandTildeForSSH) to match the quoting in the
            // worktree remove command above — shescape.quote doesn't expand tilde.
            // `worktree prune` is best-effort: if the base repo was externally
            // deleted/corrupted the prune fails, but the workspace IS gone after
            // rm -rf — don't report failure for a cosmetic prune error.
            `rm -rf ${this.quoteForRemote(deletedPath)} && (git -C ${baseRepoPathArg} worktree prune 2>/dev/null || true)`,
            { cwd: this.config.srcBaseDir, timeout: 30, abortSignal }
          );
          await fallbackStream.stdin.abort();
          const fallbackExitCode = await fallbackStream.exitCode;
          if (fallbackExitCode !== 0) {
            const fallbackStderr = await streamToString(fallbackStream.stderr);
            return {
              success: false,
              error: `Failed to delete worktree: ${stderr.trim() || fallbackStderr.trim() || "Unknown error"}`,
            };
          }
        }
        // Best-effort: delete the orphaned branch ref from the base repo so
        // that re-forking with the same workspace name can use the fast worktree
        // path (git worktree add -b fails if the branch already exists).
        // Skip protected trunk branch names to avoid accidental deletion.
        const PROTECTED_BRANCHES = ["main", "master", "trunk", "develop", "default"];
        if (!PROTECTED_BRANCHES.includes(workspaceName)) {
          await execBuffered(
            this,
            `git -C ${baseRepoPathArg} branch -D ${shescape.quote(workspaceName)} 2>/dev/null || true`,
            { cwd: "/tmp", timeout: 10 }
          ).catch(() => undefined);
        }
      } else {
        // Legacy full clone: rm -rf to remove the directory on the remote host.
        const removeCommand = `rm -rf ${shescape.quote(deletedPath)}`;
        const stream = await this.exec(removeCommand, {
          cwd: this.config.srcBaseDir,
          timeout: 30,
          abortSignal,
        });
        await stream.stdin.abort();
        const exitCode = await stream.exitCode;

        if (exitCode !== 0) {
          const stderr = await streamToString(stream.stderr);
          return {
            success: false,
            error: `Failed to delete directory: ${stderr.trim() || "Unknown error"}`,
          };
        }
      }

      return { success: true, deletedPath };
    } catch (error) {
      return { success: false, error: `Failed to delete directory: ${getErrorMessage(error)}` };
    }
  }

  async forkWorkspace(params: WorkspaceForkParams): Promise<WorkspaceForkResult> {
    const { projectPath, sourceWorkspaceName, newWorkspaceName, initLogger, abortSignal } = params;

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
          abortSignal,
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
          abortSignal,
        }
      );
      const sourceBranch = branchResult.stdout.trim();

      if (branchResult.exitCode !== 0 || sourceBranch.length === 0) {
        return {
          success: false,
          error: "Failed to detect branch in source workspace",
        };
      }

      // Try fast worktree path first when the shared base repo exists.
      // Falls back to full directory copy when the base repo is missing OR when
      // worktree creation fails (e.g. forking a legacy workspace whose branch
      // only exists locally and not in the base repo).
      //
      // Note: worktree-based fork creates a clean checkout from sourceBranch's
      // committed HEAD. Uncommitted working-tree changes from the source are NOT
      // carried over (inherent git worktree limitation). The cp -R -P fallback
      // preserves full working-tree state including uncommitted changes.
      const baseRepoPath = this.getBaseRepoPath(projectPath);
      const baseRepoPathArg = expandTildeForSSH(baseRepoPath);
      let usedWorktree = false;

      const hasBaseRepo = await execBuffered(this, `test -d ${baseRepoPathArg}`, {
        cwd: "/tmp",
        timeout: 10,
        abortSignal,
      });

      if (hasBaseRepo.exitCode === 0) {
        initLogger.logStep("Creating worktree for forked workspace...");
        // Use -b (not -B) so we fail instead of silently resetting an existing
        // branch that another worktree might reference. initWorkspace uses -B
        // because it owns the branch lifecycle; fork is creating a new name.
        const worktreeCmd = `git -C ${baseRepoPathArg} worktree add ${newWorkspacePathArg} -b ${shescape.quote(newWorkspaceName)} ${shescape.quote(sourceBranch)}`;
        const worktreeResult = await execBuffered(this, worktreeCmd, {
          cwd: "/tmp",
          timeout: 60,
          abortSignal,
        });

        if (worktreeResult.exitCode === 0) {
          usedWorktree = true;
        } else {
          // Source branch likely doesn't exist in the base repo (legacy workspace).
          // Clean up any partial directory left by the failed `worktree add`
          // before falling through to cp -R -P (which behaves differently if
          // the target dir already exists — it copies *into* it, creating a
          // nested mess instead of a clean clone).
          await execBuffered(this, `rm -rf ${newWorkspacePathArg}`, {
            cwd: "/tmp",
            timeout: 10,
            // Best-effort cleanup — ignore failures since we're about to fall
            // through to the cp path which will overwrite the target anyway.
          }).catch(() => undefined);
          log.info(
            `Worktree fork failed (${(worktreeResult.stderr || worktreeResult.stdout).trim()}); falling back to full copy`
          );
          initLogger.logStep("Worktree creation failed; falling back to full copy...");
        }
      }

      if (!usedWorktree) {
        // Full directory copy — either no base repo or worktree creation failed.
        initLogger.logStep("Preparing remote workspace...");
        const parentDir = path.posix.dirname(newWorkspacePath);
        const mkdirResult = await execBuffered(this, `mkdir -p ${expandTildeForSSH(parentDir)}`, {
          cwd: "/tmp",
          timeout: 10,
          abortSignal,
        });
        if (mkdirResult.exitCode !== 0) {
          return {
            success: false,
            error: `Failed to prepare remote workspace: ${mkdirResult.stderr || mkdirResult.stdout}`,
          };
        }

        // Copy the source workspace on the remote host so we preserve working tree state.
        // Avoid preserving ownership to prevent fork failures when files are owned by another user.
        initLogger.logStep("Copying workspace on remote...");
        const copyResult = await execBuffered(
          this,
          `cp -R -P ${sourceWorkspacePathArg} ${newWorkspacePathArg}`,
          { cwd: "/tmp", timeout: 300, abortSignal }
        );
        if (copyResult.exitCode !== 0) {
          try {
            await execBuffered(this, `rm -rf ${newWorkspacePathArg}`, {
              cwd: "/tmp",
              timeout: 30,
            });
          } catch {
            // Best-effort cleanup of partially copied workspace.
          }
          return {
            success: false,
            error: `Failed to copy workspace: ${copyResult.stderr || copyResult.stdout}`,
          };
        }

        // Best-effort: create local tracking branches for all remote branches.
        initLogger.logStep("Creating local tracking branches...");
        try {
          await execBuffered(
            this,
            `cd ${newWorkspacePathArg} && for branch in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin/ | grep -v 'origin/HEAD'); do localname=\${branch#origin/}; git show-ref --verify --quiet refs/heads/$localname || git branch $localname $branch; done`,
            { cwd: "/tmp", timeout: 30 }
          );
        } catch {
          // Ignore - best-effort.
        }

        // Best-effort: preserve the origin URL from the source workspace, if one exists.
        try {
          const originResult = await execBuffered(
            this,
            `git -C ${sourceWorkspacePathArg} remote get-url origin 2>/dev/null || true`,
            { cwd: "/tmp", timeout: 10 }
          );
          const originUrl = originResult.stdout.trim();
          if (originUrl.length > 0) {
            await execBuffered(
              this,
              `git -C ${newWorkspacePathArg} remote set-url origin ${shescape.quote(originUrl)}`,
              { cwd: "/tmp", timeout: 10 }
            );
          } else {
            await execBuffered(
              this,
              `git -C ${newWorkspacePathArg} remote remove origin 2>/dev/null || true`,
              { cwd: "/tmp", timeout: 10 }
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
      }

      return { success: true, workspacePath: newWorkspacePath, sourceBranch };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  }
}
