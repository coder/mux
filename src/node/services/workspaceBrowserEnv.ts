import assert from "node:assert/strict";
import type { RuntimeMode } from "@/common/types/runtime";
import type { ThinkingLevel } from "@/common/types/thinking";
import { getMuxEnv } from "@/node/runtime/initHook";
import type { BrowserSessionStreamPortRegistry } from "@/node/services/browserSessionStreamPortRegistry";

type WorkspaceBrowserEnvStreamPortRegistry = Pick<
  BrowserSessionStreamPortRegistry,
  "reservePort" | "isReservedPort"
>;

interface BuildWorkspaceBrowserEnvOptions {
  projectPath: string;
  runtime: RuntimeMode;
  workspaceName: string;
  workspaceId: string;
  streamPortRegistry?: WorkspaceBrowserEnvStreamPortRegistry | null;
  modelString?: string;
  thinkingLevel?: ThinkingLevel;
  costsUsd?: number;
}

export async function buildWorkspaceBrowserEnv(
  options: BuildWorkspaceBrowserEnvOptions
): Promise<Record<string, string>> {
  assert(options.projectPath.trim().length > 0, "projectPath must not be empty");
  assert(options.workspaceName.trim().length > 0, "workspaceName must not be empty");
  assert(options.workspaceId.trim().length > 0, "workspaceId must not be empty");

  const streamPort =
    options.streamPortRegistry != null
      ? await options.streamPortRegistry.reservePort(options.workspaceId)
      : undefined;
  if (options.streamPortRegistry != null && streamPort != null) {
    assert(
      options.streamPortRegistry.isReservedPort(options.workspaceId, streamPort),
      `Workspace browser env expected stream port ${streamPort} to remain reserved for ${options.workspaceId}`
    );
  }

  return getMuxEnv(options.projectPath, options.runtime, options.workspaceName, {
    modelString: options.modelString,
    thinkingLevel: options.thinkingLevel,
    costsUsd: options.costsUsd,
    workspaceId: options.workspaceId,
    streamPort,
  });
}
