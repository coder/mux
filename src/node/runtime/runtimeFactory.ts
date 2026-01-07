import * as fs from "fs/promises";
import * as path from "path";
import type { Runtime, RuntimeAvailability } from "./Runtime";
import { LocalRuntime } from "./LocalRuntime";
import { WorktreeRuntime } from "./WorktreeRuntime";
import { SSHRuntime } from "./SSHRuntime";
import { DockerRuntime, getContainerName } from "./DockerRuntime";
import type { RuntimeConfig, RuntimeMode } from "@/common/types/runtime";
import { hasSrcBaseDir } from "@/common/types/runtime";
import { isIncompatibleRuntimeConfig } from "@/common/utils/runtimeCompatibility";
import { execAsync } from "@/node/utils/disposableExec";

// Re-export for backward compatibility with existing imports
export { isIncompatibleRuntimeConfig };

/**
 * Error thrown when a workspace has an incompatible runtime configuration,
 * typically from a newer version of mux that added new runtime types.
 */
export class IncompatibleRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompatibleRuntimeError";
  }
}

/**
 * Options for creating a runtime.
 */
export interface CreateRuntimeOptions {
  /**
   * Project path - required for project-dir local runtimes (type: "local" without srcBaseDir).
   * For Docker runtimes with existing workspaces, used together with workspaceName to derive container name.
   * For other runtime types, this is optional and used only for getWorkspacePath calculations.
   */
  projectPath?: string;
  /**
   * Workspace name - required for Docker runtimes when connecting to an existing workspace.
   * Used together with projectPath to derive the container name.
   */
  workspaceName?: string;
}

/**
 * Create a Runtime instance based on the configuration.
 *
 * Handles runtime types:
 * - "local" without srcBaseDir: Project-dir runtime (no isolation) - requires projectPath in options
 * - "local" with srcBaseDir: Legacy worktree config (backward compat)
 * - "worktree": Explicit worktree runtime
 * - "ssh": Remote SSH runtime
 * - "docker": Docker container runtime
 */
export function createRuntime(config: RuntimeConfig, options?: CreateRuntimeOptions): Runtime {
  // Check for incompatible configs from newer versions
  if (isIncompatibleRuntimeConfig(config)) {
    throw new IncompatibleRuntimeError(
      `This workspace uses a runtime configuration from a newer version of mux. ` +
        `Please upgrade mux to use this workspace.`
    );
  }

  switch (config.type) {
    case "local":
      // Check if this is legacy "local" with srcBaseDir (= worktree semantics)
      // or new "local" without srcBaseDir (= project-dir semantics)
      if (hasSrcBaseDir(config)) {
        // Legacy: "local" with srcBaseDir is treated as worktree
        return new WorktreeRuntime(config.srcBaseDir);
      }
      // Project-dir: uses project path directly, no isolation
      if (!options?.projectPath) {
        throw new Error(
          "LocalRuntime requires projectPath in options for project-dir config (type: 'local' without srcBaseDir)"
        );
      }
      return new LocalRuntime(options.projectPath);

    case "worktree":
      return new WorktreeRuntime(config.srcBaseDir);

    case "ssh":
      return new SSHRuntime({
        host: config.host,
        srcBaseDir: config.srcBaseDir,
        bgOutputDir: config.bgOutputDir,
        identityFile: config.identityFile,
        port: config.port,
      });

    case "docker": {
      // For existing workspaces, derive container name from project+workspace
      const containerName =
        options?.projectPath && options?.workspaceName
          ? getContainerName(options.projectPath, options.workspaceName)
          : config.containerName;
      return new DockerRuntime({
        image: config.image,
        containerName,
        shareCredentials: config.shareCredentials,
      });
    }

    default: {
      const unknownConfig = config as { type?: string };
      throw new Error(`Unknown runtime type: ${unknownConfig.type ?? "undefined"}`);
    }
  }
}

/**
 * Helper to check if a runtime config requires projectPath for createRuntime.
 */
export function runtimeRequiresProjectPath(config: RuntimeConfig): boolean {
  // Project-dir local runtime (no srcBaseDir) requires projectPath
  return config.type === "local" && !hasSrcBaseDir(config);
}

/**
 * Check if a project has a .git directory (is a git repository).
 */
async function isGitRepository(projectPath: string): Promise<boolean> {
  try {
    const gitPath = path.join(projectPath, ".git");
    const stat = await fs.stat(gitPath);
    // .git can be a directory (normal repo) or a file (worktree)
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Check if Docker daemon is running and accessible.
 */
async function isDockerAvailable(): Promise<boolean> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    using proc = execAsync("docker info");
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error("timeout")), 5000);
    });
    await Promise.race([proc.result, timeout]);
    return true;
  } catch {
    return false;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * Check availability of all runtime types for a given project.
 * Returns a record of runtime mode to availability status.
 */
export async function checkRuntimeAvailability(
  projectPath: string
): Promise<Record<RuntimeMode, RuntimeAvailability>> {
  const [isGit, dockerAvailable] = await Promise.all([
    isGitRepository(projectPath),
    isDockerAvailable(),
  ]);

  const gitRequiredReason = "Requires git repository";

  return {
    local: { available: true },
    worktree: isGit ? { available: true } : { available: false, reason: gitRequiredReason },
    ssh: isGit ? { available: true } : { available: false, reason: gitRequiredReason },
    docker: !isGit
      ? { available: false, reason: gitRequiredReason }
      : !dockerAvailable
        ? { available: false, reason: "Docker daemon not running" }
        : { available: true },
  };
}
