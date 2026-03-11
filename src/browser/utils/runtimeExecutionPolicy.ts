import type { RuntimeStatus } from "@/browser/stores/RuntimeStatusStore";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { isDevcontainerRuntime } from "@/common/types/runtime";

/**
 * Whether passive/background runtime-backed work can run without waking the runtime.
 * Explicit user actions can apply a different policy when they intentionally start work.
 */
export function canRunPassiveRuntimeCommand(
  runtimeConfig: FrontendWorkspaceMetadata["runtimeConfig"],
  runtimeStatus: RuntimeStatus | null
): boolean {
  if (!isDevcontainerRuntime(runtimeConfig)) {
    return true;
  }

  return runtimeStatus === "running";
}
