import { spawn } from "child_process";
import { Readable, Writable } from "stream";
import * as path from "path";
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
import { EXIT_CODE_ABORTED, EXIT_CODE_TIMEOUT } from "@/common/constants/exitCodes";
import { log } from "@/node/services/log";
import { checkInitHookExists, createLineBufferedLoggers, getMuxEnv } from "./initHook";
import { NON_INTERACTIVE_ENV_VARS } from "@/common/constants/env";
import { streamProcessToLogger } from "./streamProcess";
import { expandTildeForSSH, cdCommandForSSH } from "./tildeExpansion";
import { getProjectName, execBuffered } from "@/node/utils/runtime/helpers";
import { getErrorMessage } from "@/common/utils/errors";
import { execAsync, DisposableProcess } from "@/node/utils/disposableExec";
import { getControlPath, sshConnectionPool, type SSHRuntimeConfig } from "./sshConnectionPool";
import { getBashPath } from "@/node/utils/main/bashPath";

/**
 * Shell-escape helper for remote bash.
 * Reused across all SSH runtime operations for performance.
 * Note: For background process commands, use shellQuote from backgroundCommands for parity.
 */
const shescape = {
  quote(value: unknown): string {
    const s = String(value);
    if (s.length === 0) return "''";
    // Use POSIX-safe pattern to embed single quotes within single-quoted strings
    return "'" + s.replace(/'/g, "'\"'\"'") + "'";
  },
};

function logSSHBackoffWait(initLogger: InitLogger, waitMs: number): void {
  const secs = Math.max(1, Math.ceil(waitMs / 1000));
  initLogger.logStep(`SSH unavailable; retrying in ${secs}s...`);
}

// Re-export SSHRuntimeConfig from connection pool (defined there to avoid circular deps)
export type { SSHRuntimeConfig } from "./sshConnectionPool";

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
 */
export class SSHRuntime implements Runtime {
  private readonly config: SSHRuntimeConfig;
  private readonly controlPath: string;
  /** Cached resolved bgOutputDir (tilde expanded to absolute path) */
  private resolvedBgOutputDir: string | null = null;

