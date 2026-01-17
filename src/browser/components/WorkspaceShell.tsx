import React, { useCallback, useRef } from "react";
import { cn } from "@/common/lib/utils";
import { RIGHT_SIDEBAR_WIDTH_KEY } from "@/common/constants/storage";
import { useResizableSidebar } from "@/browser/hooks/useResizableSidebar";
import { RightSidebar } from "./RightSidebar";
import { PopoverError } from "./PopoverError";
import type { RuntimeConfig } from "@/common/types/runtime";
import { useBackgroundBashError } from "@/browser/contexts/BackgroundBashContext";
import { useWorkspaceState } from "@/browser/stores/WorkspaceStore";
import { useReviews } from "@/browser/hooks/useReviews";
import type { ReviewNoteData } from "@/common/types/review";
import { ChatPane } from "./ChatPane";

interface WorkspaceShellProps {
  workspaceId: string;
  projectPath: string;
  projectName: string;
  workspaceName: string;
  namedWorkspacePath: string;
  leftSidebarCollapsed: boolean;
  onToggleLeftSidebarCollapsed: () => void;
  runtimeConfig?: RuntimeConfig;
  className?: string;
  /** If 'creating', workspace is still being set up (git operations in progress) */
  status?: "creating";
}

const WorkspacePlaceholder: React.FC<{
  title: string;
  description?: string;
  className?: string;
}> = (props) => (
  <div
    className={cn(
      "flex flex-1 flex-row bg-dark text-light overflow-x-auto overflow-y-hidden [@media(max-width:768px)]:flex-col",
      props.className
    )}
    style={{ containerType: "inline-size" }}
  >
    <div className="text-placeholder flex h-full flex-1 flex-col items-center justify-center text-center">
      <h3 className="m-0 mb-2.5 text-base font-medium">{props.title}</h3>
      {props.description && <p className="m-0 text-[13px]">{props.description}</p>}
    </div>
  </div>
);

export const WorkspaceShell: React.FC<WorkspaceShellProps> = (props) => {
  const sidebar = useResizableSidebar({
    enabled: true,
    defaultWidth: 400,
    minWidth: 300,
    maxWidth: 1200,
    storageKey: RIGHT_SIDEBAR_WIDTH_KEY,
  });

  const { width: sidebarWidth, isResizing, startResize } = sidebar;
  const addTerminalRef = useRef<(() => void) | null>(null);
  const handleOpenTerminal = useCallback(() => {
    addTerminalRef.current?.();
  }, []);

  const reviews = useReviews(props.workspaceId);
  const { addReview } = reviews;
  const handleReviewNote = useCallback(
    (data: ReviewNoteData) => {
      addReview(data);
    },
    [addReview]
  );

  const workspaceState = useWorkspaceState(props.workspaceId);
  const backgroundBashError = useBackgroundBashError();

  if (!workspaceState || workspaceState.loading) {
    return <WorkspacePlaceholder title="Loading workspace..." className={props.className} />;
  }

  if (!props.projectName || !props.workspaceName) {
    return (
      <WorkspacePlaceholder
        title="No Workspace Selected"
        description="Select a workspace from the sidebar to view and interact with Claude"
        className={props.className}
      />
    );
  }

  return (
    <div
      className={cn(
        "flex flex-1 flex-row bg-dark text-light overflow-x-auto overflow-y-hidden [@media(max-width:768px)]:flex-col",
        props.className
      )}
      style={{ containerType: "inline-size" }}
    >
      <ChatPane
        workspaceId={props.workspaceId}
        workspaceState={workspaceState}
        projectPath={props.projectPath}
        projectName={props.projectName}
        workspaceName={props.workspaceName}
        namedWorkspacePath={props.namedWorkspacePath}
        leftSidebarCollapsed={props.leftSidebarCollapsed}
        onToggleLeftSidebarCollapsed={props.onToggleLeftSidebarCollapsed}
        runtimeConfig={props.runtimeConfig}
        status={props.status}
        onOpenTerminal={handleOpenTerminal}
      />

      <RightSidebar
        key={props.workspaceId}
        workspaceId={props.workspaceId}
        workspacePath={props.namedWorkspacePath}
        projectPath={props.projectPath}
        width={sidebarWidth}
        onStartResize={startResize}
        isResizing={isResizing}
        onReviewNote={handleReviewNote}
        isCreating={props.status === "creating"}
        addTerminalRef={addTerminalRef}
      />

      <PopoverError
        error={backgroundBashError.error}
        prefix="Failed to terminate:"
        onDismiss={backgroundBashError.clearError}
      />
    </div>
  );
};
