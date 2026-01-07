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
import { createHash } from "crypto";
import * as path from "path";
import * as fs from "fs/promises";
import { existsSync } from "fs";
import * as os from "os";
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

/**
 * Run a command with array args (no shell interpolation).
 * Similar to runDockerCommand but safer for paths with special characters.
 */
function runSpawnCommand(
  command: string,
  args: string[],
  timeoutMs = 30000
): Promise<DockerCommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(command, args);

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

/**
 * Build Docker args for credential sharing.
 * Forwards SSH agent into the container.
 * Note: ~/.gitconfig is copied (not mounted) after container creation so gh can modify it.
 * Uses agent forwarding only (no ~/.ssh mount) to avoid passphrase/permission issues.
 */
function buildCredentialArgs(): string[] {
  const args: string[] = [];

  // SSH agent forwarding (no ~/.ssh mount - causes passphrase/permission issues)
  if (process.platform === "darwin") {
    // macOS Docker Desktop uses a magic socket path
    args.push("-v", "/run/host-services/ssh-auth.sock:/ssh-agent:ro");
    args.push("-e", "SSH_AUTH_SOCK=/ssh-agent");
  } else if (process.env.SSH_AUTH_SOCK && existsSync(process.env.SSH_AUTH_SOCK)) {
    args.push("-v", `${process.env.SSH_AUTH_SOCK}:/ssh-agent:ro`);
    args.push("-e", "SSH_AUTH_SOCK=/ssh-agent");
  }

  // GitHub CLI auth via token
  if (process.env.GH_TOKEN) {
    args.push("-e", `GH_TOKEN=${process.env.GH_TOKEN}`);
  }

  return args;
}

/**
 * Run docker run with streaming output (for image pull progress).
 * Streams stdout/stderr to initLogger for visibility during image pulls.
 */
function streamDockerRun(
  containerName: string,
  image: string,
  initLogger: InitLogger,
  options?: { abortSignal?: AbortSignal; shareCredentials?: boolean; timeoutMs?: number }
): Promise<DockerCommandResult> {
  const { abortSignal, shareCredentials, timeoutMs = 600000 } = options ?? {};

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let resolved = false;

    const finish = (result: DockerCommandResult) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", abortHandler);
      resolve(result);
    };

    // Build docker run args
    const dockerArgs = ["run", "-d", "--name", containerName];
    if (shareCredentials) {
      dockerArgs.push(...buildCredentialArgs());
    }
    dockerArgs.push(image, "sleep", "infinity");

    // Use spawn for streaming output - array args don't need shell escaping
    const child = spawn("docker", dockerArgs);

    const timer = setTimeout(() => {
      child.kill();
      void runDockerCommand(`docker rm -f ${containerName}`, 10000);
      finish({ exitCode: -1, stdout, stderr: "Container creation timed out" });
    }, timeoutMs);

    const abortHandler = () => {
      child.kill();
      // Container might have been created before abort - clean it up
      void runDockerCommand(`docker rm -f ${containerName}`, 10000);
      finish({ exitCode: -1, stdout, stderr: "Aborted" });
    };
    abortSignal?.addEventListener("abort", abortHandler);

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      // docker run -d outputs container ID to stdout, not useful to stream
    });

    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      // Stream pull progress to init logger
      for (const line of text.split("\n").filter((l) => l.trim())) {
        initLogger.logStdout(line);
      }
    });

    child.on("close", (code) => {
      finish({ exitCode: code ?? -1, stdout, stderr });
    });

    child.on("error", (err) => {
      finish({ exitCode: -1, stdout, stderr: err.message });
    });
  });
}

export interface DockerRuntimeConfig {
  /** Docker image to use (e.g., node:20) */
  image: string;
  /**
   * Container name for existing workspaces.
   * When creating a new workspace, this is computed during createWorkspace().
   * When recreating runtime for an existing workspace, this should be passed
   * to allow exec operations without calling createWorkspace again.
   */
  containerName?: string;
  /** Forward SSH agent and mount ~/.gitconfig read-only into container */
  shareCredentials?: boolean;
}

