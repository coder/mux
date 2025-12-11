/**
 * Docker runtime implementation that executes commands inside Docker containers.
 *
 * Features:
 * - Each workspace runs in its own container
 * - Container name derived from project+workspace name
 * - Uses docker exec for command execution
 * - Hardcoded paths: srcBaseDir=/src, bgOutputDir=/tmp/mux-bashes
 * - Managed lifecycle: container created/destroyed with workspace
 */

import { spawn, exec } from "child_process";
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
import { RuntimeError } from "./Runtime";
import { EXIT_CODE_ABORTED, EXIT_CODE_TIMEOUT } from "@/common/constants/exitCodes";
import { log } from "@/node/services/log";
import { checkInitHookExists, getMuxEnv, runInitHookOnRuntime } from "./initHook";
import { NON_INTERACTIVE_ENV_VARS } from "@/common/constants/env";
import { getProjectName } from "@/node/utils/runtime/helpers";
import { getErrorMessage } from "@/common/utils/errors";
import { DisposableProcess } from "@/node/utils/disposableExec";
import { streamToString, shescape } from "./streamUtils";

/** Hardcoded source directory inside container */
const CONTAINER_SRC_DIR = "/src";

/** Hardcoded background output directory inside container */
const _CONTAINER_BG_OUTPUT_DIR = "/tmp/mux-bashes";

/**
 * Result of running a Docker command
 */
interface DockerCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a Docker CLI command and return result.
 * Unlike execAsync, this always resolves (never rejects) and returns exit code.
 */
function runDockerCommand(command: string, timeoutMs = 30000): Promise<DockerCommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = exec(command);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      resolve({ exitCode: -1, stdout, stderr: "Command timed out" });
    }, timeoutMs);

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (timedOut) return;
      resolve({ exitCode: -1, stdout, stderr: err.message });
    });
  });
}

export interface DockerRuntimeConfig {
  /** Docker image to use (e.g., ubuntu:22.04) */
  image: string;
  /**
   * Container name for existing workspaces.
   * When creating a new workspace, this is computed during createWorkspace().
   * When recreating runtime for an existing workspace, this should be passed
   * to allow exec operations without calling createWorkspace again.
   */
  containerName?: string;
}

/**
 * Sanitize a string for use in Docker container names.
 * Docker names must match: [a-zA-Z0-9][a-zA-Z0-9_.-]*
 */
function sanitizeContainerName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .replace(/-+/g, "-")
    .slice(0, 63); // Docker has a 64 char limit
}

/**
 * Generate container name from project path and workspace name.
 * Format: mux-{projectName}-{workspaceName}
 */
export function getContainerName(projectPath: string, workspaceName: string): string {
  const projectName = getProjectName(projectPath);
  return sanitizeContainerName(`mux-${projectName}-${workspaceName}`);
}

/**
 * Docker runtime implementation that executes commands inside Docker containers.
 */
export class DockerRuntime implements Runtime {
  private readonly config: DockerRuntimeConfig;
  /** Container name - set during construction (for existing) or createWorkspace (for new) */
  private containerName?: string;

  constructor(config: DockerRuntimeConfig) {
    this.config = config;
    // If container name is provided (existing workspace), store it
    if (config.containerName) {
      this.containerName = config.containerName;
    }
  }

  /**
   * Get Docker image name
   */
  public getImage(): string {
    return this.config.image;
  }

