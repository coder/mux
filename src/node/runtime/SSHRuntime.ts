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
import * as crypto from "crypto";
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
import { runInitHookOnRuntime, runWorkspaceInitHook } from "./initHook";
import { expandTildeForSSH, cdCommandForSSH } from "./tildeExpansion";
import { sleepWithAbort } from "@/node/utils/abort";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { getErrorMessage } from "@/common/utils/errors";
import {
  type SSHRuntimeConfig,
  getControlPath,
  appendOpenSSHHostKeyPolicyArgs,
  sshConnectionPool,
} from "./sshConnectionPool";
import { getOriginUrlForBundle } from "./gitBundleSync";
import { gitNoHooksPrefix } from "@/node/utils/gitNoHooksEnv";
import { execFileAsync } from "@/node/utils/disposableExec";
import { syncRuntimeGitSubmodules } from "./submoduleSync";
import {
  OpenSSHTransport,
  type PtyHandle,
  type PtySessionParams,
  type SSHTransport,
} from "./transports";
import {
  buildRemoteProjectLayout,
  getRemoteWorkspacePath,
  type RemoteProjectLayout,
} from "./remoteProjectLayout";
import { streamToString, shescape } from "./streamUtils";

/** Staging namespace for synced branch refs. Branches land here instead of
 *  refs/heads/* so they don't collide with branches checked out in worktrees. */
const BUNDLE_REF_PREFIX = "refs/mux-bundle/";

/** Small backoff for concurrent writers healing the same shared base repo config. */
const BASE_REPO_CONFIG_LOCK_RETRY_DELAYS_MS = [50, 100, 200];
const BASE_REPO_HEALTH_PROBE_TIMEOUT_SECONDS = 10;
const BASE_REPO_PROMISOR_CLEANUP_TIMEOUT_SECONDS = 10;
const BASE_REPO_MAINTENANCE_TIMEOUT_SECONDS = 120;
const BASE_REPO_FRAGMENTED_PACK_THRESHOLD = 25;
const PROJECT_SYNC_MAX_ATTEMPTS = 3;
const PROJECT_SYNC_RETRYABLE_ERRORS = [
  "pack-objects died",
  "Connection reset",
  "Connection closed",
  "Broken pipe",
  "EPIPE",
  "Command killed by signal",
] as const;

const sharedProjectSyncTails = new Map<string, Promise<void>>();

async function enqueueProjectSync(
  projectKey: string,
  abortSignal: AbortSignal | undefined,
  fn: () => Promise<void>
): Promise<void> {
  const previous = sharedProjectSyncTails.get(projectKey) ?? Promise.resolve();
  let releaseCurrent: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.then(
    () => current,
    () => current
  );
  sharedProjectSyncTails.set(projectKey, tail);
  void tail.finally(() => {
    if (sharedProjectSyncTails.get(projectKey) === tail) {
      sharedProjectSyncTails.delete(projectKey);
    }
  });

  let onAbort: (() => void) | undefined;
  const waitForPrevious = previous.catch(() => undefined);
  const waitForTurn = abortSignal
    ? Promise.race([
        waitForPrevious,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error("Operation aborted"));
          if (abortSignal.aborted) {
            onAbort();
            return;
          }
          abortSignal.addEventListener("abort", onAbort, { once: true });
        }),
      ])
    : waitForPrevious;

  try {
    await waitForTurn;
    if (abortSignal?.aborted) {
      throw new Error("Operation aborted");
    }
    await fn();
  } finally {
    if (onAbort) {
      abortSignal?.removeEventListener("abort", onAbort);
    }
    releaseCurrent?.();
  }
}

function isGitConfigLockConflict(message: string): boolean {
  return /could not lock config file/i.test(message);
}

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

/** Truncate SSH stderr for error logging (prefer the first transport-related line, max 200 chars). */
function truncateSSHError(stderr: string): string {
  const trimmed = stderr.trim();
  if (!trimmed) return "exit code 255";

  const lines = trimmed.split("\n").filter(Boolean);
  const preferredLine =
    lines.find((line) =>
      /(ssh:|Could not resolve hostname|Host key verification failed|Permission denied|Connection (timed out|refused|reset)|No route to host|Network is unreachable|kex_exchange_identification|Could not read from remote repository)/i.test(
        line
      )
    ) ?? lines[0];

  if (preferredLine.length <= 200) return preferredLine;
  return preferredLine.slice(0, 197) + "...";
}

function isUnsupportedAtomicPush(errorMsg: string): boolean {
  return /atomic/i.test(errorMsg) && /(does not support|not support|unsupported)/i.test(errorMsg);
}

function isGitPushTransportFailure(exitCode: number | null, errorMsg: string): boolean {
  if (exitCode === 255) {
    return true;
  }
  if (exitCode !== 128) {
    return false;
  }

  return /(ssh:|Could not resolve hostname|Host key verification failed|Permission denied|Connection (timed out|refused|reset)|No route to host|Network is unreachable|kex_exchange_identification|Could not read from remote repository)/i.test(
    errorMsg
  );
}
// Re-export SSHRuntimeConfig from connection pool (defined there to avoid circular deps)
export type { SSHRuntimeConfig } from "./sshConnectionPool";

/**
 * Compute the path to the shared bare base repo for a project on the remote.
 * Convention: <srcBaseDir>/<projectId>/.mux-base.git
 *
 * Exported for unit testing; runtime code should use the private
 * `SSHRuntime.getBaseRepoPath()` method instead.
 */
