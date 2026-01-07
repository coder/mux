/**
 * Runtime abstraction for executing tools in different environments.
 *
 * DESIGN PRINCIPLE: Keep this interface minimal and low-level.
 * - Prefer streaming primitives over buffered APIs
 * - Implement shared helpers (utils/runtime/) that work across all runtimes
 * - Avoid duplicating helper logic in each runtime implementation
 *
 * This interface allows tools to run locally, in Docker containers, over SSH, etc.
 */

/**
 * PATH TERMINOLOGY & HIERARCHY
 *
 * srcBaseDir (base directory for all workspaces):
 *   - Where mux stores ALL workspace directories
 *   - Local: ~/.mux/src (tilde expanded to full path by LocalRuntime)
 *   - SSH: /home/user/workspace (tilde paths are allowed and are resolved before use)
 *
 * Workspace Path Computation:
 *   {srcBaseDir}/{projectName}/{workspaceName}
 *
 *   - projectName: basename(projectPath)
 *     Example: "/Users/me/git/my-project" → "my-project"
 *
 *   - workspaceName: branch name or custom name
 *     Example: "feature-123" or "main"
 *
 * Full Example (Local):
 *   srcBaseDir:    ~/.mux/src (expanded to /home/user/.mux/src)
 *   projectPath:   /Users/me/git/my-project (local git repo)
 *   projectName:   my-project (extracted)
 *   workspaceName: feature-123
 *   → Workspace:   /home/user/.mux/src/my-project/feature-123
 *
 * Full Example (SSH):
 *   srcBaseDir:    /home/user/workspace (absolute path required)
 *   projectPath:   /Users/me/git/my-project (local git repo)
 *   projectName:   my-project (extracted)
 *   workspaceName: feature-123
 *   → Workspace:   /home/user/workspace/my-project/feature-123
 */

/**
 * Options for executing a command
 */
export interface ExecOptions {
  /** Working directory for command execution */
  cwd: string;
  /** Environment variables to inject */
  env?: Record<string, string>;
  /**
   * Timeout in seconds.
   *
   * When provided, prevents zombie processes by ensuring spawned processes are killed.
   * Even long-running commands should have a reasonable upper bound (e.g., 3600s for 1 hour).
   *
   * When omitted, no timeout is applied - use only for internal operations like
   * spawning background processes that are designed to run indefinitely.
   */
  timeout?: number;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Force PTY allocation (SSH only - adds -t flag) */
  forcePTY?: boolean;
}

/**
 * Handle to a background process.
 * Abstracts away whether process is local or remote.
 *
 * Output is written directly to a unified output.log file by shell redirection.
 * This handle is for lifecycle management and output directory operations.
 */
export interface BackgroundHandle {
  /** Output directory containing output.log, meta.json, exit_code */
  readonly outputDir: string;

  /**
   * Get the exit code if the process has exited.
   * Returns null if still running.
   * Async because SSH needs to read remote exit_code file.
   */
  getExitCode(): Promise<number | null>;

  /**
   * Terminate the process (SIGTERM → wait → SIGKILL).
   */
  terminate(): Promise<void>;

  /**
   * Clean up resources (called after process exits or on error).
   */
  dispose(): Promise<void>;

  /**
   * Write meta.json to the output directory.
   */
  writeMeta(metaJson: string): Promise<void>;

  /**
   * Read output from output.log at the given byte offset.
   * Returns the content read and the new offset (for incremental reads).
   * Works on both local and SSH runtimes by using runtime.exec() internally.
   */
  readOutput(offset: number): Promise<{ content: string; newOffset: number }>;
}

/**
 * Streaming result from executing a command
 */
export interface ExecStream {
  /** Standard output stream */
  stdout: ReadableStream<Uint8Array>;
  /** Standard error stream */
  stderr: ReadableStream<Uint8Array>;
  /** Standard input stream */
  stdin: WritableStream<Uint8Array>;
  /** Promise that resolves with exit code when process completes */
  exitCode: Promise<number>;
  /** Promise that resolves with wall clock duration in milliseconds */
  duration: Promise<number>;
}

