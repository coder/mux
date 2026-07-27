import React, { useEffect } from "react";
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
import { Tooltip, TooltipTrigger, TooltipContent } from "../Tooltip/Tooltip";
import { formatKeybind, KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";

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

  if (props.showMultiProjectStatus) {
    // No mode toggle: the multi-project indicator shows a repo-level summary and
    // has no lines/commits modes, so a toggle here would silently rewrite the
    // shared preference without changing anything on screen.
    return (
      <MultiProjectGitStatusIndicator
        workspaceId={props.workspaceId}
        tooltipPosition="bottom"
        isWorking={props.isWorking}
      />
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <DriftModeToggle />
      <GitStatusIndicator
        gitStatus={gitStatus}
        workspaceId={props.workspaceId}
        projectPath={props.projectPath}
        tooltipPosition="bottom"
        isWorking={props.isWorking}
      />
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
  const toggleMode = () => setMode((prev) => (prev === "line-delta" ? "divergence" : "line-delta"));

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (matchesKeybind(e, KEYBINDS.TOGGLE_DRIFT_MODE)) {
        e.preventDefault();
        toggleMode();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="text-muted hover:text-foreground focus-visible:ring-accent flex shrink-0 cursor-pointer items-center gap-0.5 border-0 bg-transparent p-0 transition-colors focus-visible:ring-1"
          onClick={toggleMode}
          onKeyDown={stopKeyboardPropagation}
        >
          {isLineDelta ? "Lines" : "Commits"}
          <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        Show {isLineDelta ? "commits" : "lines"} ({formatKeybind(KEYBINDS.TOGGLE_DRIFT_MODE)})
      </TooltipContent>
    </Tooltip>
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
  const [open, setOpen] = React.useState(false);
  const [tooltipOpen, setTooltipOpen] = React.useState(false);

  // No listener while there is nothing to show, and drop any open state left over from a
  // prompt that has gone away, so the panel cannot pop open when a new prompt arrives.
  useEffect(() => {
    if (lastPrompt === null) {
      setOpen(false);
      setTooltipOpen(false);
      return;
    }
    const handler = (e: KeyboardEvent) => {
      if (matchesKeybind(e, KEYBINDS.SHOW_LAST_PROMPT)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [lastPrompt]);

  if (lastPrompt === null) {
    return null;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* The prompt itself opens in a popover rather than a hover tooltip: touch has no
          hover, and keyboard users need a focus target. The tooltip only carries the hint. */}
      <Tooltip open={tooltipOpen && !open} onOpenChange={setTooltipOpen}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="text-muted hover:bg-hover hover:text-foreground focus-visible:ring-accent flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-1.5 transition-colors focus-visible:ring-1"
              data-testid="workspace-footer-last-prompt"
              onKeyDown={stopKeyboardPropagation}
            >
              <MessageCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
              Last prompt
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">
          Show last prompt ({formatKeybind(KEYBINDS.SHOW_LAST_PROMPT)})
        </TooltipContent>
      </Tooltip>
      {/* Let prompt content determine the width instead of matching the trigger. */}
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        className="max-h-60 w-auto max-w-[min(25rem,var(--radix-popover-content-available-width,25rem))] overflow-y-auto p-3 text-xs leading-relaxed break-words whitespace-pre-wrap"
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
    // As the chat column's last row, this bar owns the mobile bottom inset: padding clears the
    // home indicator, and the negative margin lets its fill reach the screen edge.
    <footer
      data-testid="workspace-footer-bar"
      className="bg-sidebar border-border-light mb-[calc(-1*min(env(safe-area-inset-bottom,0px),40px))] shrink-0 border-t pb-[min(env(safe-area-inset-bottom,0px),40px)]"
    >
      <div className="scrollbar-none flex h-7 items-center gap-2 overflow-x-auto px-2 text-xs whitespace-nowrap">
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
      </div>
    </footer>
  );
};
