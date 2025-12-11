/**
 * Docker runtime implementation that executes commands inside Docker containers.
 *
 * Features:
 * - Each workspace runs in its own container
 * - Container name derived from project+workspace name
 * - Uses docker exec for command execution
 * - Hardcoded paths: srcBaseDir=/src, bgOutputDir=/tmp/mux-bashes
 * - Managed lifecycle: container created/destroyed with workspace
 *
 * Extends RemoteRuntime for shared exec/file operations.
 */

import { spawn, exec } from "child_process";
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
import { RuntimeError } from "./Runtime";
import { RemoteRuntime, type SpawnResult } from "./RemoteRuntime";
import { checkInitHookExists, getMuxEnv, runInitHookOnRuntime } from "./initHook";
import { getProjectName } from "@/node/utils/runtime/helpers";
import { getErrorMessage } from "@/common/utils/errors";
import { syncProjectViaGitBundle } from "./gitBundleSync";
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
 * Extends RemoteRuntime for shared exec/file operations.
 */
export class DockerRuntime extends RemoteRuntime {
  private readonly config: DockerRuntimeConfig;
  /** Container name - set during construction (for existing) or createWorkspace (for new) */
  private containerName?: string;

  constructor(config: DockerRuntimeConfig) {
    super();
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

  // ===== RemoteRuntime abstract method implementations =====

  protected readonly commandPrefix = "Docker";

  protected getBasePath(): string {
    return CONTAINER_SRC_DIR;
  }

  protected quoteForRemote(filePath: string): string {
    return shescape.quote(filePath);
  }

  protected cdCommand(cwd: string): string {
    return `cd ${shescape.quote(cwd)}`;
  }

  protected spawnRemoteProcess(fullCommand: string, options: ExecOptions): SpawnResult {
    // Verify container name is available
    if (!this.containerName) {
      throw new RuntimeError(
        "Docker runtime not initialized with container name. " +
          "For existing workspaces, pass containerName in config. " +
          "For new workspaces, call createWorkspace first.",
        "exec"
      );
    }

    // Build docker exec args
    const dockerArgs: string[] = ["exec", "-i"];

    // Add environment variables directly to docker exec
    const envVars = { ...options.env };
    for (const [key, value] of Object.entries(envVars)) {
      dockerArgs.push("-e", `${key}=${value}`);
    }

    dockerArgs.push(this.containerName, "bash", "-c", fullCommand);

    // Spawn docker exec command
    const process = spawn("docker", dockerArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    return { process };
  }

  /**
   * Override buildWriteCommand to preserve symlinks and file permissions.
   *
   * This matches SSHRuntime behavior: write through the symlink to the final target,
   * while keeping the symlink itself intact.
   */
  protected buildWriteCommand(quotedPath: string, quotedTempPath: string): string {
    return `RESOLVED=$(readlink -f ${quotedPath} 2>/dev/null || echo ${quotedPath}) && PERMS=$(stat -c '%a' "$RESOLVED" 2>/dev/null || echo 600) && mkdir -p $(dirname "$RESOLVED") && cat > ${quotedTempPath} && chmod "$PERMS" ${quotedTempPath} && mv ${quotedTempPath} "$RESOLVED"`;
  }
  // ===== Runtime interface implementations =====

  resolvePath(filePath: string): Promise<string> {
    // DockerRuntime uses a fixed workspace base (/src), but we still want reasonable shell-style
    // behavior for callers that pass "~" or "~/...".
    if (filePath === "~") {
      return Promise.resolve("/root");
    }
    if (filePath.startsWith("~/")) {
      return Promise.resolve(path.posix.join("/root", filePath.slice(2)));
    }

    return Promise.resolve(
      filePath.startsWith("/") ? filePath : path.posix.join(CONTAINER_SRC_DIR, filePath)
    );
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
    const timestamp = Date.now();
    const remoteBundlePath = `/tmp/mux-bundle-${timestamp}.bundle`;
    const localBundlePath = `/tmp/mux-bundle-${timestamp}.bundle`;

    await syncProjectViaGitBundle({
      projectPath,
      workspacePath,
      remoteTmpDir: "/tmp",
      remoteBundlePath,
      exec: (command, options) => this.exec(command, options),
      quoteRemotePath: (path) => this.quoteForRemote(path),
      initLogger,
      abortSignal,
      cloneStep: "Cloning repository in container...",
      createRemoteBundle: async ({ remoteBundlePath, initLogger, abortSignal }) => {
        try {
          if (abortSignal?.aborted) {
            throw new Error("Sync operation aborted before starting");
          }

          const bundleResult = await runDockerCommand(
            `git -C "${projectPath}" bundle create "${localBundlePath}" --all`,
            300000
          );

          if (bundleResult.exitCode !== 0) {
            throw new Error(`Failed to create bundle: ${bundleResult.stderr}`);
          }

          initLogger.logStep("Copying bundle to container...");
          const copyResult = await runDockerCommand(
            `docker cp "${localBundlePath}" ${containerName}:${remoteBundlePath}`,
            300000
          );

          if (copyResult.exitCode !== 0) {
            throw new Error(`Failed to copy bundle: ${copyResult.stderr}`);
          }

          return {
            cleanupLocal: async () => {
              await runDockerCommand(`rm -f "${localBundlePath}"`, 5000);
            },
          };
        } catch (error) {
          await runDockerCommand(`rm -f "${localBundlePath}"`, 5000);
          throw error;
        }
      },
    });
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
}
