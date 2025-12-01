import React, { useState, useMemo } from "react";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { isLocalProjectRuntime } from "@/common/types/runtime";
import type { RuntimeConfig } from "@/common/types/runtime";
import { useSyncExternalStore } from "react";

/**
 * Warning shown when a local project-dir workspace has another workspace
 * for the same project that is currently streaming.
 *
 * This warns users that agents may interfere with each other when
 * working on the same directory without isolation.
 */
export const ConcurrentLocalWarning: React.FC<{
  workspaceId: string;
  projectPath: string;
  runtimeConfig?: RuntimeConfig;
}> = (props) => {
  const [dismissed, setDismissed] = useState(false);

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
  // We need to check if any of them have canInterrupt === true
  const streamingWorkspaceName = useSyncExternalStore(
    (listener) => {
      // Subscribe to all other local workspaces
      const unsubscribers = otherLocalWorkspaceIds.map((id) => store.subscribeKey(id, listener));
      return () => unsubscribers.forEach((unsub) => unsub());
    },
    () => {
      // Find first streaming workspace
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

  // Don't show if:
  // - Not a local project-dir runtime
  // - No other local workspaces are streaming
  // - User dismissed the warning
  if (!isLocalProject || !streamingWorkspaceName || dismissed) {
    return null;
  }

  return (
    <div className="mx-4 mt-2 mb-1 flex items-center justify-between gap-2 rounded bg-yellow-900/30 px-3 py-1.5 text-xs text-yellow-200">
      <span>
        <strong>{streamingWorkspaceName}</strong> is also running in this project. Agents may
        interfere — consider using only one at a time.
      </span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="shrink-0 text-yellow-400 hover:text-yellow-200"
        title="Dismiss warning"
      >
        ✕
      </button>
    </div>
  );
};
