/**
 * Tab label components for RightSidebar tabs.
 *
 * Each tab type has its own label component that handles badges, icons, and actions.
 *
 * CostsTabLabel and StatsTabLabel subscribe to their own data to avoid re-rendering
 * the entire RightSidebarTabsetNode tree when stats update during agent streaming.
 */

import React from "react";
import { BugPlay, ExternalLink, Monitor, Globe, Terminal as TerminalIcon, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { type ReviewStats } from "./registry";
import { useAPI } from "@/browser/contexts/API";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { useAdditionalSystemContextSnapshot } from "@/browser/utils/additionalSystemContextStore";
import {
  ensureWorkspaceInstructionsFetched,
  useWorkspaceInstructionsFileCount,
} from "@/browser/utils/workspaceInstructionsStore";
import { cn } from "@/common/lib/utils";
import { useWorkspaceUsage } from "@/browser/stores/WorkspaceStore";
import { sumUsageHistory, type ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";

interface StatsTabLabelProps {
  workspaceId: string;
}

/**
 * Unified Stats tab label with a session cost badge.
 * Subscribes to workspace usage directly to avoid re-rendering parent components.
 *
 * Accepts a context-bag prop so it can be invoked through the generic
 * `tabRegistry` Label slot (see `Tabs/tabRegistry.tsx`).
 */
export const StatsTabLabel: React.FC<StatsTabLabelProps> = ({ workspaceId }) => {
  const usage = useWorkspaceUsage(workspaceId);

  const sessionCost = React.useMemo(() => {
    const parts: ChatUsageDisplay[] = [];
    if (usage.sessionTotal) parts.push(usage.sessionTotal);
    if (usage.liveCostUsage) parts.push(usage.liveCostUsage);
    if (parts.length === 0) return null;

    const aggregated = sumUsageHistory(parts);
    if (!aggregated) return null;

    const total =
      (aggregated.input.cost_usd ?? 0) +
      (aggregated.cached.cost_usd ?? 0) +
      (aggregated.cacheCreate.cost_usd ?? 0) +
      (aggregated.output.cost_usd ?? 0) +
      (aggregated.reasoning.cost_usd ?? 0);
    return total > 0 ? total : null;
  }, [usage.sessionTotal, usage.liveCostUsage]);

  return (
    <>
      Stats
      {sessionCost !== null && (
        <span className="text-muted text-[10px] tabular-nums">
          ${sessionCost < 0.01 ? "<0.01" : sessionCost.toFixed(2)}
        </span>
      )}
    </>
  );
};

interface ReviewTabLabelProps {
  reviewStats: ReviewStats | null;
}

/** Review tab label with read/total badge */
export const ReviewTabLabel: React.FC<ReviewTabLabelProps> = ({ reviewStats }) => (
  <>
    Review
    {reviewStats !== null && reviewStats.total > 0 && (
      <span
        className={cn(
          "text-[10px]",
          reviewStats.read === reviewStats.total ? "text-muted" : "text-muted"
        )}
      >
        {reviewStats.read}/{reviewStats.total}
      </span>
    )}
  </>
);

/** Desktop tab label with monitor icon */
export const DesktopTabLabel: React.FC = () => (
  <span className="inline-flex items-center gap-1">
    <Monitor className="h-3 w-3 shrink-0" />
    Desktop
  </span>
);

/** Browser tab label with globe icon */
export const BrowserTabLabel: React.FC = () => (
  <span className="inline-flex items-center gap-1">
    <Globe className="h-3 w-3 shrink-0" />
    Browser
  </span>
);

/** Debug tab label with bug icon */
export const DebugTabLabel: React.FC = () => (
  <span className="inline-flex items-center gap-1">
    <BugPlay className="h-3 w-3 shrink-0" />
    Debug
  </span>
);

export function OutputTabLabel() {
  return <>Output</>;
}

interface InstructionsTabLabelProps {
  workspaceId: string;
}

/**
 * Instructions tab label with a count badge consistent with Stats/Review.
 *
 * Subscribes to the shared instructions store so the count stays in sync with
 * the panel's own fetches, and triggers a one-shot IPC fetch on first mount
 * when the count is unknown (e.g. another tab is active in the same tabset).
 *
 * The badge picks up the accent color when the per-workspace scratchpad has
 * any user content — a quick visual hint that this workspace is sending
 * additional system context to the agent.
 */
export const InstructionsTabLabel: React.FC<InstructionsTabLabelProps> = ({ workspaceId }) => {
  const { api } = useAPI();
  const fileCount = useWorkspaceInstructionsFileCount(workspaceId);
  const scratchpad = useAdditionalSystemContextSnapshot(workspaceId);
  const chatInstructionsActive = scratchpad.enabled && scratchpad.content.trim().length > 0;

  React.useEffect(() => {
    if (!api) return;
    ensureWorkspaceInstructionsFetched(api, workspaceId);
  }, [api, workspaceId]);

  // Chat Instructions, when active, contribute one additional "instruction
  // source" to the badge count. We mark them with a trailing asterisk so
  // users can tell ephemeral chat-scoped instructions apart from on-disk
  // AGENTS.md files at a glance.
  const baseCount = fileCount ?? 0;
  const displayCount = baseCount + (chatInstructionsActive ? 1 : 0);
  const showBadge = chatInstructionsActive || (fileCount != null && fileCount > 0);

  return (
    <>
      Instructions
      {showBadge && (
        <span
          className="text-muted text-[10px] tabular-nums"
          aria-label={
            chatInstructionsActive
              ? `${baseCount} instruction files plus active Chat Instructions`
              : `${baseCount} instruction files`
          }
        >
          {displayCount}
          {chatInstructionsActive && (
            // Orange asterisk mirrors the "dirty / has unsaved changes" cue used
            // by the git status indicator — a glanceable signal that the agent
            // is receiving ephemeral chat-scoped instructions in addition to
            // whatever AGENTS.md files contribute to this workspace.
            <span className="text-warning">*</span>
          )}
        </span>
      )}
    </>
  );
};

interface TerminalTabLabelProps {
  /** Dynamic title from OSC sequences, if available */
  dynamicTitle?: string;
  /** Terminal index (0-based) within the current tabset */
  terminalIndex: number;
  /** Callback when pop-out button is clicked */
  onPopOut: () => void;
  /** Callback when close button is clicked */
  onClose: () => void;
}

/** Terminal tab label with icon, dynamic title, and action buttons */
export const TerminalTabLabel: React.FC<TerminalTabLabelProps> = ({
  dynamicTitle,
  terminalIndex,
  onPopOut,
  onClose,
}) => {
  const fallbackName = terminalIndex === 0 ? "Terminal" : `Terminal ${terminalIndex + 1}`;
  const displayName = dynamicTitle ?? fallbackName;

  return (
    <span className="inline-flex items-center gap-1">
      <TerminalIcon className="h-3 w-3 shrink-0" />
      <span className="max-w-[20ch] min-w-0 truncate">{displayName}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="text-muted hover:text-foreground -my-0.5 rounded p-0.5 transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              onPopOut();
            }}
            aria-label="Open terminal in new window"
          >
            <ExternalLink className="h-3 w-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Open in new window</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="text-muted hover:text-destructive -my-0.5 rounded p-0.5 transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            aria-label="Close terminal"
          >
            <X className="h-3 w-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          Close terminal ({formatKeybind(KEYBINDS.CLOSE_TAB)})
        </TooltipContent>
      </Tooltip>
    </span>
  );
};
