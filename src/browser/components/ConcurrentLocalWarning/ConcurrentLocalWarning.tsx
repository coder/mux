import React, { useMemo, useRef, useSyncExternalStore } from "react";
import { AlertTriangle } from "lucide-react";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { useWorkspaceStreamingStatusPhase } from "@/browser/hooks/useWorkspaceStreamingStatusPhase";
import { CHAT_DOCK_GUTTER_CLASS } from "@/constants/layout";
import { useChatDockColumnWidthClass } from "@/browser/components/ChatPane/chatDockColumn";
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

  const streamingWorkspaceName = useSyncExternalStore(
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
  const lastStreamingWorkspaceNameRef = useRef(streamingWorkspaceName);
  if (streamingWorkspaceName !== null) {
    lastStreamingWorkspaceNameRef.current = streamingWorkspaceName;
  }
  const { displayPhase } = useWorkspaceStreamingStatusPhase(
    streamingWorkspaceName === null ? null : "streaming"
  );

  // Activity snapshots can hand off through a brief idle frame between adjacent stream phases.
  // Hold the last concrete workspace name for the same transition window used by sidebar status,
  // so the warning does not blink while the underlying agent is still visibly working elsewhere.
  return displayPhase === null ? null : lastStreamingWorkspaceNameRef.current;
}

interface ConcurrentLocalWarningViewProps {
  streamingWorkspaceName: string;
  className?: string;
}

export const ConcurrentLocalWarningView: React.FC<ConcurrentLocalWarningViewProps> = (props) => {
  return (
    <div
      role="status"
      className={cn("text-muted flex h-6 items-center gap-2 text-xs leading-none", props.className)}
    >
      <AlertTriangle aria-hidden="true" className="text-warning size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        <span className="text-foreground font-medium">{props.streamingWorkspaceName}</span> is also
        running in this project directory — agents may interfere
      </span>
    </div>
  );
};

export const ConcurrentLocalWarningDecoration: React.FC<ConcurrentLocalWarningViewProps> = (
  props
) => {
  const columnWidthClass = useChatDockColumnWidthClass();

  return (
    <div
      className={cn("bg-surface-primary", CHAT_DOCK_GUTTER_CLASS)}
      data-component="ConcurrentLocalWarningDecoration"
    >
      <ConcurrentLocalWarningView
        streamingWorkspaceName={props.streamingWorkspaceName}
        className={cn(columnWidthClass, props.className)}
      />
    </div>
  );
};