  /**
   * Execute command inside Docker container with streaming I/O
   */
  exec(command: string, options: ExecOptions): Promise<ExecStream> {
    const startTime = performance.now();

    // Short-circuit if already aborted
    if (options.abortSignal?.aborted) {
      throw new RuntimeError("Operation aborted before execution", "exec");
    }

    // Verify container name is available (set in constructor for existing workspaces,
    // or set in createWorkspace for new workspaces)
    if (!this.containerName) {
      throw new RuntimeError(
        "Docker runtime not initialized with container name. " +
          "For existing workspaces, pass containerName in config. " +
          "For new workspaces, call createWorkspace first.",
        "exec"
      );
    }
    const containerName = this.containerName;

    // Build command parts
    const parts: string[] = [];

    // Add cd command if cwd is specified
    parts.push(`cd ${shescape.quote(options.cwd)}`);

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

    // Build docker exec args
    const dockerArgs: string[] = ["exec", "-i"];

    // Add environment variables directly to docker exec
    for (const [key, value] of Object.entries(envVars)) {
      dockerArgs.push("-e", `${key}=${value}`);
    }

    dockerArgs.push(containerName, "bash", "-c", fullCommand);

    log.debug(`Docker command: docker ${dockerArgs.join(" ")}`);

    // Spawn docker exec command
    const dockerProcess = spawn("docker", dockerArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    // Wrap in DisposableProcess for automatic cleanup
    const disposable = new DisposableProcess(dockerProcess);

    // Convert Node.js streams to Web Streams
    const stdout = Readable.toWeb(dockerProcess.stdout) as unknown as ReadableStream<Uint8Array>;
    const stderr = Readable.toWeb(dockerProcess.stderr) as unknown as ReadableStream<Uint8Array>;
    const stdin = Writable.toWeb(dockerProcess.stdin) as unknown as WritableStream<Uint8Array>;

    // Track if we killed the process due to timeout or abort
    let timedOut = false;
    let aborted = false;

    // Create promises for exit code and duration
    const exitCode = new Promise<number>((resolve, reject) => {
      dockerProcess.on("close", (code, signal) => {
        if (aborted || options.abortSignal?.aborted) {
          resolve(EXIT_CODE_ABORTED);
          return;
        }
        if (timedOut) {
          resolve(EXIT_CODE_TIMEOUT);
          return;
        }
        resolve(code ?? (signal ? -1 : 0));
      });

      dockerProcess.on("error", (err) => {
        reject(new RuntimeError(`Failed to execute Docker command: ${err.message}`, "exec", err));
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

    return Promise.resolve({ stdout, stderr, stdin, exitCode, duration });
  }

  /**
   * Read file contents from container as a stream
   */
  readFile(filePath: string, abortSignal?: AbortSignal): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start: async (controller: ReadableStreamDefaultController<Uint8Array>) => {
        try {
          const stream = await this.exec(`cat ${shescape.quote(filePath)}`, {
            cwd: CONTAINER_SRC_DIR,
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
   * Write file contents to container atomically from a stream
   */
  writeFile(filePath: string, abortSignal?: AbortSignal): WritableStream<Uint8Array> {
    const tempPath = `${filePath}.tmp.${Date.now()}`;
    const writeCommand = `mkdir -p $(dirname ${shescape.quote(filePath)}) && cat > ${shescape.quote(tempPath)} && mv ${shescape.quote(tempPath)} ${shescape.quote(filePath)}`;

    let execPromise: Promise<ExecStream> | null = null;

    const getExecStream = () => {
      execPromise ??= this.exec(writeCommand, {
        cwd: CONTAINER_SRC_DIR,
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
   * Get file statistics from container
   */
  async stat(filePath: string, abortSignal?: AbortSignal): Promise<FileStat> {
    const stream = await this.exec(`stat -c '%s %Y %F' ${shescape.quote(filePath)}`, {
      cwd: CONTAINER_SRC_DIR,
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

  resolvePath(filePath: string): Promise<string> {
    // Inside container, paths are already absolute
    // Just return as-is since we use fixed /src path
    return Promise.resolve(
      filePath.startsWith("/") ? filePath : path.posix.join(CONTAINER_SRC_DIR, filePath)
    );
  }

  normalizePath(targetPath: string, basePath: string): string {
    const target = targetPath.trim();
    let base = basePath.trim();

    if (base.length > 1 && base.endsWith("/")) {
      base = base.slice(0, -1);
    }

    if (target === ".") {
      return base;
    }

    if (target.startsWith("/")) {
      return target;
    }

    return base.endsWith("/") ? base + target : base + "/" + target;
  }

  getWorkspacePath(_projectPath: string, _workspaceName: string): string {
    // For Docker, workspace path is always /src inside the container
    return CONTAINER_SRC_DIR;
  }

  async createWorkspace(params: WorkspaceCreationParams): Promise<WorkspaceCreationResult> {
    try {
      const { projectPath, branchName, initLogger } = params;

      // Generate container name
      const containerName = getContainerName(projectPath, branchName);

      initLogger.logStep(`Creating Docker container: ${containerName}...`);

      // Check if container already exists
      const checkResult = await runDockerCommand(`docker inspect ${containerName}`, 10000);
      if (checkResult.exitCode === 0) {
        return {
          success: false,
          error: `Workspace already exists: container ${containerName} is running`,
        };
      }

      // Create and start container
      // Use sleep infinity to keep container running
      const runCmd = `docker run -d --name ${containerName} ${this.config.image} sleep infinity`;

      initLogger.logStep(`Starting container with image ${this.config.image}...`);

      const runResult = await runDockerCommand(runCmd, 60000);

      if (runResult.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to create container: ${runResult.stderr}`,
        };
      }

      // Create /src directory in container
      initLogger.logStep("Preparing workspace directory...");
      const mkdirResult = await runDockerCommand(
        `docker exec ${containerName} mkdir -p ${CONTAINER_SRC_DIR}`,
        10000
      );

      if (mkdirResult.exitCode !== 0) {
        // Clean up container on failure
        await runDockerCommand(`docker rm -f ${containerName}`, 10000);
        return {
          success: false,
          error: `Failed to create workspace directory: ${mkdirResult.stderr}`,
        };
      }

      // Store container name on runtime instance for exec operations
      this.containerName = containerName;

      initLogger.logStep("Container created successfully");

      return {
        success: true,
        workspacePath: CONTAINER_SRC_DIR,
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
      if (!this.containerName) {
        return {
          success: false,
          error: "Container not initialized. Call createWorkspace first.",
        };
      }
      const containerName = this.containerName;

      // 1. Sync project to container using git bundle + docker cp
      initLogger.logStep("Syncing project files to container...");
      try {
        await this.syncProjectToContainer(
          projectPath,
          containerName,
          workspacePath,
          initLogger,
          abortSignal
        );
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

      // 2. Checkout branch
      initLogger.logStep(`Checking out branch: ${branchName}`);
      const checkoutCmd = `git checkout ${shescape.quote(branchName)} 2>/dev/null || git checkout -b ${shescape.quote(branchName)} ${shescape.quote(trunkBranch)}`;

      const checkoutStream = await this.exec(checkoutCmd, {
        cwd: workspacePath,
        timeout: 300,
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

      // 3. Run .mux/init hook if it exists
      const hookExists = await checkInitHookExists(projectPath);
      if (hookExists) {
        const muxEnv = getMuxEnv(projectPath, "docker", branchName);
        const hookPath = `${workspacePath}/.mux/init`;
        await runInitHookOnRuntime(this, hookPath, workspacePath, muxEnv, initLogger, abortSignal);
      } else {
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
   * Sync project to container using git bundle
   */
  private async syncProjectToContainer(
    projectPath: string,
    containerName: string,
    workspacePath: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (abortSignal?.aborted) {
      throw new Error("Sync operation aborted before starting");
    }

    const timestamp = Date.now();
    const bundlePath = `/tmp/mux-bundle-${timestamp}.bundle`;
    const localBundlePath = `/tmp/mux-bundle-${timestamp}.bundle`;

    try {
      // Step 1: Get origin URL from local repository
      let originUrl: string | null = null;
      const originResult = await runDockerCommand(
        `cd ${shescape.quote(projectPath)} && git remote get-url origin 2>/dev/null || true`,
        10000
      );
      if (originResult.exitCode === 0) {
        const url = originResult.stdout.trim();
        if (url && !url.includes(".bundle") && !url.includes(".mux-bundle")) {
          originUrl = url;
        }
      }

      // Step 2: Create bundle locally
      initLogger.logStep("Creating git bundle...");
      const bundleResult = await runDockerCommand(
        `cd ${shescape.quote(projectPath)} && git bundle create ${localBundlePath} --all`,
        300000
      );

      if (bundleResult.exitCode !== 0) {
        throw new Error(`Failed to create bundle: ${bundleResult.stderr}`);
      }

      // Step 3: Copy bundle to container
      initLogger.logStep("Copying bundle to container...");
      const copyResult = await runDockerCommand(
        `docker cp ${localBundlePath} ${containerName}:${bundlePath}`,
        300000
      );

      if (copyResult.exitCode !== 0) {
        throw new Error(`Failed to copy bundle: ${copyResult.stderr}`);
      }

      // Step 4: Clone from bundle inside container
      initLogger.logStep("Cloning repository in container...");
      const cloneStream = await this.exec(`git clone --quiet ${bundlePath} ${workspacePath}`, {
        cwd: "/tmp",
        timeout: 300,
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

      // Step 5: Create local tracking branches
      initLogger.logStep("Creating local tracking branches...");
      const trackingStream = await this.exec(
        `cd ${workspacePath} && for branch in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin/ | grep -v 'origin/HEAD'); do localname=\${branch#origin/}; git show-ref --verify --quiet refs/heads/$localname || git branch $localname $branch; done`,
        {
          cwd: workspacePath,
          timeout: 30,
          abortSignal,
        }
      );
      await trackingStream.exitCode;

      // Step 6: Update origin remote
      if (originUrl) {
        initLogger.logStep(`Setting origin remote to ${originUrl}...`);
        const setOriginStream = await this.exec(
          `git -C ${workspacePath} remote set-url origin ${shescape.quote(originUrl)}`,
          {
            cwd: workspacePath,
            timeout: 10,
            abortSignal,
          }
        );
        await setOriginStream.exitCode;
      } else {
        initLogger.logStep("Removing bundle origin remote...");
        const removeOriginStream = await this.exec(
          `git -C ${workspacePath} remote remove origin 2>/dev/null || true`,
          {
            cwd: workspacePath,
            timeout: 10,
            abortSignal,
          }
        );
        await removeOriginStream.exitCode;
      }

      // Step 7: Clean up bundle files
      initLogger.logStep("Cleaning up bundle file...");
      const rmStream = await this.exec(`rm ${bundlePath}`, {
        cwd: "/tmp",
        timeout: 10,
        abortSignal,
      });
      await rmStream.exitCode;

      // Clean up local bundle
      await runDockerCommand(`rm ${localBundlePath}`, 5000);

      initLogger.logStep("Repository cloned successfully");
    } catch (error) {
      // Try to clean up on error
      try {
        const rmStream = await this.exec(`rm -f ${bundlePath}`, {
          cwd: "/tmp",
          timeout: 10,
        });
        await rmStream.exitCode;
      } catch {
        // Ignore cleanup errors
      }
      await runDockerCommand(`rm -f ${localBundlePath}`, 5000);

      throw error;
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async renameWorkspace(
    _projectPath: string,
    _oldName: string,
    _newName: string,
    _abortSignal?: AbortSignal
  ): Promise<
    { success: true; oldPath: string; newPath: string } | { success: false; error: string }
  > {
    // For Docker, renaming means:
    // 1. Create new container with new name
    // 2. Copy /src from old container to new
    // 3. Remove old container
    // This is complex and error-prone, so we don't support it for now
    return {
      success: false,
      error:
        "Renaming Docker workspaces is not supported. Create a new workspace and delete the old one.",
    };
  }

  async deleteWorkspace(
    projectPath: string,
    workspaceName: string,
    force: boolean,
    abortSignal?: AbortSignal
  ): Promise<{ success: true; deletedPath: string } | { success: false; error: string }> {
    if (abortSignal?.aborted) {
      return { success: false, error: "Delete operation aborted" };
    }

    const containerName = getContainerName(projectPath, workspaceName);
    const deletedPath = CONTAINER_SRC_DIR;

    try {
      // Check if container exists
      const inspectResult = await runDockerCommand(`docker inspect ${containerName}`, 10000);

      if (inspectResult.exitCode !== 0) {
        // Container doesn't exist - deletion is idempotent
        return { success: true, deletedPath };
      }

      if (!force) {
        // Check for uncommitted changes
        const checkResult = await runDockerCommand(
          `docker exec ${containerName} bash -c 'cd ${CONTAINER_SRC_DIR} && git diff --quiet --exit-code && git diff --quiet --cached --exit-code'`,
          10000
        );

        if (checkResult.exitCode !== 0) {
          return {
            success: false,
            error: "Workspace contains uncommitted changes. Use force flag to delete anyway.",
          };
        }

        // Check for unpushed commits
        const unpushedResult = await runDockerCommand(
          `docker exec ${containerName} bash -c 'cd ${CONTAINER_SRC_DIR} && git log --branches --not --remotes --oneline'`,
          10000
        );

        if (unpushedResult.exitCode === 0 && unpushedResult.stdout.trim()) {
          return {
            success: false,
            error: `Workspace contains unpushed commits:\n\n${unpushedResult.stdout.trim()}`,
          };
        }
      }

      // Stop and remove container
      const rmResult = await runDockerCommand(`docker rm -f ${containerName}`, 30000);

      if (rmResult.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to remove container: ${rmResult.stderr}`,
        };
      }

      return { success: true, deletedPath };
    } catch (error) {
      return { success: false, error: `Failed to delete workspace: ${getErrorMessage(error)}` };
    }
  }

  forkWorkspace(_params: WorkspaceForkParams): Promise<WorkspaceForkResult> {
    return Promise.resolve({
      success: false,
      error: "Forking Docker workspaces is not yet implemented. Create a new workspace instead.",
    });
  }

  tempDir(): Promise<string> {
    return Promise.resolve("/tmp");
  }
}
