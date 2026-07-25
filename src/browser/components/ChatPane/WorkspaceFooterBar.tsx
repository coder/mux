import React from "react";
import { cn } from "@/common/lib/utils";
import { isDevcontainerRuntime, type RuntimeConfig } from "@/common/types/runtime";
import { getDevcontainerStatusChip } from "@/browser/utils/runtimeUi";
import { formatTokens } from "@/common/utils/tokens/tokenMeterUtils";
import { hasWorkspaceRepository } from "@/browser/utils/workspaceCapabilities";
import { isMultiProject } from "@/common/utils/multiProject";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import {
  useWorkspaceSidebarState,
  useWorkspaceStreamingStats,
  useWorkspaceUsage,
} from "@/browser/stores/WorkspaceStore";
import { useGitStatus } from "@/browser/stores/GitStatusStore";
import { useRuntimeStatus } from "@/browser/stores/RuntimeStatusStore";
import { BranchSelector } from "../BranchSelector/BranchSelector";
import { GitStatusIndicator } from "../GitStatusIndicator/GitStatusIndicator";
import { MultiProjectGitStatusIndicator } from "../GitStatusIndicator/MultiProjectGitStatusIndicator";
import { WorkspaceLinks } from "../WorkspaceLinks/WorkspaceLinks";

interface WorkspaceFooterBarProps {
  workspaceId: string;
  projectPath: string;
  workspaceName: string;
  runtimeConfig?: RuntimeConfig;
}

/**
 * Branch selector + devcontainer chip + git drift indicator.
 *
 * Moved here from WorkspaceMenuBar: the Review 1.4 design ("Mux exploration"
 * Figma) relocates repository state from the header into the footer status
 * bar so the header stays focused on identity (runtime, project, title) and
 * actions.
 */
function WorkspaceRepositoryControls(props: {
  workspaceId: string;
  workspaceName: string;
  projectPath: string;
  isWorking: boolean;
  showMultiProjectStatus: boolean;
  devcontainerChip: ReturnType<typeof getDevcontainerStatusChip>;
}) {
  const gitStatus = useGitStatus(props.workspaceId);

  return (
    <div className="flex items-center gap-1">
      <BranchSelector
        key={props.workspaceId}
        workspaceId={props.workspaceId}
        workspaceName={props.workspaceName}
      />
      {props.devcontainerChip && (
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-tight font-medium",
            props.devcontainerChip.className
          )}
        >
          {props.devcontainerChip.label}
        </span>
      )}
      {props.showMultiProjectStatus ? (
        <MultiProjectGitStatusIndicator
          workspaceId={props.workspaceId}
          tooltipPosition="bottom"
          isWorking={props.isWorking}
        />
      ) : (
        <GitStatusIndicator
          gitStatus={gitStatus}
          workspaceId={props.workspaceId}
          projectPath={props.projectPath}
          tooltipPosition="bottom"
          isWorking={props.isWorking}
        />
      )}
    </div>
  );
}

/**
 * Session token usage readout. Subscribes at the leaf so per-delta streaming
 * stats never cascade re-renders through the transcript (see WorkspaceStore's
 * streaming-stats subscription notes).
 */
function FooterUsageStats(props: { workspaceId: string }) {
  const usage = useWorkspaceUsage(props.workspaceId);
  const streamingStats = useWorkspaceStreamingStats(props.workspaceId);

  const showTps = streamingStats !== null && streamingStats.tps > 0;
  if (usage.totalTokens <= 0 && !showTps) {
    return null;
  }

  return (
    <span className="text-muted flex shrink-0 items-center gap-1.5">
      <span className="counter-nums">{formatTokens(usage.totalTokens)} tok</span>
      {showTps && <span className="counter-nums">{Math.round(streamingStats.tps)} t/s</span>}
    </span>
  );
}

/**
 * Bottom status bar for the workspace chat pane.
 *
 * Implements the "footer info bar" from the Review 1.4 page of the
 * "Mux exploration" Figma: a persistent strip of workspace facts — PR link,
 * branch, line drift, token usage — anchored in a predictable spot instead of
 * competing for space in the header. Content that overflows simply scrolls
 * horizontally, matching the design note ("content gets truncated and the
 * user can slide to the remaining info").
 */
export const WorkspaceFooterBar: React.FC<WorkspaceFooterBarProps> = (props) => {
  const { workspaceMetadata } = useWorkspaceContext();
  const workspaceEntry = workspaceMetadata.get(props.workspaceId);
  const hasRepository = hasWorkspaceRepository(workspaceEntry);
  const showMultiProjectStatus = workspaceEntry != null && isMultiProject(workspaceEntry);

  const { canInterrupt, isStarting, awaitingUserQuestion } = useWorkspaceSidebarState(
    props.workspaceId
  );
  const isWorking = (canInterrupt || isStarting) && !awaitingUserQuestion;

  const runtimeStatus = useRuntimeStatus(props.workspaceId);
  const devcontainerChip = isDevcontainerRuntime(props.runtimeConfig)
    ? getDevcontainerStatusChip(runtimeStatus)
    : null;

  return (
    <footer
      data-testid="workspace-footer-bar"
      className="bg-sidebar border-border-light flex h-7 shrink-0 items-center gap-2 overflow-x-auto border-t px-2 text-xs whitespace-nowrap"
    >
      <WorkspaceLinks workspaceId={props.workspaceId} />
      {hasRepository && (
        <WorkspaceRepositoryControls
          workspaceId={props.workspaceId}
          workspaceName={props.workspaceName}
          projectPath={props.projectPath}
          isWorking={isWorking}
          showMultiProjectStatus={showMultiProjectStatus}
          devcontainerChip={devcontainerChip}
        />
      )}
      {/* Push usage to the right edge so the bar reads status-bar-like even when sparse. */}
      <span className="min-w-0 flex-1" />
      <FooterUsageStats workspaceId={props.workspaceId} />
    </footer>
  );
};
