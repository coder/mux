import type { RuntimeConfig } from "@/common/types/runtime";
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
}

/**
 * Create a runtime from workspace metadata, ensuring workspaceName is always passed.
 *
 * Use this helper when creating a runtime from workspace metadata to ensure
 * DevcontainerRuntime.currentWorkspacePath is set, enabling host-path reads
 * (stat, readFile, etc.) before the container is ready.
 */
export function createRuntimeForWorkspace(metadata: WorkspaceMetadataForRuntime): Runtime {
  return createRuntime(metadata.runtimeConfig, {
    projectPath: metadata.projectPath,
    workspaceName: metadata.name,
  });
}
