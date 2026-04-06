import assert from "@/common/utils/assert";
import {
  isDockerRuntime,
  isLocalProjectRuntime,
  isSSHRuntime,
  type RuntimeConfig,
} from "@/common/types/runtime";
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
  if (metadata.projectPath === metadata.name) {
    // In-place workspaces (CLI/benchmarks) execute directly in their project root instead of a
    // named sibling checkout, so deriving a worktree path would be reconstructing the wrong shape.
    return metadata.projectPath;
  }

  const runtimeWorkspacePath = runtime.getWorkspacePath(metadata.projectPath, metadata.name);
  assert(runtimeWorkspacePath, `Workspace ${metadata.name} resolved to an empty runtime path`);

  if (isDockerRuntime(metadata.runtimeConfig)) {
    return runtimeWorkspacePath;
  }

  const persistedWorkspacePath = metadata.namedWorkspacePath?.trim();
  if (!persistedWorkspacePath) {
    // SSH workspaces must keep using the persisted checkout root from config so upgraded legacy
    // workspaces do not silently fall back to the reconstructed hashed path and miss their real cwd.
    assert(
      !isSSHRuntime(metadata.runtimeConfig),
      `SSH workspace ${metadata.name} is missing a persisted workspace path`
    );

    // Other runtimes can still fall back to their canonical derived path when only identity metadata
    // is available (for example in narrow unit tests).
    return runtimeWorkspacePath;
  }

  if (isLocalProjectRuntime(metadata.runtimeConfig)) {
    // Project-dir local runtimes always execute directly in the project root.
    assert(
      persistedWorkspacePath === runtimeWorkspacePath,
      `Project-dir local workspace ${metadata.name} path mismatch: persisted=${persistedWorkspacePath} runtime=${runtimeWorkspacePath}`
    );
  }

  return persistedWorkspacePath;
}

export interface WorkspaceRuntimeContext {
  runtime: Runtime;
  workspacePath: string;
}

/**
 * Recreate an existing workspace runtime together with the execution path that should be used for
 * terminals, tool calls, and agent discovery.
 */
export function createRuntimeContextForWorkspace(
  metadata: WorkspaceMetadataForRuntime
): WorkspaceRuntimeContext {
  const runtime = createRuntimeForWorkspace(metadata);
  return {
    runtime,
    workspacePath: resolveWorkspaceExecutionPath(metadata, runtime),
  };
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
