import type { Runtime } from "./Runtime";
import { LocalRuntime } from "./LocalRuntime";
import { WorktreeRuntime } from "./WorktreeRuntime";
import { SSHRuntime } from "./SSHRuntime";
import type { RuntimeConfig } from "@/common/types/runtime";
import { hasSrcBaseDir, isLocalProjectRuntime } from "@/common/types/runtime";
import { isIncompatibleRuntimeConfig } from "@/common/utils/runtimeCompatibility";

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
   * For other runtime types, this is optional and used only for getWorkspacePath calculations.
   */
  projectPath?: string;
}

/**
 * Create a Runtime instance based on the configuration.
 *
 * Handles three runtime types:
 * - "local" without srcBaseDir: Project-dir runtime (no isolation) - requires projectPath in options
 * - "local" with srcBaseDir: Legacy worktree config (backward compat)
 * - "worktree": Explicit worktree runtime
 * - "ssh": Remote SSH runtime
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
        identityFile: config.identityFile,
        port: config.port,
      });

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
  return isLocalProjectRuntime(config);
}
