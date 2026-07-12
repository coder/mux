import React, { useMemo, useSyncExternalStore } from "react";
import { AlertTriangle } from "lucide-react";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { useWorkspaceStoreRaw, type WorkspaceSidebarState } from "@/browser/stores/WorkspaceStore";
import { cn } from "@/common/lib/utils";
import { isLocalProjectRuntime } from "@/common/types/runtime";
import type { RuntimeConfig } from "@/common/types/runtime";

interface ConcurrentLocalWarningProps {
  workspaceId: string;
  projectPath: string;
  runtimeConfig?: RuntimeConfig;
}

type ConcurrentLocalWorkspaceActivity = Pick<
  WorkspaceSidebarState,
  "canInterrupt" | "isStarting" | "activeWorkflowRunCount" | "activeBashMonitorCount"
>;

export function isConcurrentLocalWorkspaceActive(state: ConcurrentLocalWorkspaceActivity): boolean {
  // User rationale: background work briefly transitions through idle and startup states as it wakes
  // the owning agent. Treat the whole wake cycle as active so the warning does not flash between turns.
  return (
    state.canInterrupt ||
    state.isStarting ||
    state.activeWorkflowRunCount > 0 ||
    state.activeBashMonitorCount > 0
  );
}

/**
 * Returns the name of another active local-project workspace in the same project directory, or null
 * when there is no conflicting local agent to warn about.
 */
export function useConcurrentLocalActiveWorkspaceName(
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
          if (isConcurrentLocalWorkspaceActive(state)) {
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
