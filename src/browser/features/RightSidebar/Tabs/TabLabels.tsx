/**
 * Tab label components for RightSidebar tabs.
 *
 * Each tab type has its own label component that handles badges, icons, and actions.
 *
 * CostsTabLabel and StatsTabLabel subscribe to their own data to avoid re-rendering
 * the entire RightSidebarTabsetNode tree when stats update during agent streaming.
 */

import React from "react";
import { BugPlay, ExternalLink, FolderTree, Terminal as TerminalIcon, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { FileIcon } from "@/browser/components/FileIcon/FileIcon";
import { type ReviewStats } from "./registry";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { cn } from "@/common/lib/utils";
import { useWorkspaceUsage } from "@/browser/stores/WorkspaceStore";
import { sumUsageHistory, type ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";

interface StatsTabLabelProps {
  workspaceId: string;
}

/**
 * Unified Stats tab label with a session cost badge.
 * Subscribes to workspace usage directly to avoid re-rendering parent components.
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

/** Explorer tab label with folder tree icon */
export const ExplorerTabLabel: React.FC = () => (
  <span className="inline-flex items-center gap-1">
    <FolderTree className="h-3 w-3 shrink-0" />
    Explorer
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

interface FileTabLabelProps {
  /** File path (relative to workspace) */
  filePath: string;
  /** Callback when close button is clicked */
  onClose: () => void;
}

/** File tab label with file icon, filename, and close button */
export const FileTabLabel: React.FC<FileTabLabelProps> = ({ filePath, onClose }) => {
  // Extract just the filename for display
  const fileName = filePath.split("/").pop() ?? filePath;

  return (
    <span className="inline-flex items-center gap-1">
      <FileIcon fileName={fileName} style={{ fontSize: 14 }} className="h-3.5 w-3.5 shrink-0" />
      <span className="max-w-[120px] truncate" title={filePath}>
        {fileName}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="text-muted hover:text-destructive -my-0.5 rounded p-0.5 transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            aria-label="Close file"
          >
            <X className="h-3 w-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Close ({formatKeybind(KEYBINDS.CLOSE_TAB)})</TooltipContent>
      </Tooltip>
    </span>
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