/**
 * File statistics
 */
export interface FileStat {
  /** File size in bytes */
  size: number;
  /** Last modified time */
  modifiedTime: Date;
  /** True if path is a directory (false implies regular file for our purposes) */
  isDirectory: boolean;
}

/**
 * Logger for streaming workspace initialization events to frontend.
 * Used to report progress during workspace creation and init hook execution.
 */
export interface InitLogger {
  /** Log a creation step (e.g., "Creating worktree", "Syncing files") */
  logStep(message: string): void;
  /** Log stdout line from init hook */
  logStdout(line: string): void;
  /** Log stderr line from init hook */
  logStderr(line: string): void;
  /** Report init hook completion */
  logComplete(exitCode: number): void;
}

/**
 * Parameters for workspace creation
 */
export interface WorkspaceCreationParams {
  /** Absolute path to project directory on local machine */
  projectPath: string;
  /** Branch name to checkout in workspace */
  branchName: string;
  /** Trunk branch to base new branches on */
  trunkBranch: string;
  /** Directory name to use for workspace (typically branch name) */
  directoryName: string;
  /** Logger for streaming creation progress and init hook output */
  initLogger: InitLogger;
  /** Optional abort signal for cancellation */
  abortSignal?: AbortSignal;
}

/**
 * Result from workspace creation
 */
export interface WorkspaceCreationResult {
  success: boolean;
  /** Absolute path to workspace (local path for LocalRuntime, remote path for SSHRuntime) */
  workspacePath?: string;
  error?: string;
}

/**
 * Parameters for workspace initialization
 */
export interface WorkspaceInitParams {
  /** Absolute path to project directory on local machine */
  projectPath: string;
  /** Branch name to checkout in workspace */
  branchName: string;
  /** Trunk branch to base new branches on */
  trunkBranch: string;
  /** Absolute path to workspace (from createWorkspace result) */
  workspacePath: string;
  /** Logger for streaming initialization progress and output */
  initLogger: InitLogger;
  /** Optional abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Environment variables to inject (MUX_ vars + secrets) */
  env?: Record<string, string>;
}

/**
 * Result from workspace initialization
 */
export interface WorkspaceInitResult {
  success: boolean;
  error?: string;
}

/**
 * Runtime interface - minimal, low-level abstraction for tool execution environments.
 *
 * All methods return streaming primitives for memory efficiency.
 * Use helpers in utils/runtime/ for convenience wrappers (e.g., readFileString, execBuffered).

/**
 * Parameters for forking an existing workspace
 */
export interface WorkspaceForkParams {
  /** Project root path (local path) */
  projectPath: string;
  /** Name of the source workspace to fork from */
  sourceWorkspaceName: string;
  /** Name for the new workspace */
  newWorkspaceName: string;
  /** Logger for streaming initialization events */
  initLogger: InitLogger;
}

/**
 * Result of forking a workspace
 */
export interface WorkspaceForkResult {
  /** Whether the fork operation succeeded */
  success: boolean;
  /** Path to the new workspace (if successful) */
  workspacePath?: string;
  /** Branch that was forked from */
  sourceBranch?: string;
  /** Error message (if failed) */
  error?: string;
}

/**
 * Runtime interface - minimal, low-level abstraction for tool execution environments.
 *
 * All methods return streaming primitives for memory efficiency.
 * Use helpers in utils/runtime/ for convenience wrappers (e.g., readFileString, execBuffered).
 */
export interface Runtime {
  /**
   * Execute a bash command with streaming I/O
   * @param command The bash script to execute
   * @param options Execution options (cwd, env, timeout, etc.)
   * @returns Promise that resolves to streaming handles for stdin/stdout/stderr and completion promises
   * @throws RuntimeError if execution fails in an unrecoverable way
   */
  exec(command: string, options: ExecOptions): Promise<ExecStream>;

