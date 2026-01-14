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
  RuntimeCreateFlags,
  WorkspaceCreationParams,
  WorkspaceCreationResult,
  WorkspaceForkParams,
  WorkspaceForkResult,
  WorkspaceInitParams,
  EnsureReadyOptions,
  EnsureReadyResult,
  RuntimeStatusEvent,
} from "./Runtime";
import { SSHRuntime, type SSHRuntimeConfig } from "./SSHRuntime";
import type { CoderWorkspaceConfig, RuntimeConfig } from "@/common/types/runtime";
import { isSSHRuntime } from "@/common/types/runtime";
import type { CoderService, WorkspaceStatusResult } from "@/node/services/coderService";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import { log } from "@/node/services/log";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { expandTildeForSSH } from "./tildeExpansion";
import * as path from "path";

export interface CoderSSHRuntimeConfig extends SSHRuntimeConfig {
  /** Coder-specific configuration */
  coder: CoderWorkspaceConfig;
}

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
 * SSH runtime that handles Coder workspace provisioning.
 *
 * IMPORTANT: This extends SSHRuntime (rather than delegating) so other backend
 * code that checks `runtime instanceof SSHRuntime` (PTY, tools, path handling)
 * continues to behave correctly for Coder workspaces.
 */
export class CoderSSHRuntime extends SSHRuntime {
  private coderConfig: CoderWorkspaceConfig;
  private readonly coderService: CoderService;

  /**
   * Timestamp of last time we (a) successfully used the runtime or (b) decided not
   * to block the user (unknown Coder CLI error).
   * Used to avoid running expensive status checks on every message while still
   * catching auto-stopped workspaces after long inactivity.
   */
  private lastActivityAtMs = 0;

  private static readonly INACTIVITY_THRESHOLD_MS = 5 * 60 * 1000;

  /**
   * Flags for WorkspaceService to customize create flow:
   * - deferredHost: skip srcBaseDir resolution (Coder host doesn't exist yet)
   * - configLevelCollisionDetection: use config-based collision check (can't reach host)
   */
  readonly createFlags: RuntimeCreateFlags = {
    deferredHost: true,
    configLevelCollisionDetection: true,
  };

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

  /** Overall timeout for ensureReady operations (start + polling) */
  private static readonly ENSURE_READY_TIMEOUT_MS = 120_000;

  /** Polling interval when waiting for workspace to stop/start */
  private static readonly STATUS_POLL_INTERVAL_MS = 2_000;

  /** In-flight ensureReady promise to avoid duplicate start/wait sequences */
  private ensureReadyPromise: Promise<EnsureReadyResult> | null = null;

  /**
   * Check if runtime is ready for use.
   *
   * Behavior:
   * - If creation failed during postCreateSetup(), fail fast.
   * - If workspace is running: return ready.
   * - If workspace is stopped: auto-start and wait (blocking, ~120s timeout).
   * - If workspace is stopping: poll until stopped, then start.
   * - Emits runtime-status events via statusSink for UX feedback.
   *
   * Concurrency: shares an in-flight promise to avoid duplicate start sequences.
   */
  override async ensureReady(options?: EnsureReadyOptions): Promise<EnsureReadyResult> {
    const workspaceName = this.coderConfig.workspaceName;
    if (!workspaceName) {
      return {
        ready: false,
        error: "Coder workspace name not set",
        errorType: "runtime_not_ready",
      };
    }

    const now = Date.now();

    // Fast path: recently active, skip expensive status check
    if (
      this.lastActivityAtMs !== 0 &&
      now - this.lastActivityAtMs < CoderSSHRuntime.INACTIVITY_THRESHOLD_MS
    ) {
      return { ready: true };
    }

    // Avoid duplicate concurrent start/wait sequences
    if (this.ensureReadyPromise) {
      return this.ensureReadyPromise;
    }

    this.ensureReadyPromise = this.doEnsureReady(workspaceName, options);
    try {
      return await this.ensureReadyPromise;
    } finally {
      this.ensureReadyPromise = null;
    }
  }