  constructor(config: SSHRuntimeConfig) {
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

  /**
   * Execute command over SSH with streaming I/O
   */
  async exec(command: string, options: ExecOptions): Promise<ExecStream> {
    const startTime = performance.now();

    // Short-circuit if already aborted
    if (options.abortSignal?.aborted) {
      throw new RuntimeErrorClass("Operation aborted before execution", "exec");
    }

    // Ensure connection is healthy before executing.
    // This provides backoff protection and singleflighting for concurrent requests.
    await sshConnectionPool.acquireConnection(this.config, {
      abortSignal: options.abortSignal,
    });

    // Build command parts
    const parts: string[] = [];

    // Add cd command if cwd is specified
    parts.push(cdCommandForSSH(options.cwd));

    // Add environment variable exports (user env first, then non-interactive overrides)
    const envVars = { ...options.env, ...NON_INTERACTIVE_ENV_VARS };
    for (const [key, value] of Object.entries(envVars)) {
      parts.push(`export ${key}=${shescape.quote(value)}`);
    }

    // Add the actual command
    parts.push(command);

    // Join all parts with && to ensure each step succeeds before continuing
    let fullCommand = parts.join(" && ");

    // Always wrap in bash to ensure consistent shell behavior
    // (user's login shell may be fish, zsh, etc. which have different syntax)
    fullCommand = `bash -c ${shescape.quote(fullCommand)}`;

    // Optionally wrap with timeout to ensure the command is killed on the remote side
    // even if the local SSH client is killed but the ControlMaster connection persists
    // Use timeout command with KILL signal
    // Set remote timeout slightly longer (+1s) than local timeout to ensure
    // the local timeout fires first in normal cases (for cleaner error handling)
    // Note: Using BusyBox-compatible syntax (-s KILL) which also works with GNU timeout
    if (options.timeout !== undefined) {
      const remoteTimeout = Math.ceil(options.timeout) + 1;
      fullCommand = `timeout -s KILL ${remoteTimeout} ${fullCommand}`;
    }

    // Build SSH args from shared base config
    // -T: Disable pseudo-terminal allocation (default)
    // -t: Force pseudo-terminal allocation (for interactive shells)
    const sshArgs: string[] = [options.forcePTY ? "-t" : "-T", ...this.buildSSHArgs()];

    // Set comprehensive timeout options to ensure SSH respects the timeout
    // ConnectTimeout: Maximum time to wait for connection establishment (DNS, TCP handshake, SSH auth)
    // Cap at 15 seconds - users wanting long timeouts for builds shouldn't wait that long for connection
    // ServerAliveInterval: Send keepalive every 5 seconds to detect dead connections
    // ServerAliveCountMax: Consider connection dead after 2 missed keepalives (10 seconds total)
    // Together these ensure that:
    // 1. Connection establishment can't hang indefinitely (max 15s)
    // 2. Established connections that die are detected quickly
    // 3. The overall command timeout is respected from the moment ssh command starts
    // When no timeout specified, use default 15s connect timeout to prevent hanging on connection
    const connectTimeout =
      options.timeout !== undefined ? Math.min(Math.ceil(options.timeout), 15) : 15;
    sshArgs.push("-o", `ConnectTimeout=${connectTimeout}`);
    // Set aggressive keepalives to detect dead connections
    sshArgs.push("-o", "ServerAliveInterval=5");
    sshArgs.push("-o", "ServerAliveCountMax=2");

    sshArgs.push(this.config.host, fullCommand);

    // Debug: log the actual SSH command being executed
    log.debug(`SSH command: ssh ${sshArgs.join(" ")}`);
    log.debug(`Remote command: ${fullCommand}`);

    // Spawn ssh command
    const sshProcess = spawn("ssh", sshArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      // Prevent console window from appearing on Windows
      windowsHide: true,
    });

    // Wrap in DisposableProcess for automatic cleanup
    const disposable = new DisposableProcess(sshProcess);

    // Convert Node.js streams to Web Streams
    const stdout = Readable.toWeb(sshProcess.stdout) as unknown as ReadableStream<Uint8Array>;
    const stderr = Readable.toWeb(sshProcess.stderr) as unknown as ReadableStream<Uint8Array>;
    const stdin = Writable.toWeb(sshProcess.stdin) as unknown as WritableStream<Uint8Array>;

    // No stream cleanup in DisposableProcess - streams close naturally when process exits
    // bash.ts handles cleanup after waiting for exitCode

    // Track if we killed the process due to timeout or abort
    let timedOut = false;
    let aborted = false;

    // Create promises for exit code and duration
    // Uses special exit codes (EXIT_CODE_ABORTED, EXIT_CODE_TIMEOUT) for expected error conditions
    const exitCode = new Promise<number>((resolve, reject) => {
      sshProcess.on("close", (code, signal) => {
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

        const exitCode = code ?? (signal ? -1 : 0);

        // SSH exit code 255 indicates connection failure - report to pool for backoff
        // This prevents thundering herd when a previously healthy host goes down
        // Any other exit code means the connection worked (command may have failed)
        if (exitCode === 255) {
          sshConnectionPool.reportFailure(this.config, "SSH connection failed (exit code 255)");
        } else {
          sshConnectionPool.markHealthy(this.config);
        }

        resolve(exitCode);
        // Cleanup runs automatically via DisposableProcess
      });

      sshProcess.on("error", (err) => {
        // Spawn errors are connection-level failures
        sshConnectionPool.reportFailure(this.config, `SSH spawn error: ${err.message}`);
        reject(new RuntimeErrorClass(`Failed to execute SSH command: ${err.message}`, "exec", err));
      });
    });

    const duration = exitCode.then(() => performance.now() - startTime);

    // Handle abort signal
    if (options.abortSignal) {
      options.abortSignal.addEventListener("abort", () => {
        aborted = true;
        disposable[Symbol.dispose](); // Kill process and run cleanup
      });
    }

    // Handle timeout (only if timeout specified)
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

  /**
   * Read file contents over SSH as a stream
   */
  readFile(path: string, abortSignal?: AbortSignal): ReadableStream<Uint8Array> {
    // Return stdout, but wrap to handle errors from exec() and exit code
    return new ReadableStream<Uint8Array>({
      start: async (controller: ReadableStreamDefaultController<Uint8Array>) => {
        try {
          // Use expandTildeForSSH to handle ~ paths (shescape.quote doesn't expand tildes)
          const stream = await this.exec(`cat ${expandTildeForSSH(path)}`, {
            cwd: this.config.srcBaseDir,
            timeout: 300, // 5 minutes - reasonable for large files
            abortSignal,
          });

          const reader = stream.stdout.getReader();
          const exitCode = stream.exitCode;

          // Read all chunks
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }

          // Check exit code after reading completes
          const code = await exitCode;
          if (code !== 0) {
            const stderr = await streamToString(stream.stderr);
            throw new RuntimeErrorClass(`Failed to read file ${path}: ${stderr}`, "file_io");
          }

          controller.close();
        } catch (err) {
          if (err instanceof RuntimeErrorClass) {
            controller.error(err);
          } else {
            controller.error(
              new RuntimeErrorClass(
                `Failed to read file ${path}: ${err instanceof Error ? err.message : String(err)}`,
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
   * Write file contents over SSH atomically from a stream
   * Preserves symlinks and file permissions by resolving and copying metadata
   */
  writeFile(path: string, abortSignal?: AbortSignal): WritableStream<Uint8Array> {
    // Use expandTildeForSSH to handle ~ paths (shescape.quote doesn't expand tildes)
    const expandedPath = expandTildeForSSH(path);
    const tempPath = `${path}.tmp.${Date.now()}`;
    const expandedTempPath = expandTildeForSSH(tempPath);
    // Resolve symlinks to get the actual target path, preserving the symlink itself
    // If target exists, save its permissions to restore after write
    // If path doesn't exist, use 600 as default
    // Then write atomically using mv (all-or-nothing for readers)
    const writeCommand = `RESOLVED=$(readlink -f ${expandedPath} 2>/dev/null || echo ${expandedPath}) && PERMS=$(stat -c '%a' "$RESOLVED" 2>/dev/null || echo 600) && mkdir -p $(dirname "$RESOLVED") && cat > ${expandedTempPath} && chmod "$PERMS" ${expandedTempPath} && mv ${expandedTempPath} "$RESOLVED"`;

    // Need to get the exec stream in async callbacks
    let execPromise: Promise<ExecStream> | null = null;

    const getExecStream = () => {
      execPromise ??= this.exec(writeCommand, {
        cwd: this.config.srcBaseDir,
        timeout: 300, // 5 minutes - reasonable for large files
        abortSignal,
      });
      return execPromise;
    };

    // Wrap stdin to handle errors from exit code
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
        // Close stdin and wait for command to complete
        await stream.stdin.close();
        const exitCode = await stream.exitCode;

        if (exitCode !== 0) {
          const stderr = await streamToString(stream.stderr);
          throw new RuntimeErrorClass(`Failed to write file ${path}: ${stderr}`, "file_io");
        }
      },
      abort: async (reason?: unknown) => {
        const stream = await getExecStream();
        await stream.stdin.abort();
        throw new RuntimeErrorClass(`Failed to write file ${path}: ${String(reason)}`, "file_io");
      },
    });
  }

  /**
   * Get file statistics over SSH
   */
  async stat(path: string, abortSignal?: AbortSignal): Promise<FileStat> {
    // Use stat with format string to get: size, mtime, type
    // %s = size, %Y = mtime (seconds since epoch), %F = file type
    // Use expandTildeForSSH to handle ~ paths (shescape.quote doesn't expand tildes)
    const stream = await this.exec(`stat -c '%s %Y %F' ${expandTildeForSSH(path)}`, {
      cwd: this.config.srcBaseDir,
      timeout: 10, // 10 seconds - stat should be fast
      abortSignal,
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      streamToString(stream.stdout),
      streamToString(stream.stderr),
      stream.exitCode,
    ]);

    if (exitCode !== 0) {
      throw new RuntimeErrorClass(`Failed to stat ${path}: ${stderr}`, "file_io");
    }

    const parts = stdout.trim().split(" ");
    if (parts.length < 3) {
      throw new RuntimeErrorClass(`Failed to parse stat output for ${path}: ${stdout}`, "file_io");
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
  async resolvePath(filePath: string): Promise<string> {
    // Expand tilde on the remote system.
    // IMPORTANT: This must not single-quote a "~" path directly, because quoted tildes won't expand.
    // We reuse expandTildeForSSH() to produce a "$HOME"-based, bash-safe expression.
    //
    // Note: This does not attempt to canonicalize relative paths (no filesystem access).
    // It only ensures ~ is expanded so callers can compare against absolute paths.
    const script = `echo ${expandTildeForSSH(filePath)}`;
    const command = `bash -c ${shescape.quote(script)}`;

    // Use 10 second timeout for path resolution to allow for slower SSH connections
    return this.execSSHCommand(command, 10000);
  }

  /**
   * Execute a simple SSH command and return stdout
   * @param command - The command to execute on the remote host
   * @param timeoutMs - Timeout in milliseconds (required to prevent network hangs)
   * @private
   */
  private async execSSHCommand(command: string, timeoutMs: number): Promise<string> {
    // Ensure connection is healthy before executing
    await sshConnectionPool.acquireConnection(this.config, { timeoutMs });

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

  normalizePath(targetPath: string, basePath: string): string {
    // For SSH, handle paths in a POSIX-like manner without accessing the remote filesystem
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

    // Handle tilde expansion - keep as-is for comparison
    let normalizedTarget = target;
    if (target === "~" || target.startsWith("~/")) {
      normalizedTarget = target;
    } else if (target.startsWith("/")) {
      // Absolute path - use as-is
      normalizedTarget = target;
    } else {
      // Relative path - resolve against base using POSIX path joining
      normalizedTarget = base.endsWith("/") ? base + target : base + "/" + target;
    }

    // Remove trailing slash for comparison (except for root "/")
    if (normalizedTarget.length > 1 && normalizedTarget.endsWith("/")) {
      normalizedTarget = normalizedTarget.slice(0, -1);
    }

    return normalizedTarget;
  }

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

      // Step 2: Ensure the SSH host is reachable before doing expensive local work
      await sshConnectionPool.acquireConnection(this.config, {
        abortSignal,
        onWait: (waitMs) => logSSHBackoffWait(initLogger, waitMs),
      });

      // Step 3: Create bundle locally and pipe to remote file via SSH
      initLogger.logStep(`Creating git bundle...`);

      await new Promise<void>((resolve, reject) => {
        if (abortSignal?.aborted) {
          reject(new Error("Bundle creation aborted"));
          return;
        }

        // Build SSH args with timeout options to detect connection failures quickly
        // Without these, SSH can hang indefinitely, causing git to receive SIGPIPE
        // and report the cryptic "pack-objects died" error
        const sshArgs = [
          "-T", // No PTY needed for piped data
          ...this.buildSSHArgs(),
          "-o",
          "ConnectTimeout=15",
          "-o",
          "ServerAliveInterval=5",
          "-o",
          "ServerAliveCountMax=2",
          this.config.host,
        ];
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

      // Step 4: Clone from bundle on remote using this.exec
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

      // Step 5: Create local tracking branches for all remote branches
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

      // Step 6: Update origin remote if we have an origin URL
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

      // Step 7: Remove bundle file
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

  /**
   * Run .mux/init hook on remote machine if it exists
   * @param workspacePath - Path to the workspace directory on remote
   * @param muxEnv - MUX_ environment variables (from getMuxEnv)
   * @param initLogger - Logger for streaming output
   * @param abortSignal - Optional abort signal
   */
  private async runInitHook(
    workspacePath: string,
    muxEnv: Record<string, string>,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<void> {
    // Construct hook path - expand tilde if present
    const remoteHookPath = `${workspacePath}/.mux/init`;
    initLogger.logStep(`Running init hook: ${remoteHookPath}`);

    // Expand tilde in hook path for execution
    // Tilde won't be expanded when the path is quoted, so we need to expand it ourselves
    const hookCommand = expandTildeForSSH(remoteHookPath);

    // Run hook remotely and stream output
    // No timeout - user init hooks can be arbitrarily long
    const hookStream = await this.exec(hookCommand, {
      cwd: workspacePath, // Run in the workspace directory
      timeout: 3600, // 1 hour - generous timeout for init hooks
      abortSignal,
      env: muxEnv,
    });

    // Create line-buffered loggers
    const loggers = createLineBufferedLoggers(initLogger);

    // Stream stdout/stderr through line-buffered loggers
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

    // Wait for completion
    const [exitCode] = await Promise.all([hookStream.exitCode, readStdout(), readStderr()]);

    initLogger.logComplete(exitCode);
  }

  getWorkspacePath(projectPath: string, workspaceName: string): string {
    const projectName = getProjectName(projectPath);
    return path.posix.join(this.config.srcBaseDir, projectName, workspaceName);
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
      // Note: runInitHook calls logComplete() internally if hook exists
      const hookExists = await checkInitHookExists(projectPath);
      if (hookExists) {
        const muxEnv = getMuxEnv(projectPath, "ssh", branchName);
        await this.runInitHook(workspacePath, muxEnv, initLogger, abortSignal);
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
          error: `Failed to rename directory: ${stderr || "Unknown error"}`,
        };
      }

      return { success: true, oldPath, newPath };
    } catch (error) {
      return { success: false, error: `Failed to rename directory: ${getErrorMessage(error)}` };
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
          error: `Workspace contains uncommitted changes. Use force flag to delete anyway.`,
        };
      }

      if (checkExitCode === 2) {
        // Read stderr which contains the unpushed commits output
        const stderrReader = checkStream.stderr.getReader();
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

        const commitList = stderr.trim();
        const errorMsg = commitList
          ? `Workspace contains unpushed commits:\n\n${commitList}`
          : `Workspace contains unpushed commits. Use force flag to delete anyway.`;

        return {
          success: false,
          error: errorMsg,
        };
      }

      if (checkExitCode !== 0) {
        // Unexpected error
        const stderrReader = checkStream.stderr.getReader();
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
          error: `Failed to check workspace state: ${stderr || `exit code ${checkExitCode}`}`,
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
          error: `Failed to delete directory: ${stderr || "Unknown error"}`,
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

  /**
   * Get the runtime's temp directory (resolved absolute path on remote).
   */
  tempDir(): Promise<string> {
    // Use configured bgOutputDir's parent or default /tmp
    // The bgOutputDir is typically /tmp/mux-bashes, so we return /tmp
    return Promise.resolve("/tmp");
  }
}

/**
 * Helper to convert a ReadableStream to a string
 */
export async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let result = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    return result;
  } finally {
    reader.releaseLock();
  }
}