  /**
   * Read file contents as a stream
   * @param path Absolute or relative path to file
   * @param abortSignal Optional abort signal for cancellation
   * @returns Readable stream of file contents
   * @throws RuntimeError if file cannot be read
   */
  readFile(path: string, abortSignal?: AbortSignal): ReadableStream<Uint8Array>;

  /**
   * Write file contents atomically from a stream
   * @param path Absolute or relative path to file
   * @param abortSignal Optional abort signal for cancellation
   * @returns Writable stream for file contents
   * @throws RuntimeError if file cannot be written
   */
  writeFile(path: string, abortSignal?: AbortSignal): WritableStream<Uint8Array>;

  /**
   * Get file statistics
   * @param path Absolute or relative path to file/directory
   * @param abortSignal Optional abort signal for cancellation
   * @returns File statistics
   * @throws RuntimeError if path does not exist or cannot be accessed
   */
  stat(path: string, abortSignal?: AbortSignal): Promise<FileStat>;

  /**
   * Resolve a path to its absolute, canonical form (expanding tildes, resolving symlinks, etc.).
   * This is used at workspace creation time to normalize srcBaseDir paths in config.
   *
   * @param path Path to resolve (may contain tildes or be relative)
   * @returns Promise resolving to absolute path
   * @throws RuntimeError if path cannot be resolved (e.g., doesn't exist, permission denied)
   *
   * @example
   * // LocalRuntime
   * await runtime.resolvePath("~/mux")      // => "/home/user/mux"
   * await runtime.resolvePath("./relative")  // => "/current/dir/relative"
   *
   * // SSHRuntime
   * await runtime.resolvePath("~/mux")      // => "/home/user/mux" (via SSH shell expansion)
   */
  resolvePath(path: string): Promise<string>;

  /**
   * Normalize a path for comparison purposes within this runtime's context.
   * Handles runtime-specific path semantics (local vs remote).
   *
   * @param targetPath Path to normalize (may be relative or absolute)
   * @param basePath Base path to resolve relative paths against
   * @returns Normalized path suitable for string comparison
   *
   * @example
   * // LocalRuntime
   * runtime.normalizePath(".", "/home/user") // => "/home/user"
   * runtime.normalizePath("../other", "/home/user/project") // => "/home/user/other"
   *
   * // SSHRuntime
   * runtime.normalizePath(".", "/home/user") // => "/home/user"
   * runtime.normalizePath("~/project", "~") // => "~/project"
   */
  normalizePath(targetPath: string, basePath: string): string;

  /**
   * Compute absolute workspace path from project and workspace name.
   * This is the SINGLE source of truth for workspace path computation.
   *
   * - LocalRuntime: {workdir}/{project-name}/{workspace-name}
   * - SSHRuntime: {workdir}/{project-name}/{workspace-name}
   *
   * All Runtime methods (create, delete, rename) MUST use this method internally
   * to ensure consistent path computation.
   *
   * @param projectPath Project root path (local path, used to extract project name)
   * @param workspaceName Workspace name (typically branch name)
   * @returns Absolute path to workspace directory
   */
  getWorkspacePath(projectPath: string, workspaceName: string): string;

  /**
   * Create a workspace for this runtime (fast, returns immediately)
   * - LocalRuntime: Creates git worktree
   * - SSHRuntime: Creates remote directory only
   * Does NOT run init hook or sync files.
   * @param params Workspace creation parameters
   * @returns Result with workspace path or error
   */
  createWorkspace(params: WorkspaceCreationParams): Promise<WorkspaceCreationResult>;

  /**
   * Initialize workspace asynchronously (may be slow, streams progress)
   * - LocalRuntime: Runs init hook if present
   * - SSHRuntime: Syncs files, checks out branch, runs init hook
   * Streams progress via initLogger.
   * @param params Workspace initialization parameters
   * @returns Result indicating success or error
   */
  initWorkspace(params: WorkspaceInitParams): Promise<WorkspaceInitResult>;

