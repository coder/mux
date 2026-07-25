import React from "react";
import { ChevronDown, Github, MessageCircle } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { GIT_STATUS_INDICATOR_MODE_KEY } from "@/common/constants/storage";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import type { GitStatusIndicatorMode } from "../GitStatusIndicatorView/GitStatusIndicatorView";
import { isDevcontainerRuntime, type RuntimeConfig } from "@/common/types/runtime";
import { getDevcontainerStatusChip } from "@/browser/utils/runtimeUi";
import { formatTokens } from "@/common/utils/tokens/tokenMeterUtils";
import { hasWorkspaceRepository } from "@/browser/utils/workspaceCapabilities";
import { isMultiProject } from "@/common/utils/multiProject";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import {
  useWorkspaceLastUserPrompt,
  useWorkspaceSidebarState,
  useWorkspaceStreamingStats,
  useWorkspaceUsage,
} from "@/browser/stores/WorkspaceStore";
import { useGitStatus } from "@/browser/stores/GitStatusStore";
import { useWorkspacePR } from "@/browser/stores/PRStatusStore";
import { useRuntimeStatus } from "@/browser/stores/RuntimeStatusStore";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { formatProjectHierarchyLabel } from "@/common/utils/subProjects";
import { SCRATCH_PROJECT_NAME } from "@/common/constants/scratch";
import { RuntimeBadge } from "../RuntimeBadge/RuntimeBadge";
import { BranchSelector } from "../BranchSelector/BranchSelector";
import { GitStatusIndicator } from "../GitStatusIndicator/GitStatusIndicator";
import { MultiProjectGitStatusIndicator } from "../GitStatusIndicator/MultiProjectGitStatusIndicator";
import { WorkspaceLinks } from "../WorkspaceLinks/WorkspaceLinks";
import { Popover, PopoverTrigger, PopoverContent } from "../Popover/Popover";

interface WorkspaceFooterBarProps {
  workspaceId: string;
  projectName: string;
  projectPath: string;
  workspaceName: string;
  namedWorkspacePath: string;
  runtimeConfig?: RuntimeConfig;
}