/**
 * Sanitize a string for use in Docker container names.
 * Docker names must match: [a-zA-Z0-9][a-zA-Z0-9_.-]*
 */
function sanitizeContainerName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .replace(/-+/g, "-");
}

/**
 * Generate container name from project path and workspace name.
 * Format: mux-{projectName}-{workspaceName}-{hash}
 * Hash suffix prevents collisions (e.g., feature/foo vs feature-foo)
 */
export function getContainerName(projectPath: string, workspaceName: string): string {
  const projectName = getProjectName(projectPath);
  const hash = createHash("sha256")
    .update(`${projectPath}:${workspaceName}`)
    .digest("hex")
    .slice(0, 6);
  // Reserve 7 chars for "-{hash}", leaving 56 for base
  const base = sanitizeContainerName(`mux-${projectName}-${workspaceName}`).slice(0, 56);
  return `${base}-${hash}`;
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
   * Get the container name (if set)
   */
  public getContainerName(): string | undefined {
    return this.containerName;
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
    // Expand ~ to /root since container runs as root
    const expanded = filePath.startsWith("~/")
      ? `/root/${filePath.slice(2)}`
      : filePath === "~"
        ? "/root"
        : filePath;
    return shescape.quote(expanded);
  }

  protected cdCommand(cwd: string): string {
    return `cd ${shescape.quote(cwd)}`;
  }

  protected spawnRemoteProcess(fullCommand: string, _options: ExecOptions): Promise<SpawnResult> {
    // Verify container name is available
    if (!this.containerName) {
      throw new RuntimeError(
        "Docker runtime not initialized with container name. " +
          "For existing workspaces, pass containerName in config. " +
          "For new workspaces, call createWorkspace first.",
        "exec"
      );
    }

    // Build docker exec args.
    //
    // Note: RemoteRuntime.exec() injects env vars via `export ...`, so we don't need `docker exec -e`
    // here (and avoiding `-e` keeps quoting behavior consistent with SSH).
    const dockerArgs: string[] = ["exec", "-i", this.containerName, "bash", "-c", fullCommand];

    // Spawn docker exec command
    const process = spawn("docker", dockerArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    return Promise.resolve({ process });
  }

  /**
   * Override buildWriteCommand to preserve symlinks and file permissions.
   *
   * This matches SSHRuntime behavior: write through the symlink to the final target,
   * while keeping the symlink itself intact.
   */
  protected buildWriteCommand(quotedPath: string, quotedTempPath: string): string {
    // Default to 644 (world-readable) for new files, particularly important for
    // plan files in /var/mux which need to be readable by VS Code Dev Containers
    return `RESOLVED=$(readlink -f ${quotedPath} 2>/dev/null || echo ${quotedPath}) && PERMS=$(stat -c '%a' "$RESOLVED" 2>/dev/null || echo 644) && mkdir -p $(dirname "$RESOLVED") && cat > ${quotedTempPath} && chmod "$PERMS" ${quotedTempPath} && mv ${quotedTempPath} "$RESOLVED"`;
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
    const { projectPath, branchName } = params;

    // Generate container name and check for collisions before persisting metadata
    const containerName = getContainerName(projectPath, branchName);

    // Check if container already exists (collision detection)
    const checkResult = await runDockerCommand(`docker inspect ${containerName}`, 10000);
    if (checkResult.exitCode === 0) {
      return {
        success: false,
        error: `Workspace already exists: container ${containerName}`,
      };
    }
    // Distinguish "container doesn't exist" from actual Docker errors
    if (!checkResult.stderr.toLowerCase().includes("no such object")) {
      return {
        success: false,
        error: `Docker error: ${checkResult.stderr || checkResult.stdout || "unknown error"}`,
      };
    }

    // Store container name - actual container creation happens in initWorkspace
    // so that image pull progress is visible in the init section
    this.containerName = containerName;

    return {
      success: true,
      workspacePath: CONTAINER_SRC_DIR,
    };
  }

  async initWorkspace(params: WorkspaceInitParams): Promise<WorkspaceInitResult> {
    const { projectPath, branchName, trunkBranch, workspacePath, initLogger, abortSignal, env } =
      params;

    try {
      if (!this.containerName) {
        return {
          success: false,
          error: "Container not initialized. Call createWorkspace first.",
        };
      }
      const containerName = this.containerName;

      // 1. Create container (with image pull if needed)
      initLogger.logStep(`Creating container from ${this.config.image}...`);

      // Check if container already exists (e.g., from aborted previous attempt)
      const checkResult = await runDockerCommand(`docker inspect ${containerName}`, 10000);
      if (checkResult.exitCode === 0) {
        // Container exists - check if running
        const isRunning = await runDockerCommand(
          `docker inspect -f '{{.State.Running}}' ${containerName}`,
          10000
        );
        if (isRunning.exitCode === 0 && isRunning.stdout.trim() === "true") {
          initLogger.logStderr(`Container ${containerName} already exists and is running`);
          initLogger.logComplete(-1);
          return {
            success: false,
            error: `Workspace already exists: container ${containerName}`,
          };
        }
        // Stopped/dead container from app crash or unexpected termination - clean up
        initLogger.logStep("Removing stale container from previous attempt...");
        await runDockerCommand(`docker rm -f ${containerName}`, 10000);
      }

      if (abortSignal?.aborted) {
        initLogger.logComplete(-1);
        return { success: false, error: "Workspace creation aborted" };
      }

      // Create and start container with streaming output for image pull progress
      const runResult = await streamDockerRun(containerName, this.config.image, initLogger, {
        abortSignal,
        shareCredentials: this.config.shareCredentials,
      });
      if (runResult.exitCode !== 0) {
        initLogger.logStderr(`Failed to create container: ${runResult.stderr}`);
        initLogger.logComplete(-1);
        return {
          success: false,
          error: `Failed to create container: ${runResult.stderr}`,
        };
      }

      // Create /src directory and /var/mux/plans in container
      // /var/mux is used instead of ~/.mux because /root has 700 permissions,
      // which makes it inaccessible to VS Code Dev Containers (non-root user)
      initLogger.logStep("Preparing workspace directory...");
      const mkdirResult = await runDockerCommand(
        `docker exec ${containerName} mkdir -p ${CONTAINER_SRC_DIR} /var/mux/plans`,
        10000
      );
      if (mkdirResult.exitCode !== 0) {
        await runDockerCommand(`docker rm -f ${containerName}`, 10000);
        initLogger.logStderr(`Failed to create workspace directory: ${mkdirResult.stderr}`);
        initLogger.logComplete(-1);
        return {
          success: false,
          error: `Failed to create workspace directory: ${mkdirResult.stderr}`,
        };
      }

      initLogger.logStep("Container ready");

      // Copy host gitconfig into container (not mounted, so gh can modify it)
      if (this.config.shareCredentials) {
        const gitconfig = path.join(os.homedir(), ".gitconfig");
        if (existsSync(gitconfig)) {
          await runDockerCommand(`docker cp ${gitconfig} ${containerName}:/root/.gitconfig`, 10000);
        }
      }

      // Configure gh CLI as git credential helper if GH_TOKEN is available
      // GH_TOKEN can come from project secrets (env) or host environment (buildCredentialArgs)
      const ghToken = env?.GH_TOKEN ?? process.env.GH_TOKEN;
      if (this.config.shareCredentials && ghToken) {
        await runDockerCommand(
          `docker exec -e GH_TOKEN=${shescape.quote(ghToken)} ${containerName} sh -c 'command -v gh >/dev/null && gh auth setup-git || true'`,
          10000
        );
      }

      // 2. Sync project to container using git bundle + docker cp
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
        // Clean up container on failure
        await runDockerCommand(`docker rm -f ${containerName}`, 10000);
        return {
          success: false,
          error: `Failed to sync project: ${errorMsg}`,
        };
      }
      initLogger.logStep("Files synced successfully");

      // 3. Checkout branch
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
        // Clean up container on failure
        await runDockerCommand(`docker rm -f ${containerName}`, 10000);
        return {
          success: false,
          error: errorMsg,
        };
      }
      initLogger.logStep("Branch checked out successfully");

      // 4. Run .mux/init hook if it exists
      const hookExists = await checkInitHookExists(projectPath);
      if (hookExists) {
        const muxEnv = { ...env, ...getMuxEnv(projectPath, "docker", branchName) };
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
      // Clean up container on failure
      if (this.containerName) {
        await runDockerCommand(`docker rm -f ${this.containerName}`, 10000);
      }
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
    const bundleFilename = `mux-bundle-${timestamp}.bundle`;
    const remoteBundlePath = `/tmp/${bundleFilename}`;
    // Use os.tmpdir() for host path (Windows doesn't have /tmp)
    const localBundlePath = path.join(os.tmpdir(), bundleFilename);

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
        // Only treat as "doesn't exist" if Docker says so
        if (inspectResult.stderr.toLowerCase().includes("no such object")) {
          return { success: true, deletedPath };
        }
        return {
          success: false,
          error: `Docker error: ${inspectResult.stderr || inspectResult.stdout || "unknown error"}`,
        };
      }

      if (!force) {
        // Check if container is already running before we start it
        const wasRunning = await runDockerCommand(
          `docker inspect -f '{{.State.Running}}' ${containerName}`,
          10000
        );
        const containerWasRunning =
          wasRunning.exitCode === 0 && wasRunning.stdout.trim() === "true";

        // Start container if stopped (docker start is idempotent - succeeds if already running)
        const startResult = await runDockerCommand(`docker start ${containerName}`, 30000);
        if (startResult.exitCode !== 0) {
          // Container won't start - skip dirty checks, allow deletion
          // (container is broken/orphaned, user likely wants to clean up)
        } else {
          // Helper to stop container if we started it (don't leave it running on check failure)
          const stopIfWeStartedIt = async () => {
            if (!containerWasRunning) {
              await runDockerCommand(`docker stop ${containerName}`, 10000);
            }
          };

          // Check for uncommitted changes
          const checkResult = await runDockerCommand(
            `docker exec ${containerName} bash -c 'cd ${CONTAINER_SRC_DIR} && git diff --quiet --exit-code && git diff --quiet --cached --exit-code'`,
            10000
          );

          if (checkResult.exitCode !== 0) {
            await stopIfWeStartedIt();
            return {
              success: false,
              error: "Workspace contains uncommitted changes. Use force flag to delete anyway.",
            };
          }

          // Check for unpushed commits (only if remotes exist - repos with no remotes would show all commits)
          const hasRemotes = await runDockerCommand(
            `docker exec ${containerName} bash -c 'cd ${CONTAINER_SRC_DIR} && git remote | grep -q .'`,
            10000
          );
          if (hasRemotes.exitCode === 0) {
            const unpushedResult = await runDockerCommand(
              `docker exec ${containerName} bash -c 'cd ${CONTAINER_SRC_DIR} && git log --branches --not --remotes --oneline'`,
              10000
            );

            if (unpushedResult.exitCode === 0 && unpushedResult.stdout.trim()) {
              await stopIfWeStartedIt();
              return {
                success: false,
                error: `Workspace contains unpushed commits:\n\n${unpushedResult.stdout.trim()}`,
              };
            }
          }
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

  async forkWorkspace(params: WorkspaceForkParams): Promise<WorkspaceForkResult> {
    const { projectPath, sourceWorkspaceName, newWorkspaceName, initLogger } = params;

    const srcContainerName = getContainerName(projectPath, sourceWorkspaceName);
    const destContainerName = getContainerName(projectPath, newWorkspaceName);
    const hostTempPath = path.join(os.tmpdir(), `mux-fork-${Date.now()}.bundle`);
    const containerBundlePath = "/tmp/fork.bundle";
    let destContainerCreated = false;
    let forkSucceeded = false;

    try {
      // 1. Verify source container exists
      const srcCheck = await runDockerCommand(`docker inspect ${srcContainerName}`, 10000);
      if (srcCheck.exitCode !== 0) {
        return {
          success: false,
          error: `Source workspace container not found: ${srcContainerName}`,
        };
      }

      // 2. Get current branch from source
      initLogger.logStep("Detecting source workspace branch...");
      const branchResult = await runDockerCommand(
        `docker exec ${srcContainerName} git -C ${CONTAINER_SRC_DIR} branch --show-current`,
        30000
      );
      const sourceBranch = branchResult.stdout.trim();
      if (branchResult.exitCode !== 0 || sourceBranch.length === 0) {
        return {
          success: false,
          error: "Failed to detect branch in source workspace (detached HEAD?)",
        };
      }

      // 3. Create git bundle inside source container
      initLogger.logStep("Creating git bundle from source...");
      const bundleResult = await runDockerCommand(
        `docker exec ${srcContainerName} git -C ${CONTAINER_SRC_DIR} bundle create ${containerBundlePath} --all`,
        300000
      );
      if (bundleResult.exitCode !== 0) {
        return { success: false, error: `Failed to create git bundle: ${bundleResult.stderr}` };
      }

      // 4. Transfer bundle to host
      initLogger.logStep("Copying bundle from source container...");
      const cpOutResult = await runDockerCommand(
        `docker cp ${srcContainerName}:${containerBundlePath} ${shescape.quote(hostTempPath)}`,
        300000
      );
      if (cpOutResult.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to copy bundle from source: ${cpOutResult.stderr}`,
        };
      }

      // 5. Create destination container
      initLogger.logStep(`Creating container: ${destContainerName}...`);
      const dockerArgs = ["run", "-d", "--name", destContainerName];
      if (this.config.shareCredentials) {
        dockerArgs.push(...buildCredentialArgs());
      }
      dockerArgs.push(this.config.image, "sleep", "infinity");
      const runResult = await runSpawnCommand("docker", dockerArgs, 60000);
      if (runResult.exitCode !== 0) {
        // Handle TOCTOU race - container may have been created between check and run
        if (runResult.stderr.includes("already in use")) {
          return {
            success: false,
            error: `Workspace already exists: container ${destContainerName}`,
          };
        }
        return { success: false, error: `Failed to create container: ${runResult.stderr}` };
      }
      destContainerCreated = true;

      // 6. Copy bundle into destination and clone
      initLogger.logStep("Copying bundle to destination container...");
      const cpInResult = await runDockerCommand(
        `docker cp ${shescape.quote(hostTempPath)} ${destContainerName}:${containerBundlePath}`,
        300000
      );
      if (cpInResult.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to copy bundle to destination: ${cpInResult.stderr}`,
        };
      }

      initLogger.logStep("Cloning repository in destination...");
      const cloneResult = await runDockerCommand(
        `docker exec ${destContainerName} git clone ${containerBundlePath} ${CONTAINER_SRC_DIR}`,
        300000
      );
      if (cloneResult.exitCode !== 0) {
        return { success: false, error: `Failed to clone from bundle: ${cloneResult.stderr}` };
      }

      // 7. Create local tracking branches (best-effort)
      initLogger.logStep("Creating local tracking branches...");
      try {
        const remotesResult = await runDockerCommand(
          `docker exec ${destContainerName} git -C ${CONTAINER_SRC_DIR} branch -r`,
          30000
        );
        if (remotesResult.exitCode === 0) {
          const remotes = remotesResult.stdout
            .split("\n")
            .map((b) => b.trim())
            .filter((b) => b.startsWith("origin/") && !b.includes("HEAD"));

          for (const remote of remotes) {
            const localName = remote.replace("origin/", "");
            await runDockerCommand(
              `docker exec ${destContainerName} git -C ${CONTAINER_SRC_DIR} branch ${shescape.quote(localName)} ${shescape.quote(remote)} 2>/dev/null || true`,
              10000
            );
          }
        }
      } catch {
        // Ignore - best-effort
      }

      // 8. Preserve origin URL (best-effort)
      try {
        const originResult = await runDockerCommand(
          `docker exec ${srcContainerName} git -C ${CONTAINER_SRC_DIR} remote get-url origin 2>/dev/null || true`,
          10000
        );
        const originUrl = originResult.stdout.trim();
        if (originUrl.length > 0) {
          await runDockerCommand(
            `docker exec ${destContainerName} git -C ${CONTAINER_SRC_DIR} remote set-url origin ${shescape.quote(originUrl)}`,
            10000
          );
        } else {
          await runDockerCommand(
            `docker exec ${destContainerName} git -C ${CONTAINER_SRC_DIR} remote remove origin 2>/dev/null || true`,
            10000
          );
        }
      } catch {
        // Ignore - best-effort
      }

      // 9. Checkout destination branch
      initLogger.logStep(`Checking out branch: ${newWorkspaceName}`);
      const checkoutCmd =
        `git checkout ${shescape.quote(newWorkspaceName)} 2>/dev/null || ` +
        `git checkout -b ${shescape.quote(newWorkspaceName)} ${shescape.quote(sourceBranch)}`;
      const checkoutResult = await runDockerCommand(
        `docker exec ${destContainerName} bash -c ${shescape.quote(`cd ${CONTAINER_SRC_DIR} && ${checkoutCmd}`)}`,
        120000
      );
      if (checkoutResult.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to checkout forked branch: ${checkoutResult.stderr || checkoutResult.stdout}`,
        };
      }

      initLogger.logStep("Fork completed successfully");
      forkSucceeded = true;
      // Update containerName so subsequent initWorkspace() targets the forked container
      this.containerName = destContainerName;
      return { success: true, workspacePath: CONTAINER_SRC_DIR, sourceBranch };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    } finally {
      // 10. Cleanup (best-effort, ignore errors)
      /* eslint-disable @typescript-eslint/no-empty-function */
      // Clean up bundle in source container
      await runDockerCommand(
        `docker exec ${srcContainerName} rm -f ${containerBundlePath}`,
        5000
      ).catch(() => {});
      // Clean up bundle in destination container (if it exists)
      if (destContainerCreated) {
        await runDockerCommand(
          `docker exec ${destContainerName} rm -f ${containerBundlePath}`,
          5000
        ).catch(() => {});
        // Remove orphaned destination container on failure
        if (!forkSucceeded) {
          await runDockerCommand(`docker rm -f ${destContainerName}`, 10000).catch(() => {});
        }
      }
      // Clean up host temp file
      await fs.unlink(hostTempPath).catch(() => {});
      /* eslint-enable @typescript-eslint/no-empty-function */
    }
  }

  /**
   * Ensure the Docker container is running.
   * `docker start` is idempotent - succeeds if already running, starts if stopped,
   * and waits if container is in a transitional state (starting/restarting).
   */
  override async ensureReady(): Promise<{ ready: boolean; error?: string }> {
    if (!this.containerName) {
      return { ready: false, error: "Container name not set" };
    }

    const result = await runDockerCommand(`docker start ${this.containerName}`, 30000);
    return result.exitCode === 0
      ? { ready: true }
      : { ready: false, error: result.stderr || "Failed to start container" };
  }

  /**
   * Docker uses /var/mux instead of ~/.mux because:
   * - /root has 700 permissions, inaccessible to VS Code Dev Containers (non-root user)
   * - /var/mux is world-readable by default
   */
  override getMuxHome(): string {
    return "/var/mux";
  }
}
