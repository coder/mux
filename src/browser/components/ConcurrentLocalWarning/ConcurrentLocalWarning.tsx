import React, { useMemo, useSyncExternalStore } from "react";
import { AlertTriangle } from "lucide-react";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { isLocalProjectRuntime } from "@/common/types/runtime";
import type { RuntimeConfig } from "@/common/types/runtime";

interface ConcurrentLocalWarningProps {
  workspaceId: string;
  projectPath: string;
  runtimeConfig?: RuntimeConfig;
}

/**
 * Returns the name of another local-project workspace that is actively streaming in the same
 * project directory, or null when there is no conflicting local stream to warn about.
 */
export function useConcurrentLocalStreamingWorkspaceName(
  props: ConcurrentLocalWarningProps
): string | null {
  const isLocalProject = isLocalProjectRuntime(props.runtimeConfig);
  const { workspaceMetadata } = useWorkspaceContext();
  const store = useWorkspaceStoreRaw();

  const otherLocalWorkspaceIds = useMemo(() => {
    if (!isLocalProject) {
      return [];
    }

    const result: string[] = [];
    for (const [id, meta] of workspaceMetadata) {
      if (id === props.workspaceId) {
        continue;
      }
      if (meta.projectPath !== props.projectPath) {
        continue;
      }
      if (!isLocalProjectRuntime(meta.runtimeConfig)) {
        continue;
      }
      result.push(id);
    }
    return result;
  }, [isLocalProject, props.projectPath, props.workspaceId, workspaceMetadata]);

  return useSyncExternalStore(
    (listener) => {
      const unsubscribers = otherLocalWorkspaceIds.map((id) => store.subscribeKey(id, listener));
      return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
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
          // Workspace may not be registered yet, skip.
        }
      }
      return null;
    },
    () => null
  );
}

export const ConcurrentLocalWarningView: React.FC<{ streamingWorkspaceName: string }> = (props) => {
  return (
    <div className="text-center text-xs text-yellow-600/80">
      <AlertTriangle aria-hidden="true" className="mr-1 inline-block h-3 w-3 align-[-2px]" />
      <span className="text-yellow-500">{props.streamingWorkspaceName}</span> is also running in
      this project directory — agents may interfere
    </div>
  );
};

/**
 * Subtle indicator shown when a local project-dir workspace has another workspace
 * for the same project that is currently streaming.
 */
export const ConcurrentLocalWarning: React.FC<ConcurrentLocalWarningProps> = (props) => {
  const streamingWorkspaceName = useConcurrentLocalStreamingWorkspaceName(props);
  if (!streamingWorkspaceName) {
    return null;
  }

  return <ConcurrentLocalWarningView streamingWorkspaceName={streamingWorkspaceName} />;
};
