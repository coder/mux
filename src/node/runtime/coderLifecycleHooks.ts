import { isSSHRuntime } from "@/common/types/runtime";
import { Err, Ok, type Result } from "@/common/types/result";
import type { CoderService, WorkspaceStatusResult } from "@/node/services/coderService";
import { log } from "@/node/services/log";
import type {
  AfterUnarchiveHook,
  BeforeArchiveHook,
} from "@/node/services/workspaceLifecycleHooks";

const DEFAULT_STOP_TIMEOUT_MS = 60_000;
const DEFAULT_START_TIMEOUT_MS = 60_000;
const DEFAULT_STATUS_TIMEOUT_MS = 10_000;

function isAlreadyStoppedOrGone(status: WorkspaceStatusResult): boolean {
  if (status.kind === "not_found") {
    return true;
  }

  if (status.kind !== "ok") {
    return false;
  }

  // "stopping" is treated as "good enough" for archive — we don't want to block the user on a
  // long tail stop operation when the workspace is already on its way down.
  return (
    status.status === "stopped" ||
    status.status === "stopping" ||
    status.status === "deleted" ||
    status.status === "deleting"
  );
}

function isAlreadyRunningOrStarting(status: WorkspaceStatusResult): boolean {
  if (status.kind !== "ok") {
    return false;
  }

  return status.status === "running" || status.status === "starting";
}

export function createStopCoderOnArchiveHook(options: {
  coderService: CoderService;
  shouldStopOnArchive: () => boolean;
  timeoutMs?: number;
}): BeforeArchiveHook {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;

  return async ({ workspaceId, workspaceMetadata }): Promise<Result<void>> => {
    // Config default is ON (undefined behaves true).
    if (!options.shouldStopOnArchive()) {
      return Ok(undefined);
    }

    const runtimeConfig = workspaceMetadata.runtimeConfig;
    if (!isSSHRuntime(runtimeConfig) || !runtimeConfig.coder) {
      return Ok(undefined);
    }

    const coder = runtimeConfig.coder;

    // Important safety invariant:
    // Only stop Coder workspaces that mux created (dedicated workspaces). If the user connected
    // mux to an existing Coder workspace, archiving in mux should *not* stop their environment.
    if (coder.existingWorkspace === true) {
      return Ok(undefined);
    }

    const workspaceName = coder.workspaceName?.trim();
    if (!workspaceName) {
      return Ok(undefined);
    }

    // Best-effort: skip the stop call if the control-plane already thinks the workspace is down.
    const status = await options.coderService.getWorkspaceStatus(workspaceName, {
      timeoutMs: DEFAULT_STATUS_TIMEOUT_MS,
    });

    if (isAlreadyStoppedOrGone(status)) {
      return Ok(undefined);
    }

    log.debug("Stopping Coder workspace before mux archive", {
      workspaceId,
      coderWorkspaceName: workspaceName,
      statusKind: status.kind,
      status: status.kind === "ok" ? status.status : undefined,
    });

    const stopResult = await options.coderService.stopWorkspace(workspaceName, { timeoutMs });
    if (!stopResult.success) {
      return Err(`Failed to stop Coder workspace "${workspaceName}": ${stopResult.error}`);
    }

    return Ok(undefined);
  };
}

export function createStartCoderOnUnarchiveHook(options: {
  coderService: CoderService;
  shouldStopOnArchive: () => boolean;
  timeoutMs?: number;
}): AfterUnarchiveHook {
  const timeoutMs = options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;

  return async ({ workspaceId, workspaceMetadata }): Promise<Result<void>> => {
    // Config default is ON (undefined behaves true).
    if (!options.shouldStopOnArchive()) {
      return Ok(undefined);
    }

    const runtimeConfig = workspaceMetadata.runtimeConfig;
    if (!isSSHRuntime(runtimeConfig) || !runtimeConfig.coder) {
      return Ok(undefined);
    }

    const coder = runtimeConfig.coder;

    // Important safety invariant:
    // Only start Coder workspaces that mux created (dedicated workspaces). If the user connected
    // mux to an existing Coder workspace, unarchiving in mux should *not* start their environment.
    if (coder.existingWorkspace === true) {
      return Ok(undefined);
    }

    const workspaceName = coder.workspaceName?.trim();
    if (!workspaceName) {
      return Ok(undefined);
    }

    const status = await options.coderService.getWorkspaceStatus(workspaceName, {
      timeoutMs: DEFAULT_STATUS_TIMEOUT_MS,
    });

    // If the workspace is gone, that's "good enough" — there's nothing to start.
    if (status.kind === "not_found") {
      return Ok(undefined);
    }

    if (status.kind === "error") {
      log.debug("Skipping Coder workspace start after mux unarchive due to status check error", {
        workspaceId,
        coderWorkspaceName: workspaceName,
        error: status.error,
      });
      return Ok(undefined);
    }

    // Best-effort: don't start if the control-plane already thinks the workspace is coming up.
    if (isAlreadyRunningOrStarting(status)) {
      return Ok(undefined);
    }

    // Only start when the workspace is definitively stopped.
    if (status.status !== "stopped") {
      return Ok(undefined);
    }

    log.debug("Starting Coder workspace after mux unarchive", {
      workspaceId,
      coderWorkspaceName: workspaceName,
      status: status.status,
    });

    const startResult = await options.coderService.startWorkspace(workspaceName, { timeoutMs });
    if (!startResult.success) {
      return Err(`Failed to start Coder workspace "${workspaceName}": ${startResult.error}`);
    }

    return Ok(undefined);
  };
}