function WorkspaceDriftIndicator(props: {
  workspaceId: string;
  projectPath: string;
  isWorking: boolean;
  showMultiProjectStatus: boolean;
}) {
  const gitStatus = useGitStatus(props.workspaceId);

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <DriftModeToggle />
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

/** Shares the divergence dialog's persisted mode key so both surfaces stay in sync. */
function DriftModeToggle() {
  const [mode, setMode] = usePersistedState<GitStatusIndicatorMode>(
    GIT_STATUS_INDICATOR_MODE_KEY,
    "line-delta",
    { listener: true }
  );
  const isLineDelta = mode === "line-delta";

  return (
    <button
      type="button"
      className="text-muted hover:text-foreground flex shrink-0 cursor-pointer items-center gap-0.5 border-0 bg-transparent p-0 transition-colors"
      onClick={() => setMode(isLineDelta ? "divergence" : "line-delta")}
      onKeyDown={stopKeyboardPropagation}
    >
      {isLineDelta ? "Lines" : "Commits"}
      <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
    </button>
  );
}

function WorkspaceBranchControls(props: {
  workspaceId: string;
  workspaceName: string;
  devcontainerChip: ReturnType<typeof getDevcontainerStatusChip>;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
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
    </div>
  );
}

/** The GitHub slug only becomes known once PR detection resolves a remote. */
function FooterRepositoryLabel(props: { workspaceId: string; projectLabel: string }) {
  const workspacePR = useWorkspacePR(props.workspaceId);

  if (!workspacePR) {
    return <FooterProjectLabel projectLabel={props.projectLabel} />;
  }

  return (
    <span className="text-muted flex shrink-0 items-center gap-1">
      <Github className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="font-mono">
        {workspacePR.owner}/{workspacePR.repo}
      </span>
    </span>
  );
}

/** Must not shrink: the bar scrolls, so a shrinking item collapses to zero width. */
function FooterProjectLabel(props: { projectLabel: string }) {
  return (
    <span className="text-muted max-w-40 shrink-0 truncate font-mono">{props.projectLabel}</span>
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
    <span className="flex shrink-0 items-center gap-1.5">
      <span className="text-foreground counter-nums">
        {formatTokens(usage.totalTokens)} <span className="text-muted">tok</span>
      </span>
      {showTps && (
        <span className="text-foreground counter-nums">
          {Math.round(streamingStats.tps)} <span className="text-muted">t/s</span>
        </span>
      )}
    </span>
  );
}

function FooterLastPrompt(props: { workspaceId: string }) {
  const lastPrompt = useWorkspaceLastUserPrompt(props.workspaceId);

  if (lastPrompt === null) {
    return null;
  }

  return (
    <Popover>
      {/* A button, not a hover-only tooltip: the prompt text is the whole point of
          this item, and touch has no hover while keyboard users need a focus target. */}
      <PopoverTrigger asChild>
        <button
          type="button"
          className="text-muted hover:text-foreground flex shrink-0 cursor-pointer items-center gap-1 border-0 bg-transparent p-0 transition-colors"
          data-testid="workspace-footer-last-prompt"
          onKeyDown={stopKeyboardPropagation}
        >
          <MessageCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
          Last prompt
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="max-h-60 max-w-100 overflow-y-auto text-xs whitespace-pre-wrap"
      >
        {lastPrompt}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Bottom status bar for the workspace chat pane.
 *
 * Implements the "footer info bar" from the Review 1.4 page of the
 * "Mux exploration" Figma: a persistent strip of workspace facts (PR link, line
 * drift, repository, branch, token usage, last prompt) anchored in a predictable
 * spot instead of competing for space in the header. Content that overflows
 * simply scrolls horizontally, matching the design note ("content gets truncated
 * and the user can slide to the remaining info").
 */
export const WorkspaceFooterBar: React.FC<WorkspaceFooterBarProps> = (props) => {
  const { workspaceMetadata } = useWorkspaceContext();
  const workspaceEntry = workspaceMetadata.get(props.workspaceId);
  const hasRepository = hasWorkspaceRepository(workspaceEntry);
  const showMultiProjectStatus = workspaceEntry != null && isMultiProject(workspaceEntry);

  // The workspace's metadata.projectName is the parent project (worktrees are
  // owned by the top-most parent). When the workspace is scoped to a
  // sub-project, surface the hierarchy as "parent / child" so the footer alone
  // reveals the sub-project context.
  const { userProjects } = useProjectContext();
  const subProjectPath = workspaceEntry?.subProjectPath;
  const projectLabel =
    workspaceEntry?.kind === "scratch"
      ? SCRATCH_PROJECT_NAME
      : subProjectPath && userProjects.has(subProjectPath)
        ? formatProjectHierarchyLabel(subProjectPath, userProjects)
        : props.projectName;

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
      className="bg-sidebar border-border-light scrollbar-none flex h-7 shrink-0 items-center gap-2 overflow-x-auto border-t px-2 text-xs whitespace-nowrap"
    >
      <RuntimeBadge
        runtimeConfig={props.runtimeConfig}
        isWorking={isWorking}
        workspacePath={props.namedWorkspacePath}
        workspaceName={props.workspaceName}
        tooltipSide="top"
      />
      <WorkspaceLinks workspaceId={props.workspaceId} />
      {hasRepository && (
        <>
          <WorkspaceDriftIndicator
            workspaceId={props.workspaceId}
            projectPath={props.projectPath}
            isWorking={isWorking}
            showMultiProjectStatus={showMultiProjectStatus}
          />
          <FooterRepositoryLabel workspaceId={props.workspaceId} projectLabel={projectLabel} />
          <WorkspaceBranchControls
            workspaceId={props.workspaceId}
            workspaceName={props.workspaceName}
            devcontainerChip={devcontainerChip}
          />
        </>
      )}
      {!hasRepository && <FooterProjectLabel projectLabel={projectLabel} />}
      <FooterUsageStats workspaceId={props.workspaceId} />
      <FooterLastPrompt workspaceId={props.workspaceId} />
    </footer>
  );
};