  /**
   * Core ensureReady logic - called once (protected by ensureReadyPromise).
   */
  private async doEnsureReady(
    workspaceName: string,
    options?: EnsureReadyOptions
  ): Promise<EnsureReadyResult> {
    const statusSink = options?.statusSink;
    const signal = options?.signal;
    const startTime = Date.now();

    const emitStatus = (phase: RuntimeStatusEvent["phase"], detail?: string) => {
      statusSink?.({ phase, runtimeType: "ssh", detail });
    };

    // Helper: check if we've exceeded overall timeout
    const isTimedOut = () => Date.now() - startTime > CoderSSHRuntime.ENSURE_READY_TIMEOUT_MS;
    const remainingMs = () =>
      Math.max(0, CoderSSHRuntime.ENSURE_READY_TIMEOUT_MS - (Date.now() - startTime));

    // Step 1: Check current status
    emitStatus("checking");

    if (signal?.aborted) {
      emitStatus("error");
      return { ready: false, error: "Aborted", errorType: "runtime_start_failed" };
    }

    // Helper to check if an error string indicates workspace not found (for startWorkspaceAndWait errors)
    const isWorkspaceNotFoundError = (error: string | undefined): boolean =>
      Boolean(error && /workspace not found/i.test(error));

    const statusResult = await this.coderService.getWorkspaceStatus(workspaceName, {
      timeoutMs: Math.min(remainingMs(), 10_000),
      signal,
    });

    // Helper to extract status from result, or null if not available
    const getStatus = (r: WorkspaceStatusResult): string | null =>
      r.kind === "ok" ? r.status : null;

    if (statusResult.kind === "ok" && statusResult.status === "running") {
      this.lastActivityAtMs = Date.now();
      emitStatus("ready");
      return { ready: true };
    }

    if (statusResult.kind === "not_found") {
      emitStatus("error");
      return {
        ready: false,
        error: `Coder workspace "${workspaceName}" not found`,
        errorType: "runtime_not_ready",
      };
    }

    if (statusResult.kind === "error") {
      // For errors (timeout, auth hiccup, Coder CLI issues), proceed optimistically
      // and let SSH fail naturally to avoid blocking the happy path.
      log.debug("Coder workspace status unknown, proceeding optimistically", {
        workspaceName,
        error: statusResult.error,
      });
      this.lastActivityAtMs = Date.now();
      return { ready: true };
    }

    // Step 2: Handle "stopping" status - wait for it to become "stopped"
    let currentStatus: string | null = getStatus(statusResult);

    if (currentStatus === "stopping") {
      emitStatus("waiting", "Waiting for Coder workspace to stop...");

      while (currentStatus === "stopping" && !isTimedOut()) {
        if (signal?.aborted) {
          emitStatus("error");
          return { ready: false, error: "Aborted", errorType: "runtime_start_failed" };
        }

        await this.sleep(CoderSSHRuntime.STATUS_POLL_INTERVAL_MS);
        const pollResult = await this.coderService.getWorkspaceStatus(workspaceName, {
          timeoutMs: Math.min(remainingMs(), 10_000),
          signal,
        });
        currentStatus = getStatus(pollResult);

        if (currentStatus === "running") {
          this.lastActivityAtMs = Date.now();
          emitStatus("ready");
          return { ready: true };
        }

        // If status unavailable, only fail fast if the workspace is definitively gone.
        // Otherwise fall through to start attempt (status check might have been flaky).
        if (pollResult.kind === "not_found") {
          emitStatus("error");
          return {
            ready: false,
            error: `Coder workspace "${workspaceName}" not found`,
            errorType: "runtime_not_ready",
          };
        }
        if (pollResult.kind === "error") {
          break;
        }
      }

      if (isTimedOut()) {
        emitStatus("error");
        return {
          ready: false,
          error: "Coder workspace is still stopping... Please retry shortly.",
          errorType: "runtime_start_failed",
        };
      }
    }

    // Step 3: Start the workspace and wait for it to be ready
    emitStatus("starting", "Starting Coder workspace...");
    log.debug("Starting Coder workspace", { workspaceName, currentStatus });

    const startResult = await this.coderService.startWorkspaceAndWait(
      workspaceName,
      remainingMs(),
      signal
    );

    if (startResult.success) {
      this.lastActivityAtMs = Date.now();
      emitStatus("ready");
      return { ready: true };
    }

    if (isWorkspaceNotFoundError(startResult.error)) {
      emitStatus("error");
      return {
        ready: false,
        error: `Coder workspace "${workspaceName}" not found`,
        errorType: "runtime_not_ready",
      };
    }

    // Handle "build already active" - poll until running or stopped
    if (startResult.error === "build_in_progress") {
      log.debug("Coder workspace build already active, polling for completion", { workspaceName });
      emitStatus("waiting", "Waiting for Coder workspace build...");

      while (!isTimedOut()) {
        if (signal?.aborted) {
          emitStatus("error");
          return { ready: false, error: "Aborted", errorType: "runtime_start_failed" };
        }

        await this.sleep(CoderSSHRuntime.STATUS_POLL_INTERVAL_MS);
        const pollResult = await this.coderService.getWorkspaceStatus(workspaceName, {
          timeoutMs: Math.min(remainingMs(), 10_000),
          signal,
        });

        if (pollResult.kind === "not_found") {
          emitStatus("error");
          return {
            ready: false,
            error: `Coder workspace "${workspaceName}" not found`,
            errorType: "runtime_not_ready",
          };
        }

        const pollStatus = getStatus(pollResult);

        if (pollStatus === "running") {
          this.lastActivityAtMs = Date.now();
          emitStatus("ready");
          return { ready: true };
        }

        if (pollStatus === "stopped") {
          // Build finished but workspace ended up stopped - retry start once
          log.debug("Coder workspace stopped after build, retrying start", { workspaceName });
          emitStatus("starting", "Starting Coder workspace...");

          const retryResult = await this.coderService.startWorkspaceAndWait(
            workspaceName,
            remainingMs(),
            signal
          );

          if (retryResult.success) {
            this.lastActivityAtMs = Date.now();
            emitStatus("ready");
            return { ready: true };
          }

          if (isWorkspaceNotFoundError(retryResult.error)) {
            emitStatus("error");
            return {
              ready: false,
              error: `Coder workspace "${workspaceName}" not found`,
              errorType: "runtime_not_ready",
            };
          }

          emitStatus("error");
          return {
            ready: false,
            error: `Failed to start Coder workspace: ${retryResult.error ?? "unknown error"}`,
            errorType: "runtime_start_failed",
          };
        }
      }

      emitStatus("error");
      return {
        ready: false,
        error: "Coder workspace is still starting... Please retry shortly.",
        errorType: "runtime_start_failed",
      };
    }

    // Other start failure
    emitStatus("error");
    return {
      ready: false,
      error: `Failed to start Coder workspace: ${startResult.error ?? "unknown error"}`,
      errorType: "runtime_start_failed",
    };
  }

