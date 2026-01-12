/**
 * CoderSSHRuntime - SSH runtime wrapper for Coder workspaces.
 *
 * Extends SSHRuntime to add Coder-specific provisioning via postCreateSetup():
 * - Creates Coder workspace (if not connecting to existing)
 * - Runs `coder config-ssh --yes` to set up SSH proxy
 *
 * This ensures mux workspace metadata is persisted before the long-running
 * Coder build starts, allowing build logs to stream to init logs (like Docker).
 */

import type {
  WorkspaceCreationParams,
  WorkspaceCreationResult,
  WorkspaceForkParams,
  WorkspaceForkResult,
  WorkspaceInitParams,
} from "./Runtime";
import { SSHRuntime, type SSHRuntimeConfig } from "./SSHRuntime";
import type { CoderWorkspaceConfig } from "@/common/types/runtime";
import type { CoderService } from "@/node/services/coderService";
import { log } from "@/node/services/log";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { expandTildeForSSH } from "./tildeExpansion";
import * as path from "path";

export interface CoderSSHRuntimeConfig extends SSHRuntimeConfig {
  /** Coder-specific configuration */
  coder: CoderWorkspaceConfig;
}

/**
 * SSH runtime that handles Coder workspace provisioning.
 *
 * IMPORTANT: This extends SSHRuntime (rather than delegating) so other backend
 * code that checks `runtime instanceof SSHRuntime` (PTY, tools, path handling)
 * continues to behave correctly for Coder workspaces.
 */
export class CoderSSHRuntime extends SSHRuntime {
  private coderConfig: CoderWorkspaceConfig;
  private readonly coderService: CoderService;

  constructor(config: CoderSSHRuntimeConfig, coderService: CoderService) {
    super({
      host: config.host,
      srcBaseDir: config.srcBaseDir,
      bgOutputDir: config.bgOutputDir,
      identityFile: config.identityFile,
      port: config.port,
    });
    this.coderConfig = config.coder;
    this.coderService = coderService;
  }

  /**
   * Create workspace (fast path only - no SSH needed).
   * The Coder workspace may not exist yet, so we can't reach the SSH host.
   * Just compute the workspace path locally.
   */
  override createWorkspace(params: WorkspaceCreationParams): Promise<WorkspaceCreationResult> {
    const workspacePath = this.getWorkspacePath(params.projectPath, params.directoryName);

    params.initLogger.logStep("Workspace path computed (Coder provisioning will follow)");

    return Promise.resolve({
      success: true,
      workspacePath,
    });
  }

