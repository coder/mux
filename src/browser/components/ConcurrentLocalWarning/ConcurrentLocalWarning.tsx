import React, { useMemo, useSyncExternalStore } from "react";
import { AlertTriangle } from "lucide-react";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { cn } from "@/common/lib/utils";
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

interface ConcurrentLocalWarningViewProps {
  streamingWorkspaceName: string;
  className?: string;
}

export const ConcurrentLocalWarningView: React.FC<ConcurrentLocalWarningViewProps> = (props) => {
  return (
    <div className={cn("text-center text-xs text-yellow-600/80", props.className)}>
      <AlertTriangle aria-hidden="true" className="mr-1 inline-block h-3 w-3 align-[-2px]" />
      <span className="text-yellow-500">{props.streamingWorkspaceName}</span> is also running in
      this project directory — agents may interfere
    </div>
  );
};

export const ConcurrentLocalWarningDecoration: React.FC<ConcurrentLocalWarningViewProps> = (
  props
) => {
  return (
    <div className="border-border bg-surface-primary border-t px-4 py-1.5">
      <ConcurrentLocalWarningView
        streamingWorkspaceName={props.streamingWorkspaceName}
        className={cn("mx-auto max-w-4xl", props.className)}
      />
    </div>
  );
};