  /** Promise-based sleep helper */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Finalize runtime config after collision handling.
   * Derives Coder workspace name from branch name and computes SSH host.
   */
  finalizeConfig(
    finalBranchName: string,
    config: RuntimeConfig
  ): Promise<Result<RuntimeConfig, string>> {
    if (!isSSHRuntime(config) || !config.coder) {
      return Promise.resolve(Ok(config));
    }

    const coder = config.coder;
    let workspaceName = coder.workspaceName?.trim() ?? "";

    if (!coder.existingWorkspace) {
      // New workspace: derive name from mux workspace name if not provided
      if (!workspaceName) {
        workspaceName = `mux-${finalBranchName}`;
      }
      // Transform to Coder-compatible name (handles underscores, etc.)
      workspaceName = toCoderCompatibleName(workspaceName);

      // Validate against Coder's regex
      if (!CODER_NAME_REGEX.test(workspaceName)) {
        return Promise.resolve(
          Err(
            `Workspace name "${finalBranchName}" cannot be converted to a valid Coder name. ` +
              `Use only letters, numbers, and hyphens.`
          )
        );
      }
    } else {
      // Existing workspace: name must be provided (selected from dropdown)
      if (!workspaceName) {
        return Promise.resolve(Err("Coder workspace name is required for existing workspaces"));
      }
    }

    // Final validation
    if (!workspaceName) {
      return Promise.resolve(Err("Coder workspace name is required"));
    }

    return Promise.resolve(
      Ok({
        ...config,
        host: `${workspaceName}.coder`,
        coder: { ...coder, workspaceName },
      })
    );
  }