  /**
   * Delete workspace: removes SSH files AND deletes Coder workspace (if Mux-managed).
   *
   * IMPORTANT: Only delete the Coder workspace once we're confident mux will commit
   * the deletion. In the non-force path, WorkspaceService.remove() aborts and keeps
   * workspace metadata when runtime.deleteWorkspace() fails.
   */
  override async deleteWorkspace(
    projectPath: string,
    workspaceName: string,
    force: boolean,
    abortSignal?: AbortSignal
  ): Promise<{ success: true; deletedPath: string } | { success: false; error: string }> {
    const sshResult = await super.deleteWorkspace(projectPath, workspaceName, force, abortSignal);

    // If this workspace is an existing Coder workspace that mux didn't create, never delete it.
    if (this.coderConfig.existingWorkspace) {
      return sshResult;
    }

    // In the normal (force=false) delete path, only delete the Coder workspace if the SSH delete
    // succeeded. If SSH delete failed (e.g., dirty workspace), WorkspaceService.remove() keeps the
    // workspace metadata and the user can retry.
    if (!sshResult.success && !force) {
      return sshResult;
    }

    // workspaceName should always be set after workspace creation (prepareCoderConfigForCreate sets it)
    const coderWorkspaceName = this.coderConfig.workspaceName;
    if (!coderWorkspaceName) {
      log.warn("Coder workspace name not set, skipping Coder workspace deletion");
      return sshResult;
    }

    try {
      log.debug(`Deleting Coder workspace "${coderWorkspaceName}"`);
      await this.coderService.deleteWorkspace(coderWorkspaceName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("Failed to delete Coder workspace", {
        coderWorkspaceName,
        error: message,
      });

      if (sshResult.success) {
        return {
          success: false,
          error: `SSH delete succeeded, but failed to delete Coder workspace: ${message}`,
        };
      }

      return {
        success: false,
        error: `SSH delete failed: ${sshResult.error}; Coder delete also failed: ${message}`,
      };
    }

    return sshResult;
  }

  /**
   * Fork workspace: delegates to SSHRuntime, but marks both source and fork
   * as existingWorkspace=true so neither can delete the shared Coder workspace.
   *
   * IMPORTANT: Also updates this instance's coderConfig so that if postCreateSetup
   * runs on this same runtime instance (for the forked workspace), it won't attempt
   * to create a new Coder workspace.
   */
  override async forkWorkspace(params: WorkspaceForkParams): Promise<WorkspaceForkResult> {
    const result = await super.forkWorkspace(params);
    if (!result.success) return result;

    // Both workspaces now share the Coder workspace - mark as existing so
    // deleting either mux workspace won't destroy the underlying Coder workspace
    const sharedCoderConfig = { ...this.coderConfig, existingWorkspace: true };

    // Update this instance's config so postCreateSetup() skips coder create
    this.coderConfig = sharedCoderConfig;

    const sshConfig = this.getConfig();
    const sharedRuntimeConfig = { type: "ssh" as const, ...sshConfig, coder: sharedCoderConfig };

    return {
      ...result,
      forkedRuntimeConfig: sharedRuntimeConfig,
      sourceRuntimeConfig: sharedRuntimeConfig,
    };
  }

  /**
   * Post-create setup: provision Coder workspace and configure SSH.
   * This runs after mux persists workspace metadata, so build logs stream to UI.
   */
  async postCreateSetup(params: WorkspaceInitParams): Promise<void> {
    const { initLogger, abortSignal } = params;

    // Create Coder workspace if not connecting to an existing one
    if (!this.coderConfig.existingWorkspace) {
      // Validate required fields (workspaceName is set by prepareCoderConfigForCreate before this runs)
      const coderWorkspaceName = this.coderConfig.workspaceName;
      if (!coderWorkspaceName) {
        throw new Error(
          "Coder workspace name is required (should be set by prepareCoderConfigForCreate)"
        );
      }
      if (!this.coderConfig.template) {
        throw new Error("Coder template is required for new workspaces");
      }

      initLogger.logStep(`Creating Coder workspace "${coderWorkspaceName}"...`);

      try {
        for await (const line of this.coderService.createWorkspace(
          coderWorkspaceName,
          this.coderConfig.template,
          this.coderConfig.preset,
          abortSignal
        )) {
          initLogger.logStdout(line);
        }
        initLogger.logStep("Coder workspace created successfully");
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log.error("Failed to create Coder workspace", { error, config: this.coderConfig });
        initLogger.logStderr(`Failed to create Coder workspace: ${errorMsg}`);
        throw new Error(`Failed to create Coder workspace: ${errorMsg}`);
      }
    }

    // Ensure SSH config is set up for Coder workspaces
    initLogger.logStep("Configuring SSH for Coder...");
    try {
      await this.coderService.ensureSSHConfig();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error("Failed to configure SSH for Coder", { error });
      initLogger.logStderr(`Failed to configure SSH: ${errorMsg}`);
      throw new Error(`Failed to configure SSH for Coder: ${errorMsg}`);
    }

    // Create parent directory for workspace (git clone won't create it)
    // This must happen after ensureSSHConfig() so SSH is configured
    initLogger.logStep("Preparing workspace directory...");
    const parentDir = path.posix.dirname(params.workspacePath);
    const mkdirResult = await execBuffered(this, `mkdir -p ${expandTildeForSSH(parentDir)}`, {
      cwd: "/tmp",
      timeout: 10,
      abortSignal,
    });
    if (mkdirResult.exitCode !== 0) {
      const errorMsg = mkdirResult.stderr || mkdirResult.stdout || "Unknown error";
      log.error("Failed to create workspace parent directory", { parentDir, error: errorMsg });
      initLogger.logStderr(`Failed to prepare workspace directory: ${errorMsg}`);
      throw new Error(`Failed to prepare workspace directory: ${errorMsg}`);
    }
  }
}
// ============================================================================
// Coder RuntimeConfig helpers (called by workspaceService before persistence)
// ============================================================================

/**
 * Result of preparing a Coder SSH runtime config for workspace creation.
 */
export type PrepareCoderConfigResult =
  | { success: true; host: string; coder: CoderWorkspaceConfig }
  | { success: false; error: string };

/**
 * Coder workspace name regex: ^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$
 * - Must start with alphanumeric
 * - Can contain hyphens, but only between alphanumeric segments
 * - No underscores (unlike mux workspace names)
 */
const CODER_NAME_REGEX = /^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/;

/**
 * Transform a mux workspace name to be Coder-compatible.
 * - Replace underscores with hyphens
 * - Remove leading/trailing hyphens
 * - Collapse multiple consecutive hyphens
 */
function toCoderCompatibleName(name: string): string {
  return name
    .replace(/_/g, "-") // Replace underscores with hyphens
    .replace(/^-+|-+$/g, "") // Remove leading/trailing hyphens
    .replace(/-{2,}/g, "-"); // Collapse multiple hyphens
}

/**
 * Prepare Coder config for workspace creation.
 *
 * For new workspaces: derives workspaceName from mux workspace name if not set,
 * transforming it to be Coder-compatible (no underscores, valid format).
 * For existing workspaces: validates workspaceName is present.
 * Always normalizes host to `<workspaceName>.coder`.
 *
 * Call this before persisting RuntimeConfig to ensure correct values are stored.
 */
export function prepareCoderConfigForCreate(
  coder: CoderWorkspaceConfig,
  muxWorkspaceName: string
): PrepareCoderConfigResult {
  let workspaceName = coder.workspaceName?.trim() ?? "";

  if (!coder.existingWorkspace) {
    // New workspace: derive name from mux workspace name if not provided
    if (!workspaceName) {
      workspaceName = muxWorkspaceName;
    }
    // Transform to Coder-compatible name (handles underscores, etc.)
    workspaceName = toCoderCompatibleName(workspaceName);

    // Validate against Coder's regex
    if (!CODER_NAME_REGEX.test(workspaceName)) {
      return {
        success: false,
        error: `Workspace name "${muxWorkspaceName}" cannot be converted to a valid Coder name. Use only letters, numbers, and hyphens.`,
      };
    }
  } else {
    // Existing workspace: name must be provided (selected from dropdown)
    if (!workspaceName) {
      return { success: false, error: "Coder workspace name is required for existing workspaces" };
    }
  }

  // Final validation
  if (!workspaceName) {
    return { success: false, error: "Coder workspace name is required" };
  }

  return {
    success: true,
    host: `${workspaceName}.coder`,
    coder: { ...coder, workspaceName },
  };
}
