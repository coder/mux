import * as path from "node:path";

import type { Config } from "@/node/config";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import assert from "@/common/utils/assert";

export const WORKFLOW_SCRATCH_RELATIVE_DIR = ".mux/workflows/.scratch";

export interface WorkflowScratchRoots {
  scratchRoot: string;
}

export function resolveWorkflowScratchRoots(
  config: Config,
  workspaceId: string,
  options?: {
    workspaceRootPath?: string;
    normalizePath?: (relativePath: string, basePath: string) => string;
  }
): WorkflowScratchRoots {
  const normalizedWorkspaceId = workspaceId.trim();
  assert(normalizedWorkspaceId.length > 0, "resolveWorkflowScratchRoots: workspaceId is required");

  const optionWorkspaceRootPath = options?.workspaceRootPath?.trim();
  const workspaceRootPath =
    optionWorkspaceRootPath != null && optionWorkspaceRootPath.length > 0
      ? optionWorkspaceRootPath
      : resolveWorkspaceRootFromConfig(config, normalizedWorkspaceId);
  assert(
    workspaceRootPath.length > 0,
    "resolveWorkflowScratchRoots: workspaceRootPath is required"
  );

  const scratchRoot = options?.normalizePath
    ? options.normalizePath(WORKFLOW_SCRATCH_RELATIVE_DIR, workspaceRootPath)
    : path.join(workspaceRootPath, ".mux", "workflows", ".scratch");
  assert(scratchRoot.length > 0, "resolveWorkflowScratchRoots: scratchRoot is required");

  return { scratchRoot };
}

function resolveWorkspaceRootFromConfig(config: Config, workspaceId: string): string {
  const appConfig = config.loadConfigOrDefault();
  const entry = findWorkspaceEntry(appConfig, workspaceId);
  return entry?.workspace.path ?? "";
}