  /**
   * Validate before persisting workspace metadata.
   * Checks if a Coder workspace with this name already exists.
   */
  async validateBeforePersist(
    _finalBranchName: string,
    config: RuntimeConfig
  ): Promise<Result<void, string>> {
    if (!isSSHRuntime(config) || !config.coder) {
      return Ok(undefined);
    }

    // Skip for "existing" mode - user explicitly selected an existing workspace
    if (config.coder.existingWorkspace) {
      return Ok(undefined);
    }

    const workspaceName = config.coder.workspaceName;
    if (!workspaceName) {
      return Ok(undefined);
    }

    const exists = await this.coderService.workspaceExists(workspaceName);

    if (exists) {
      return Err(
        `A Coder workspace named "${workspaceName}" already exists. ` +
          `Either switch to "Existing" mode to use it, delete/rename it in Coder, ` +
          `or choose a different mux workspace name.`
      );
    }

    return Ok(undefined);
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
    // If this workspace is an existing Coder workspace that mux didn't create, just do SSH cleanup.
    if (this.coderConfig.existingWorkspace) {
      return super.deleteWorkspace(projectPath, workspaceName, force, abortSignal);
    }

    const coderWorkspaceName = this.coderConfig.workspaceName;
    if (!coderWorkspaceName) {
      log.warn("Coder workspace name not set, falling back to SSH-only deletion");
      return super.deleteWorkspace(projectPath, workspaceName, force, abortSignal);
    }

    // Check if Coder workspace still exists before attempting SSH operations.
    // If it's already gone, skip SSH cleanup (would hang trying to connect to non-existent host).
    const statusResult = await this.coderService.getWorkspaceStatus(coderWorkspaceName);
    if (statusResult.kind === "not_found") {
      log.debug("Coder workspace already deleted, skipping SSH cleanup", { coderWorkspaceName });
      return { success: true, deletedPath: this.getWorkspacePath(projectPath, workspaceName) };
    }
    if (statusResult.kind === "error") {
      // API errors (auth, network): fall through to SSH cleanup, let it fail naturally
      log.warn("Could not check Coder workspace status, proceeding with SSH cleanup", {
        coderWorkspaceName,
        error: statusResult.error,
      });
    }
    if (statusResult.kind === "ok") {
      // Workspace is being deleted or already deleted - skip SSH (would hang connecting to dying host)
      if (statusResult.status === "deleted" || statusResult.status === "deleting") {
        log.debug("Coder workspace is deleted/deleting, skipping SSH cleanup", {
          coderWorkspaceName,
          status: statusResult.status,
        });
        return { success: true, deletedPath: this.getWorkspacePath(projectPath, workspaceName) };
      }
    }

    const sshResult = await super.deleteWorkspace(projectPath, workspaceName, force, abortSignal);

    // In the normal (force=false) delete path, only delete the Coder workspace if the SSH delete
    // succeeded. If SSH delete failed (e.g., dirty workspace), WorkspaceService.remove() keeps the
    // workspace metadata and the user can retry.
    if (!sshResult.success && !force) {
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
      // Validate required fields (workspaceName is set by finalizeConfig during workspace creation)
      const coderWorkspaceName = this.coderConfig.workspaceName;
      if (!coderWorkspaceName) {
        throw new Error("Coder workspace name is required (should be set by finalizeConfig)");
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

    this.lastActivityAtMs = Date.now();
  }
}