export function computeBaseRepoPath(srcBaseDir: string, projectPath: string): string {
  return buildRemoteProjectLayout(srcBaseDir, projectPath).baseRepoPath;
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
  private readonly currentWorkspacePath?: string;
  /** Cached resolved bgOutputDir (tilde expanded to absolute path) */
  private resolvedBgOutputDir: string | null = null;

  constructor(
    config: SSHRuntimeConfig,
    transport: SSHTransport,
    options?: {
      projectPath?: string;
      workspaceName?: string;
      workspacePath?: string;
    }
  ) {
    super();
    // Note: srcBaseDir may contain tildes - they will be resolved via resolvePath() before use
    // The WORKSPACE_CREATE IPC handler resolves paths before storing in config
    this.config = config;
    this.transport = transport;
    this.ensureReadyProjectPath = options?.projectPath;
    this.ensureReadyWorkspaceName = options?.workspaceName;
    this.currentWorkspacePath = options?.workspacePath;
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

  private getProjectLayout(projectPath: string): RemoteProjectLayout {
    return buildRemoteProjectLayout(this.config.srcBaseDir, projectPath);
  }

  private getProjectSyncKey(projectId: string): string {
    return [
      this.config.host,
      this.config.port?.toString() ?? "22",
      this.config.identityFile ?? "default",
      this.config.srcBaseDir,
      projectId,
    ].join(":");
  }

  private isRetryableProjectSyncError(errorMsg: string): boolean {
    return PROJECT_SYNC_RETRYABLE_ERRORS.some((pattern) => errorMsg.includes(pattern));
  }

  private async probeBaseRepoHealth(
    baseRepoPathArg: string,
    abortSignal?: AbortSignal
  ): Promise<{ packCount: number | null }> {
    const result = await execBuffered(this, `git -C ${baseRepoPathArg} count-objects -v`, {
      cwd: "/tmp",
      timeout: BASE_REPO_HEALTH_PROBE_TIMEOUT_SECONDS,
      abortSignal,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to inspect shared base repository health: ${result.stderr || result.stdout}`
      );
    }

    const packCountMatch = /^packs:\s*(\d+)\s*$/m.exec(result.stdout);
    return {
      packCount: packCountMatch ? Number.parseInt(packCountMatch[1], 10) : null,
    };
  }

  protected async repairBaseRepoForSync(
    baseRepoPathArg: string,
    repairContext: string,
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (abortSignal?.aborted) {
      throw new Error("Operation aborted");
    }

    const promisorPackDirArg = `${baseRepoPathArg}/objects/pack`;
    log.info(repairContext);

    const promisorCleanupResult = await execBuffered(
      this,
      `find ${promisorPackDirArg} -name '*.promisor' -print -delete 2>/dev/null || true`,
      {
        cwd: "/tmp",
        timeout: BASE_REPO_PROMISOR_CLEANUP_TIMEOUT_SECONDS,
        abortSignal,
      }
    );
    const removedPromisorCount = promisorCleanupResult.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean).length;
    if (removedPromisorCount > 0) {
      log.info(
        `Removed ${removedPromisorCount} stale promisor marker(s) during base repo maintenance`
      );
    }

    const gcResult = await execBuffered(this, `git -C ${baseRepoPathArg} gc --prune=now`, {
      cwd: "/tmp",
      timeout: BASE_REPO_MAINTENANCE_TIMEOUT_SECONDS,
      abortSignal,
    });
    if (gcResult.exitCode !== 0) {
      log.warn(
        `Remote git gc exited ${gcResult.exitCode} during base repo maintenance: ${gcResult.stderr || gcResult.stdout}`
      );
    }
  }

  protected async ensureHealthyBaseRepoForSync(
    baseRepoPathArg: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (abortSignal?.aborted) {
      throw new Error("Operation aborted");
    }

    try {
      const { packCount } = await this.probeBaseRepoHealth(baseRepoPathArg, abortSignal);
      if (packCount == null || packCount < BASE_REPO_FRAGMENTED_PACK_THRESHOLD) {
        return;
      }

      const packFileLabel = packCount === 1 ? "pack file" : "pack files";
      initLogger.logStep(
        `Shared base repository is fragmented (${packCount} ${packFileLabel}); running maintenance before sync...`
      );
      await this.repairBaseRepoForSync(
        baseRepoPathArg,
        `Running shared base repository maintenance before sync (${packCount} ${packFileLabel})`,
        abortSignal
      );
    } catch (healthError) {
      const healthErrorMsg = getErrorMessage(healthError);
      if (abortSignal?.aborted || healthErrorMsg === "Operation aborted") {
        throw healthError instanceof Error ? healthError : new Error(healthErrorMsg);
      }
      log.warn(`Shared base repository maintenance preflight failed: ${healthErrorMsg}`);
    }
  }

  protected async cleanupRetryableProjectSyncFailure(
    baseRepoPathArg: string,
    attempt: number,
    maxAttempts: number,
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (abortSignal?.aborted) {
      throw new Error("Operation aborted");
    }

    try {
      await this.repairBaseRepoForSync(
        baseRepoPathArg,
        `Running remote promisor cleanup and git gc before retrying sync push (attempt ${attempt + 1}/${maxAttempts})`,
        abortSignal
      );
    } catch (cleanupError) {
      const cleanupErrorMsg = getErrorMessage(cleanupError);
      if (abortSignal?.aborted || cleanupErrorMsg === "Operation aborted") {
        throw cleanupError instanceof Error ? cleanupError : new Error(cleanupErrorMsg);
      }
      log.warn(`Remote sync retry cleanup failed: ${cleanupErrorMsg}`);
    }
  }

  protected async waitForProjectSyncRetryDelay(
    ms: number,
    abortSignal?: AbortSignal
  ): Promise<void> {
    await sleepWithAbort(ms, abortSignal);
  }

  private async computeSnapshotDigest(projectPath: string): Promise<string> {
    // Workspace materialization only depends on branch tips. Tags are shared repo
    // metadata that can legitimately drift, so they must not participate in the
    // authoritative snapshot identity or force a resync on their own.
    const refsOutput = await new Promise<string>((resolve, reject) => {
      const proc = spawn("git", ["-C", projectPath, "show-ref", "--heads"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      proc.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(Buffer.from(chunk)));
      proc.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)));
      proc.once("close", (code) => {
        if (code === 0) {
          resolve(Buffer.concat(stdoutChunks).toString());
          return;
        }
        const stderrText = Buffer.concat(stderrChunks).toString().trim();
        reject(
          new Error(
            stderrText.length > 0
              ? stderrText
              : `git show-ref failed with code ${code ?? "unknown"}`
          )
        );
      });
      proc.once("error", reject);
    });

    return crypto.createHash("sha256").update(refsOutput).digest("hex");
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

  protected async spawnRemoteProcess(
    fullCommand: string,
    options: ExecOptions & { deadlineMs?: number }
  ): Promise<SpawnResult> {
    return this.transport.spawnRemoteProcess(fullCommand, {
      forcePTY: options.forcePTY,
      timeout: options.timeout,
      abortSignal: options.abortSignal,
      deadlineMs: options.deadlineMs,
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
    if (
      this.currentWorkspacePath &&
      this.ensureReadyProjectPath === projectPath &&
      this.ensureReadyWorkspaceName === workspaceName
    ) {
      return this.currentWorkspacePath;
    }

    return getRemoteWorkspacePath(this.getProjectLayout(projectPath), workspaceName);
  }

  /**
   * Path to the shared bare repo for a project on the remote.
   * All worktree-based workspaces share this object store.
   */
  private getBaseRepoPath(projectPath: string): string {
    return this.getProjectLayout(projectPath).baseRepoPath;
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
    const layout = this.getProjectLayout(projectPath);
    const baseRepoPath = layout.baseRepoPath;
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

    const normalizedConfig = await this.normalizeBaseRepoSharedConfig(baseRepoPathArg, abortSignal);
    if (normalizedConfig) {
      initLogger.logStep("Normalized shared base repository config for worktrees");
    }

    return baseRepoPathArg;
  }

  /**
   * Keep the shared SSH base repo bare by layout instead of by sharing `core.bare`
   * through the repo's common config. Linked worktrees consult that local config too,
   * so leaving `core.bare=true` there leaks bare-repo metadata into normal workspace
   * checkouts even though Git can infer the host repo is bare from its directory
   * layout alone.
   */
  private async normalizeBaseRepoSharedConfig(
    baseRepoPathArg: string,
    abortSignal?: AbortSignal
  ): Promise<boolean> {
    for (let attempt = 0; attempt <= BASE_REPO_CONFIG_LOCK_RETRY_DELAYS_MS.length; attempt++) {
      const unsetResult = await execBuffered(
        this,
        `git -C ${baseRepoPathArg} config --local --unset-all core.bare`,
        {
          cwd: "/tmp",
          timeout: 10,
          abortSignal,
        }
      );

      if (unsetResult.exitCode === 0) {
        return true;
      }

      if (unsetResult.exitCode === 5) {
        return false;
      }

      const errorDetail = unsetResult.stderr || unsetResult.stdout;
      if (!isGitConfigLockConflict(errorDetail)) {
        throw new Error(`Failed to normalize base repo config: ${errorDetail}`);
      }

      const inspectResult = await execBuffered(
        this,
        `git -C ${baseRepoPathArg} config --local --get core.bare`,
        {
          cwd: "/tmp",
          timeout: 10,
          abortSignal,
        }
      );

      if (inspectResult.exitCode === 1) {
        return false;
      }

      if (inspectResult.exitCode !== 0) {
        throw new Error(
          `Failed to inspect base repo config after lock conflict: ${inspectResult.stderr || inspectResult.stdout}`
        );
      }

      if (attempt === BASE_REPO_CONFIG_LOCK_RETRY_DELAYS_MS.length) {
        throw new Error(`Failed to normalize base repo config: ${errorDetail}`);
      }

      // Another initWorkspace may be healing the same shared base repo; if the
      // local key still exists, wait briefly and retry the idempotent unset.
      await new Promise((resolve) =>
        setTimeout(resolve, BASE_REPO_CONFIG_LOCK_RETRY_DELAYS_MS[attempt])
      );
    }

    return false;
  }

  private async resolveWorktreeBaseRepoPath(
    projectPath: string,
    workspacePath: string,
    abortSignal?: AbortSignal
  ): Promise<string> {
    const fallbackBaseRepoPath = this.getBaseRepoPath(projectPath);

    try {
      const result = await execBuffered(
        this,
        `git -C ${this.quoteForRemote(workspacePath)} rev-parse --path-format=absolute --git-common-dir`,
        {
          cwd: "/tmp",
          timeout: 10,
          abortSignal,
        }
      );
      const resolvedBaseRepoPath = result.stdout.trim();
      if (result.exitCode === 0 && resolvedBaseRepoPath.length > 0) {
        return resolvedBaseRepoPath;
      }
    } catch {
      // Fall back to the canonical hashed layout when the existing workspace cannot report its
      // common git dir (for example, if the directory is already partially missing/corrupted).
    }

    return fallbackBaseRepoPath;
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

  private async resolveCheckedOutBranch(
    workspacePath: string,
    abortSignal?: AbortSignal,
    timeout = 10
  ): Promise<string | null> {
    try {
      const branchResult = await execBuffered(
        this,
        `git -C ${this.quoteForRemote(workspacePath)} branch --show-current`,
        {
          cwd: "/tmp",
          timeout,
          abortSignal,
        }
      );
      const branchName = branchResult.stdout.trim();
      return branchResult.exitCode === 0 && branchName.length > 0 ? branchName : null;
    } catch {
      return null;
    }
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

  private async resolveLocalSyncRefManifest(projectPath: string): Promise<string | null> {
    try {
      using proc = execFileAsync("git", ["-C", projectPath, "show-ref", "--heads"]);
      const { stdout } = await proc.result;
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .sort()
        .join("\n");
    } catch {
      return null;
    }
  }

  private async resolveRemoteSyncRefManifest(
    baseRepoPathArg: string,
    abortSignal?: AbortSignal
  ): Promise<string | null> {
    const result = await execBuffered(
      this,
      `git -C ${baseRepoPathArg} for-each-ref --format='%(objectname) %(refname)' ${BUNDLE_REF_PREFIX}`,
      { cwd: "/tmp", timeout: 20, abortSignal }
    );
    if (result.exitCode !== 0) {
      return null;
    }

    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const separator = line.indexOf(" ");
        if (separator === -1) {
          return line;
        }

        const oid = line.slice(0, separator);
        const refName = line.slice(separator + 1);
        const normalizedRefName = refName.startsWith(BUNDLE_REF_PREFIX)
          ? refName.replace(BUNDLE_REF_PREFIX, "refs/heads/")
          : refName;
        return `${oid} ${normalizedRefName}`;
      })
      .sort()
      .join("\n");
  }

  private async refreshBaseRepoOrigin(
    projectPath: string,
    baseRepoPathArg: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const { originUrl } = await this.getOriginUrlForSync(projectPath, initLogger);
    if (!originUrl) {
      return;
    }

    initLogger.logStep(`Setting origin remote to ${originUrl}...`);
    await execBuffered(
      this,
      `git -C ${baseRepoPathArg} remote set-url origin ${shescape.quote(originUrl)} 2>/dev/null || git -C ${baseRepoPathArg} remote add origin ${shescape.quote(originUrl)}`,
      { cwd: "/tmp", timeout: 10, abortSignal }
    );
  }

  /**
   * Pre-fetch from origin on the remote host to reduce local→remote push size.
   *
   * When the remote bare repo has an origin configured, runs `git fetch origin`
   * on the SSH host. The host's datacenter connection to the upstream is
   * typically much faster than the local machine's (e.g., hotel wifi vs
   * datacenter). After this, the subsequent local→remote `git push` only needs
   * to transfer objects that don't exist on origin — usually just unpushed
   * local commits.
   *
   * Best-effort: failures are swallowed because the push still works without
   * the pre-populated cache (it just transfers more data).
   */
  private async prefetchOriginOnRemote(
    projectPath: string,
    baseRepoPathArg: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<void> {
    // Ensure the remote base repo knows where origin is before fetching.
    await this.refreshBaseRepoOrigin(projectPath, baseRepoPathArg, initLogger, abortSignal);

    try {
      initLogger.logStep("Pre-fetching from origin on remote host...");
      const result = await execBuffered(
        this,
        // Fetch all branches from origin into the base repo's object store.
        // This runs entirely on the remote — only the SSH control channel
        // traverses the local link, so it's fast even on slow connections.
        `git -C ${baseRepoPathArg} fetch --prune origin`,
        { cwd: "/tmp", timeout: 120, abortSignal }
      );
      if (result.exitCode === 0) {
        initLogger.logStep("Pre-fetched from origin on remote host");
      } else {
        initLogger.logStep("Pre-fetch from origin skipped (fetch failed)");
      }
    } catch {
      // Best-effort — if origin is unreachable or not configured, the local
      // push will still transfer all required objects.
      initLogger.logStep("Pre-fetch from origin skipped (not reachable)");
    }
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

    let worktreeResult: { exitCode: number; stderr: string; stdout: string };
    try {
      worktreeResult = await execBuffered(
        this,
        `git -C ${this.quoteForRemote(workspacePath)} rev-parse --is-inside-work-tree`,
        {
          cwd: "~",
          timeout: 10,
          abortSignal: options?.signal,
        }
      );
    } catch (error) {
      return {
        ready: false,
        error: `Failed to verify worktree: ${getErrorMessage(error)}`,
        errorType: "runtime_start_failed",
      };
    }

    if (worktreeResult.exitCode !== 0) {
      const stderr = worktreeResult.stderr.trim();
      const stdout = worktreeResult.stdout.trim();
      const errorDetail = stderr || stdout || "git unavailable";
      const isCommandMissing =
        worktreeResult.exitCode === 127 || /command not found/i.test(stderr || stdout);
      if (
        isCommandMissing ||
        this.transport.isConnectionFailure(worktreeResult.exitCode, worktreeResult.stderr)
      ) {
        return {
          ready: false,
          error: `Failed to verify worktree: ${errorDetail}`,
          errorType: "runtime_start_failed",
        };
      }

      return {
        ready: false,
        error: WORKSPACE_REPO_MISSING_ERROR,
        errorType: "runtime_not_ready",
      };
    }

    if (worktreeResult.stdout.trim() !== "true") {
      return {
        ready: false,
        error: WORKSPACE_REPO_MISSING_ERROR,
        errorType: "runtime_not_ready",
      };
    }

    return { ready: true };
  }

  /**
   * Transfer a git bundle to the remote and return its path.
   * Callers are responsible for cleanup of the remote bundle file.
   */
  private async transferBundleToRemote(
    projectPath: string,
    remoteBundlePath: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<string> {
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

  private async syncProjectSnapshotViaBundle(
    projectPath: string,
    layout: RemoteProjectLayout,
    currentSnapshotPath: string,
    snapshotDigest: string,
    baseRepoPathArg: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<void> {
    // Snapshot markers stay deterministic, but the uploaded bundle itself must use
    // a per-attempt temp path so concurrent Mux processes do not stream into the same file.
    const remoteBundlePath = path.posix.join(
      "~/.mux-bundles",
      layout.projectId,
      `${snapshotDigest}.${crypto.randomUUID()}.bundle`
    );
    const remoteBundlePathArg = this.quoteForRemote(remoteBundlePath);
    const remoteBundleParentDir = path.posix.dirname(remoteBundlePath);
    const prepareRemoteDirs = await execBuffered(
      this,
      `mkdir -p ${this.quoteForRemote(remoteBundleParentDir)} ${this.quoteForRemote(path.posix.dirname(currentSnapshotPath))}`,
      { cwd: "/tmp", timeout: 10, abortSignal }
    );
    if (prepareRemoteDirs.exitCode !== 0) {
      throw new Error(
        `Failed to prepare remote snapshot directories: ${prepareRemoteDirs.stderr || prepareRemoteDirs.stdout}`
      );
    }

    await this.transferBundleToRemote(projectPath, remoteBundlePath, initLogger, abortSignal);

    try {
      // Import authoritative branches and shared tags from the bundle into the
      // shared bare repo. Branches land in refs/mux-bundle/* (staging namespace)
      // instead of refs/heads/* to avoid colliding with branches checked out in
      // existing worktrees, and they stay pruneable because branch deletion should
      // invalidate snapshot reuse. Tags go directly to refs/tags/*, but they are
      // fetched separately without --prune so remote-only metadata tags survive.
      initLogger.logStep("Importing bundle into shared base repository...");
      const branchFetchResult = await execBuffered(
        this,
        `git -C ${baseRepoPathArg} fetch --prune ${remoteBundlePathArg} '+refs/heads/*:${BUNDLE_REF_PREFIX}*'`,
        { cwd: "/tmp", timeout: 300, abortSignal }
      );
      if (branchFetchResult.exitCode !== 0) {
        throw new Error(
          `Failed to import bundle branches into base repo: ${branchFetchResult.stderr || branchFetchResult.stdout}`
        );
      }

      const tagFetchResult = await execBuffered(
        this,
        `git -C ${baseRepoPathArg} fetch ${remoteBundlePathArg} '+refs/tags/*:refs/tags/*'`,
        { cwd: "/tmp", timeout: 300, abortSignal }
      );
      if (tagFetchResult.exitCode !== 0) {
        throw new Error(
          `Failed to import bundle tags into base repo: ${tagFetchResult.stderr || tagFetchResult.stdout}`
        );
      }
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

  private async hasLocalTags(projectPath: string): Promise<boolean> {
    using proc = execFileAsync("git", [
      "-C",
      projectPath,
      "for-each-ref",
      "--count=1",
      "--format=%(refname)",
      "refs/tags",
    ]);
    const { stdout } = await proc.result;
    return stdout.trim().length > 0;
  }

  /**
   * Build a GIT_SSH_COMMAND that mirrors the runtime's SSH config so `git push`
   * reuses the same multiplexed connection and auth settings.
   */
  private buildGitSshCommand(): string {
    const config = this.transport.getConfig();
    // GIT_SSH_COMMAND is interpreted as a shell command string, so values
    // containing spaces or special characters must be quoted to prevent
    // incorrect word-splitting (e.g., identity file paths with spaces,
    // ControlPath under /tmp with user-generated segments).
    const singleQuote = "'";
    const escapedSingleQuote = `${singleQuote}\\${singleQuote}${singleQuote}`;
    const q = (s: string) => `${singleQuote}${s.replace(/'/g, escapedSingleQuote)}${singleQuote}`;

    const args: string[] = ["ssh"];

    if (config.port) {
      args.push("-p", config.port.toString());
    }
    if (config.identityFile) {
      args.push("-i", q(config.identityFile));
    }

    // Reuse the runtime's ControlPath so git push piggybacks on the existing
    // multiplexed connection instead of opening a new one.
    const controlPath = getControlPath(config);
    args.push("-o", "LogLevel=FATAL");
    args.push("-o", "ControlMaster=auto");
    args.push("-o", q(`ControlPath=${controlPath}`));
    args.push("-o", "ControlPersist=60");
    args.push("-o", "BatchMode=yes");
    args.push("-o", "ConnectTimeout=15");
    args.push("-o", "ServerAliveInterval=5");
    args.push("-o", "ServerAliveCountMax=2");

    // Match the runtime's host key policy (permissive in headless mode).
    appendOpenSSHHostKeyPolicyArgs(args);

    return args.join(" ");
  }

  private async syncProjectSnapshotViaGitPush(
    projectPath: string,
    layout: RemoteProjectLayout,
    currentSnapshotPath: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const prepareSnapshotDir = await execBuffered(
      this,
      `mkdir -p ${this.quoteForRemote(path.posix.dirname(currentSnapshotPath))}`,
      { cwd: "/tmp", timeout: 10, abortSignal }
    );
    if (prepareSnapshotDir.exitCode !== 0) {
      throw new Error(
        `Failed to prepare remote snapshot directory: ${prepareSnapshotDir.stderr || prepareSnapshotDir.stdout}`
      );
    }

    await this.transport.acquireConnection({
      abortSignal,
      onWait: (waitMs) => logSSHBackoffWait(initLogger, waitMs),
    });

    if (abortSignal?.aborted) {
      throw new Error("Sync aborted");
    }

    initLogger.logStep("Pushing to remote...");

    // Build the SSH remote URL pointing to the shared bare base repo.
    // Use ssh:// URL format (not SCP-style host:path) because:
    //  - SCP-style breaks on IPv6 literals (first : is ambiguous)
    //  - ssh:// handles ~/ paths natively via /~/ syntax
    //  - ssh:// respects the port from GIT_SSH_COMMAND without -p duplication
    const baseRepoPath = layout.baseRepoPath;
    // ssh:// URLs: /~/ means home-relative, / means absolute, and relative
    // paths need /~/ prefix (resolved relative to home on the remote).
    let urlPath: string;
    if (baseRepoPath.startsWith("~/")) {
      urlPath = `/~/${baseRepoPath.slice(2)}`;
    } else if (baseRepoPath.startsWith("/")) {
      urlPath = baseRepoPath;
    } else {
      // Relative path (e.g., "src/project/.mux-base.git") — treat as
      // home-relative to match the old bundle flow's shell resolution.
      urlPath = `/~/${baseRepoPath}`;
    }
    // Bracket bare IPv6 addresses for URL syntax. The host field can be:
    //   hostname        → no change
    //   user@hostname   → no change
    //   2001:db8::1     → [2001:db8::1]       (bare IPv6)
    //   user@[::1]      → no change            (already bracketed)
    //   [::1]           → no change            (already bracketed)
    const host = this.config.host;
    const atIdx = host.lastIndexOf("@");
    const hostPart = atIdx >= 0 ? host.slice(atIdx + 1) : host;
    const userPrefix = atIdx >= 0 ? host.slice(0, atIdx + 1) : "";
    const needsBrackets = hostPart.includes(":") && !hostPart.startsWith("[");
    const urlHost = needsBrackets ? `${userPrefix}[${hostPart}]` : host;
    const remoteUrl = `ssh://${urlHost}${urlPath}`;
    const gitSshCommand = this.buildGitSshCommand();

    // Push authoritative branches and shared tags separately. Branches land in
    // refs/mux-bundle/* (staging namespace) and stay pruneable because branch
    // deletion should invalidate snapshot reuse. Tags go to refs/tags/* as
    // shared metadata, but they must not be pruned based on this local clone's
    // view of the repo.
    //
    // NOTE: This runs `git push` locally (not through the runtime's SSHTransport),
    // so it depends on the local `ssh` CLI being available. On OpenSSH runtimes,
    // the transport already depends on that binary and shares the same ControlPath.
    const runPush = async (pushArgs: string[]): Promise<void> => {
      using pushProc = execFileAsync("git", pushArgs, {
        env: { GIT_SSH_COMMAND: gitSshCommand },
        onStderrData: (chunk) => {
          for (const line of chunk.split("\n").filter(Boolean)) {
            initLogger.logStderr(line);
          }
        },
      });

      // Bound the push with a 300s timeout (matching the old bundle path) and
      // wire up abort signal — disposing kills the child process.
      const pushTimeout = setTimeout(() => pushProc[Symbol.dispose](), 300_000);
      const onAbort = () => pushProc[Symbol.dispose]();
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      try {
        await pushProc.result;
      } finally {
        clearTimeout(pushTimeout);
        abortSignal?.removeEventListener("abort", onAbort);
      }
    };
    const throwPushFailure = (error: unknown): never => {
      const errorMsg = getErrorMessage(error);
      const exitCode = (error as { code?: number | null }).code ?? null;
      const isConnectionFailure =
        (exitCode != null && this.transport.isConnectionFailure(exitCode, errorMsg)) ||
        isGitPushTransportFailure(exitCode, errorMsg);
      if (isConnectionFailure) {
        sshConnectionPool.reportFailure(this.transport.getConfig(), truncateSSHError(errorMsg));
      }
      throw new Error(`Failed to push to remote: ${errorMsg}`);
    };
    const branchPushArgsBase = [
      "-C",
      projectPath,
      "push",
      "--force",
      "--prune",
      "--no-verify",
      remoteUrl,
      `+refs/heads/*:${BUNDLE_REF_PREFIX}*`,
    ];

    try {
      await runPush([
        ...branchPushArgsBase.slice(0, 4),
        "--atomic",
        ...branchPushArgsBase.slice(4),
      ]);
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      if (!isUnsupportedAtomicPush(errorMsg)) {
        throwPushFailure(error);
      }

      initLogger.logStep("Remote git does not support atomic push; retrying without --atomic...");
      try {
        await runPush(branchPushArgsBase);
      } catch (retryError) {
        throwPushFailure(retryError);
      }
    }

    // Metadata propagation is a true no-op when the local repo has no tags.
    // Guarding the tag push keeps branch sync authoritative instead of failing on
    // Git's "no refs in common" error for an empty tag refspec.
    if (!(await this.hasLocalTags(projectPath))) {
      return;
    }

    try {
      await runPush([
        "-C",
        projectPath,
        "push",
        "--force",
        "--no-verify",
        remoteUrl,
        "+refs/tags/*:refs/tags/*",
      ]);
    } catch (error) {
      throwPushFailure(error);
    }
  }

  /**
   * Sync local project to the shared bare base repo on the remote.
   *
   * OpenSSH runtimes use native `git push` so Git negotiates incremental object
   * transfer automatically. SSH2 runtimes keep the bundle path so sync does not
   * depend on a local OpenSSH CLI or local known_hosts state.
   *
   * Branches are the authoritative workspace-materialization state: they land in
   * refs/mux-bundle/* so they do not collide with worktree checkouts, and they
   * remain pruneable so branch deletions invalidate snapshot reuse. Tags still
   * sync into refs/tags/* when a branch resync happens, but they are treated as
   * shared metadata instead of authoritative snapshot state.
   */
  protected async syncProjectToRemote(
    projectPath: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (abortSignal?.aborted) {
      throw new Error("Operation aborted");
    }

    const layout = this.getProjectLayout(projectPath);
    const projectKey = this.getProjectSyncKey(layout.projectId);
    const retryCleanupBaseRepoPathArg = expandTildeForSSH(layout.baseRepoPath);

    // Keep retries, cancellation handling, and retry cleanup inside the project-scoped
    // sync lock so a follow-up init cannot race the shared base repo while we are healing it.
    await enqueueProjectSync(projectKey, abortSignal, async () => {
      for (let attempt = 1; attempt <= PROJECT_SYNC_MAX_ATTEMPTS; attempt++) {
        if (abortSignal?.aborted) {
          throw new Error("Operation aborted");
        }

        try {
          await this.syncProjectToRemoteOnce(projectPath, layout, initLogger, abortSignal);
          return;
        } catch (error) {
          const errorMsg = getErrorMessage(error);
          if (abortSignal?.aborted || errorMsg === "Operation aborted") {
            throw error instanceof Error ? error : new Error(errorMsg);
          }
          if (
            !this.isRetryableProjectSyncError(errorMsg) ||
            attempt === PROJECT_SYNC_MAX_ATTEMPTS
          ) {
            throw new Error(`Failed to sync project: ${errorMsg}`);
          }

          log.info(
            `Sync failed (attempt ${attempt}/${PROJECT_SYNC_MAX_ATTEMPTS}), will retry: ${errorMsg}`
          );
          await this.cleanupRetryableProjectSyncFailure(
            retryCleanupBaseRepoPathArg,
            attempt,
            PROJECT_SYNC_MAX_ATTEMPTS,
            abortSignal
          );
          if (abortSignal?.aborted) {
            throw new Error("Operation aborted");
          }
          initLogger.logStep(
            `Sync failed, retrying (attempt ${attempt + 1}/${PROJECT_SYNC_MAX_ATTEMPTS})...`
          );
          await this.waitForProjectSyncRetryDelay(attempt * 1000, abortSignal);
        }
      }
    });
  }

  protected async syncProjectToRemoteOnce(
    projectPath: string,
    layout: RemoteProjectLayout,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (abortSignal?.aborted) {
      throw new Error("Operation aborted");
    }

    const currentSnapshotPath = layout.currentSnapshotPath;
    const useNativeGitPush = this.transport instanceof OpenSSHTransport;
    const snapshotDigest = await this.computeSnapshotDigest(projectPath);
    const baseRepoPathArg = await this.ensureBaseRepo(projectPath, initLogger, abortSignal);

    // Treat the shared bare repo as a managed cache: verify its health before
    // we ask Git to negotiate another sync against a fragmented object store.
    await this.ensureHealthyBaseRepoForSync(baseRepoPathArg, initLogger, abortSignal);

    const snapshotStatusCheck = await execBuffered(
      this,
      [
        'current_snapshot=""',
        `if test -f ${this.quoteForRemote(currentSnapshotPath)}; then`,
        `  current_snapshot=$(tr -d '\n' < ${this.quoteForRemote(currentSnapshotPath)})`,
        "fi",
        `if test "$current_snapshot" = ${shescape.quote(snapshotDigest)}; then`,
        `  staged_ref=$(git -C ${baseRepoPathArg} for-each-ref --count=1 --format='%(refname)' ${shescape.quote(BUNDLE_REF_PREFIX)})`,
        '  if test -n "$staged_ref"; then',
        "    echo reusable",
        "  else",
        "    echo stale-current",
        "  fi",
        "else",
        "  echo missing",
        "fi",
      ].join("\n"),
      { cwd: "/tmp", timeout: 10, abortSignal }
    );
    const snapshotStatus = snapshotStatusCheck.stdout.trim();
    if (snapshotStatus === "reusable") {
      const localRefManifest = await this.resolveLocalSyncRefManifest(projectPath);
      const remoteRefManifest =
        localRefManifest == null
          ? null
          : await this.resolveRemoteSyncRefManifest(baseRepoPathArg, abortSignal);
      if (localRefManifest != null && remoteRefManifest === localRefManifest) {
        await this.refreshBaseRepoOrigin(projectPath, baseRepoPathArg, initLogger, abortSignal);
        initLogger.logStep("Reusing existing remote project snapshot");
        return;
      }
      initLogger.logStep(
        "Remote snapshot marker drifted from synced refs; resyncing project snapshot..."
      );
    }
    if (snapshotStatus === "stale-current") {
      initLogger.logStep(
        "Remote snapshot marker found without matching synced refs; resyncing project snapshot..."
      );
    }

    if (useNativeGitPush) {
      // Pre-populate the remote base repo with objects from origin before the
      // local→remote push. The SSH host's datacenter connection is typically
      // orders of magnitude faster than the local machine's (e.g., hotel wifi),
      // so fetching origin on the remote first turns the subsequent push into a
      // small incremental transfer instead of a full repo upload.
      // Only useful for git-push sync — bundle sync uploads a fresh local bundle
      // that can't reuse remote objects, so the prefetch would be wasted I/O.
      await this.prefetchOriginOnRemote(projectPath, baseRepoPathArg, initLogger, abortSignal);

      await this.syncProjectSnapshotViaGitPush(
        projectPath,
        layout,
        currentSnapshotPath,
        initLogger,
        abortSignal
      );
    } else {
      await this.syncProjectSnapshotViaBundle(
        projectPath,
        layout,
        currentSnapshotPath,
        snapshotDigest,
        baseRepoPathArg,
        initLogger,
        abortSignal
      );
    }

    // Keep the bare base repo's origin aligned with the local project so later
    // fetchOriginTrunk() calls base new worktrees on the intended remote.
    await this.refreshBaseRepoOrigin(projectPath, baseRepoPathArg, initLogger, abortSignal);

    const currentSnapshotWriter = this.writeFile(currentSnapshotPath).getWriter();
    try {
      await currentSnapshotWriter.write(new TextEncoder().encode(`${snapshotDigest}\n`));
    } finally {
      await currentSnapshotWriter.close();
    }

    initLogger.logStep("Repository synced to base successfully");
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
      const { projectPath, directoryName, initLogger, abortSignal } = params;
      const layout = this.getProjectLayout(projectPath);
      // Workspace directories follow the persisted workspace name; branch checkout happens later.
      const workspacePath = getRemoteWorkspacePath(layout, directoryName);

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
    // Disable git hooks for untrusted projects (prevents post-checkout execution)
    const nhp = gitNoHooksPrefix(params.trusted);

    return runWorkspaceInitHook({
      params,
      runtimeType: "ssh",
      hookCheckPath: params.projectPath,
      beforeHook: async () => {
        await this.prepareWorkspaceCheckout(params, nhp);
      },
      runHook: async ({ muxEnv, initLogger, abortSignal }) => {
        // Expand tilde in hook path (quoted paths don't auto-expand on remote).
        const hookPath = expandTildeForSSH(`${params.workspacePath}/.mux/init`);
        await runInitHookOnRuntime(
          this,
          hookPath,
          params.workspacePath,
          muxEnv,
          initLogger,
          abortSignal
        );
      },
    });
  }

  private async prepareWorkspaceCheckout(params: WorkspaceInitParams, nhp: string): Promise<void> {
    const { projectPath, branchName, trunkBranch, workspacePath, initLogger, abortSignal, env } =
      params;

    // If the workspace directory already exists and contains a git repo (e.g. forked from
    // another SSH workspace via worktree add or legacy cp), skip the expensive sync step.
    const workspacePathArg = expandTildeForSSH(workspacePath);
    let needsWorktreeCheckout = true;

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
        needsWorktreeCheckout = gitCheck.exitCode !== 0;
      }
    } catch {
      // Default to materializing the workspace on unexpected errors.
      needsWorktreeCheckout = true;
    }

    if (needsWorktreeCheckout) {
      // SSH workspace initialization owns repo materialization: it syncs the project into
      // the shared base repo, checks out the worktree, and then materializes submodules
      // before repo-controlled init hooks run.
      initLogger.logStep("Syncing project files to remote...");
      await this.syncProjectToRemote(projectPath, initLogger, abortSignal);
      initLogger.logStep("Files synced successfully");

      // A brand-new workspace still needs git worktree add so the checkout exists before init hooks
      // or submodule sync run. Re-enter ensureBaseRepo() here so older shared repos still get their
      // local core.bare config normalized before we reuse them for a fresh worktree checkout.
      const baseRepoPath = this.getBaseRepoPath(projectPath);
      const baseRepoPathArg = await this.ensureBaseRepo(projectPath, initLogger, abortSignal);

      // Fetch latest from origin in the base repo (best-effort) so new branches
      // can start from the latest upstream state.
      const fetchedOrigin = await this.fetchOriginTrunk(
        baseRepoPath,
        trunkBranch,
        initLogger,
        abortSignal,
        nhp
      );

      // Resolve the bundle's staging ref to use as the local fallback start point.
      // The staging ref is refs/mux-bundle/<trunk>, but the local project's default
      // branch may differ from trunkBranch (e.g. "master" vs "main").
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
      const newBranchBase = shouldUseOrigin ? `origin/${trunkBranch}` : (bundleTrunkRef ?? "HEAD");

      // git worktree add creates the directory and checks out the branch in one step.
      // -B creates the branch or resets it to the start point if it already exists
      // (e.g. orphaned from a previously deleted workspace). Git still prevents
      // checking out a branch that's active in another worktree.
      initLogger.logStep(`Creating worktree for branch: ${branchName}`);
      const worktreeCmd = `${nhp}git -C ${baseRepoPathArg} worktree add ${workspacePathArg} -B ${shescape.quote(branchName)} ${shescape.quote(newBranchBase)}`;

      const worktreeResult = await execBuffered(this, worktreeCmd, {
        cwd: "/tmp",
        timeout: 300,
        abortSignal,
      });

      if (worktreeResult.exitCode !== 0) {
        throw new Error(
          `Failed to create worktree: ${worktreeResult.stderr || worktreeResult.stdout}`
        );
      }
      initLogger.logStep("Worktree created successfully");
    } else {
      initLogger.logStep("Remote workspace already contains a git repo; skipping sync");

      // Existing workspace (e.g. forked): fetch origin and checkout as before.
      const fetchedOrigin = await this.fetchOriginTrunk(
        workspacePath,
        trunkBranch,
        initLogger,
        abortSignal,
        nhp
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
        await this.fastForwardToOrigin(workspacePath, trunkBranch, initLogger, abortSignal, nhp);
      }
    }

    await syncRuntimeGitSubmodules({
      runtime: this,
      workspacePath,
      initLogger,
      abortSignal,
      env,
      trusted: params.trusted,
    });
  }

  /**
   * Fetch trunk branch from origin before checkout.
   * Returns true if fetch succeeded (origin is available for branching).
   */
  private async fetchOriginTrunk(
    workspacePath: string,
    trunkBranch: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal,
    nhp = ""
  ): Promise<boolean> {
    try {
      initLogger.logStep(`Fetching latest from origin/${trunkBranch}...`);

      const fetchCmd = `${nhp}git fetch origin ${shescape.quote(trunkBranch)}`;
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
    abortSignal?: AbortSignal,
    nhp = ""
  ): Promise<void> {
    try {
      initLogger.logStep("Fast-forward merging...");

      const mergeCmd = `${nhp}git merge --ff-only origin/${shescape.quote(trunkBranch)}`;
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
    const oldPath = this.getWorkspacePath(projectPath, oldName);
    const newPath = path.posix.join(path.posix.dirname(oldPath), newName);

    try {
      const expandedOldPath = expandTildeForSSH(oldPath);
      const expandedNewPath = expandTildeForSSH(newPath);

      // Detect if workspace is a worktree vs legacy full clone.
      const isWorktree = await this.isWorktreeWorkspace(oldPath, abortSignal);

      let moveCommand: string;
      if (isWorktree) {
        // Worktree: use `git worktree move` to keep the workspace registered in whichever
        // shared base repo originally created it, including upgraded legacy SSH layouts.
        const baseRepoPathArg = expandTildeForSSH(
          await this.resolveWorktreeBaseRepoPath(projectPath, oldPath, abortSignal)
        );
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
    abortSignal?: AbortSignal,
    trusted?: boolean
  ): Promise<{ success: true; deletedPath: string } | { success: false; error: string }> {
    // Check if already aborted
    if (abortSignal?.aborted) {
      return { success: false, error: "Delete operation aborted" };
    }

    // Disable git hooks for untrusted projects
    const nhp = gitNoHooksPrefix(trusted);

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
                  # nhp disables git hooks for untrusted projects (reference-transaction, etc.)
                  ${nhp}git fetch origin "$DEFAULT" --quiet 2>/dev/null || true

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
        // Directory doesn't exist - deletion is idempotent (success).
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

      const branchToDelete = await this.resolveCheckedOutBranch(deletedPath, abortSignal, 10);

      // Detect if workspace is a worktree (.git is a file) vs a legacy full clone (.git is a directory).
      const isWorktree = await this.isWorktreeWorkspace(deletedPath, abortSignal);

      if (isWorktree) {
        // Worktree: use `git worktree remove` against the actual common git dir for this
        // workspace so upgraded legacy SSH worktrees keep their original base repo metadata.
        const baseRepoPathArg = expandTildeForSSH(
          await this.resolveWorktreeBaseRepoPath(projectPath, deletedPath, abortSignal)
        );
        const removeCmd = force
          ? `${nhp}git -C ${baseRepoPathArg} worktree remove --force ${this.quoteForRemote(deletedPath)}`
          : `${nhp}git -C ${baseRepoPathArg} worktree remove ${this.quoteForRemote(deletedPath)}`;
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
            `rm -rf ${this.quoteForRemote(deletedPath)} && (${nhp}git -C ${baseRepoPathArg} worktree prune 2>/dev/null || true)`,
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
        if (branchToDelete && !PROTECTED_BRANCHES.includes(branchToDelete)) {
          await execBuffered(
            this,
            `${nhp}git -C ${baseRepoPathArg} branch -D ${shescape.quote(branchToDelete)} 2>/dev/null || true`,
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

    const sourceWorkspacePath = this.getWorkspacePath(projectPath, sourceWorkspaceName);
    const newWorkspacePath = path.posix.join(
      path.posix.dirname(sourceWorkspacePath),
      newWorkspaceName
    );

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
      const sourceBranch = await this.resolveCheckedOutBranch(sourceWorkspacePath, abortSignal, 30);
      if (!sourceBranch) {
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
        // Disable git hooks for untrusted projects (prevents post-checkout execution)
        const nhp = gitNoHooksPrefix(params.trusted);
        const worktreeCmd = `${nhp}git -C ${baseRepoPathArg} worktree add ${newWorkspacePathArg} -b ${shescape.quote(newWorkspaceName)} ${shescape.quote(sourceBranch)}`;
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
        // Disable git hooks for untrusted projects (prevents post-checkout execution)
        const forkNhp = gitNoHooksPrefix(params.trusted);
        initLogger.logStep(`Checking out branch: ${newWorkspaceName}`);
        const checkoutCmd =
          `${forkNhp}git checkout ${shescape.quote(newWorkspaceName)} 2>/dev/null || ` +
          `${forkNhp}git checkout -b ${shescape.quote(newWorkspaceName)} ${shescape.quote(sourceBranch)}`;
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
