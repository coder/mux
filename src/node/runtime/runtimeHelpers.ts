import assert from "@/common/utils/assert";
import { isDockerRuntime, isLocalProjectRuntime, type RuntimeConfig } from "@/common/types/runtime";
import type { Runtime } from "./Runtime";
import { createRuntime } from "./runtimeFactory";

/**
 * Minimal workspace metadata needed to create a runtime with proper workspace path.
 * Matches the subset of FrontendWorkspaceMetadata / WorkspaceMetadata used at call sites.
 */
export interface WorkspaceMetadataForRuntime {
  runtimeConfig: RuntimeConfig;
  projectPath: string;
  name: string;
  namedWorkspacePath?: string;
}

/**
 * Resolve the canonical execution root for a workspace.
 *
 * Why: the persisted workspace path is the user-visible root shown in the Explorer and may differ
 * from runtime.getWorkspacePath() for multi-project/symlink-backed workspaces. Terminals and bash
 * execution must use the same root so users land in a consistent directory everywhere.
 *
 * Docker is the main exception: the persisted path is a host-side record, but runtime execution must
 * happen in the container's translated workspace path (for example, /src).
 */
export function resolveWorkspaceExecutionPath(
  metadata: WorkspaceMetadataForRuntime,
  runtime: Runtime
): string {
  const runtimeWorkspacePath = runtime.getWorkspacePath(metadata.projectPath, metadata.name);
  assert(runtimeWorkspacePath, `Workspace ${metadata.name} resolved to an empty runtime path`);

  if (isDockerRuntime(metadata.runtimeConfig)) {
    return runtimeWorkspacePath;
  }

  const persistedWorkspacePath = metadata.namedWorkspacePath?.trim();
  assert(
    persistedWorkspacePath,
    `Workspace ${metadata.name} is missing its persisted workspace path for runtime ${metadata.runtimeConfig.type}`
  );

  if (isLocalProjectRuntime(metadata.runtimeConfig)) {
    // Project-dir local runtimes always execute directly in the project root.
    assert(
      persistedWorkspacePath === runtimeWorkspacePath,
      `Project-dir local workspace ${metadata.name} path mismatch: persisted=${persistedWorkspacePath} runtime=${runtimeWorkspacePath}`
    );
  }

  return persistedWorkspacePath;
}

/**
 * Create a runtime from workspace metadata, ensuring workspace identity is always passed.
 *
 * Use this helper when recreating a runtime for an existing workspace so runtimes that cache
 * per-workspace state (for example DevcontainerRuntime host paths) start from the persisted
 * workspace root instead of reconstructing it from canonical naming conventions.
 */
export function createRuntimeForWorkspace(metadata: WorkspaceMetadataForRuntime): Runtime {
  return createRuntime(metadata.runtimeConfig, {
    projectPath: metadata.projectPath,
    workspaceName: metadata.name,
    workspacePath: metadata.namedWorkspacePath,
  });
}
