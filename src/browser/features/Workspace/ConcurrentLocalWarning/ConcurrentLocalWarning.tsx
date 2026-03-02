import React, { useMemo } from "react";
import { AlertTriangle } from "lucide-react";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { isLocalProjectRuntime } from "@/common/types/runtime";
import type { RuntimeConfig } from "@/common/types/runtime";
import { useSyncExternalStore } from "react";

/**
 * Subtle indicator shown when a local project-dir workspace has another workspace
 * for the same project that is currently streaming.
 */
export const ConcurrentLocalWarning: React.FC<{
  workspaceId: string;
  projectPath: string;
  runtimeConfig?: RuntimeConfig;
}> = (props) => {
  // Only show for local project-dir runtimes (not worktree or SSH)
  const isLocalProject = isLocalProjectRuntime(props.runtimeConfig);

  const { workspaceMetadata } = useWorkspaceContext();
  const store = useWorkspaceStoreRaw();

  // Find other local project-dir workspaces for the same project
  const otherLocalWorkspaceIds = useMemo(() => {
    if (!isLocalProject) return [];

    const result: string[] = [];
    for (const [id, meta] of workspaceMetadata) {
      // Skip current workspace
      if (id === props.workspaceId) continue;
      // Must be same project
      if (meta.projectPath !== props.projectPath) continue;
      // Must also be local project-dir runtime
      if (!isLocalProjectRuntime(meta.runtimeConfig)) continue;
      result.push(id);
    }
    return result;
  }, [isLocalProject, workspaceMetadata, props.workspaceId, props.projectPath]);

  // Subscribe to streaming state of other local workspaces
  const streamingWorkspaceName = useSyncExternalStore(
    (listener) => {
      const unsubscribers = otherLocalWorkspaceIds.map((id) => store.subscribeKey(id, listener));
      return () => unsubscribers.forEach((unsub) => unsub());
    },
    () => {
      for (const id of otherLocalWorkspaceIds) {
        try {
          const state = store.getWorkspaceSidebarState(id);
          if (state.canInterrupt) {
            const meta = workspaceMetadata.get(id);
            return meta?.name ?? id;
          }
        } catch {
          // Workspace may not be registered yet, skip
        }
      }
      return null;
    }
  );

  if (!isLocalProject || !streamingWorkspaceName) {
    return null;
  }

  return (
    <div className="text-center text-xs text-yellow-600/80">
      <AlertTriangle aria-hidden="true" className="mr-1 inline-block h-3 w-3 align-[-2px]" />
      <span className="text-yellow-500">{streamingWorkspaceName}</span> is also running in this
      project directory — agents may interfere
    </div>
  );
};