  /**
   * Rename workspace directory
   * - LocalRuntime: Uses git worktree move (worktrees managed by git)
   * - SSHRuntime: Uses mv (plain directories on remote, not worktrees)
   * Runtime computes workspace paths internally from workdir + projectPath + workspace names.
   * @param projectPath Project root path (local path, used for git commands in LocalRuntime and to extract project name)
   * @param oldName Current workspace name
   * @param newName New workspace name
   * @param abortSignal Optional abort signal for cancellation
   * @returns Promise resolving to Result with old/new paths on success, or error message
   */
  renameWorkspace(
    projectPath: string,
    oldName: string,
    newName: string,
    abortSignal?: AbortSignal
  ): Promise<
    { success: true; oldPath: string; newPath: string } | { success: false; error: string }
  >;

  /**
   * Delete workspace directory
   * - LocalRuntime: Uses git worktree remove (with --force only if force param is true)
   * - SSHRuntime: Checks for uncommitted changes unless force is true, then uses rm -rf
   * Runtime computes workspace path internally from workdir + projectPath + workspaceName.
   *
   * **CRITICAL: Implementations must NEVER auto-apply --force or skip dirty checks without explicit force=true.**
   * If workspace has uncommitted changes and force=false, implementations MUST return error.
   * The force flag is the user's explicit intent - implementations must not override it.
   *
   * @param projectPath Project root path (local path, used for git commands in LocalRuntime and to extract project name)
   * @param workspaceName Workspace name to delete
   * @param force If true, force deletion even with uncommitted changes or special conditions (submodules, etc.)
   * @param abortSignal Optional abort signal for cancellation
   * @returns Promise resolving to Result with deleted path on success, or error message
   */
  deleteWorkspace(
    projectPath: string,
    workspaceName: string,
    force: boolean,
    abortSignal?: AbortSignal
  ): Promise<{ success: true; deletedPath: string } | { success: false; error: string }>;

  /**
   * Ensure the runtime is ready for operations.
   * - LocalRuntime: Always returns ready (no-op)
   * - DockerRuntime: Starts container if stopped
   * - SSHRuntime: Could verify connection (future)
   *
   * Called automatically by executeBash handler before first operation.
   */
  ensureReady(): Promise<{ ready: boolean; error?: string }>;

  /**
   * Fork an existing workspace to create a new one
   * Creates a new workspace branching from the source workspace's current branch
   * - LocalRuntime: Detects source branch via git, creates new worktree from that branch
   * - SSHRuntime: Currently unimplemented (returns static error)
   *
   * @param params Fork parameters (source workspace name, new workspace name, etc.)
   * @returns Result with new workspace path and source branch, or error
   */
  forkWorkspace(params: WorkspaceForkParams): Promise<WorkspaceForkResult>;

  /**
   * Get the runtime's temp directory (absolute path, resolved).
   * - LocalRuntime: /tmp (or OS temp dir)
   * - SSHRuntime: Resolved remote temp dir (e.g., /tmp)
   *
   * Used for background process output, temporary files, etc.
   */
  tempDir(): Promise<string>;

  /**
   * Get the mux home directory for this runtime.
   * Used for storing plan files and other mux-specific data.
   * - LocalRuntime/SSHRuntime: ~/.mux (tilde expanded by runtime)
   * - DockerRuntime: /var/mux (world-readable, avoids /root permission issues)
   */
  getMuxHome(): string;
}

/**
 * Result of checking if a runtime type is available for a project.
 */
export type RuntimeAvailability = { available: true } | { available: false; reason: string };

/**
 * Error thrown by runtime implementations
 */
export class RuntimeError extends Error {
  constructor(
    message: string,
    public readonly type: "exec" | "file_io" | "network" | "unknown",
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}
