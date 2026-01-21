/**
 * Tab label components for RightSidebar tabs.
 *
 * Each tab type has its own label component that handles badges, icons, and actions.
 */

import React from "react";
import { ExternalLink, FolderTree, Terminal as TerminalIcon, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { FileIcon } from "../../FileIcon";
import { formatTabDuration, type ReviewStats } from "./registry";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { cn } from "@/common/lib/utils";

interface CostsTabLabelProps {
  sessionCost: number | null;
}

/** Costs tab label with session cost badge */
export const CostsTabLabel: React.FC<CostsTabLabelProps> = ({ sessionCost }) => (
  <>
    Costs
    {sessionCost !== null && (
      <span className="text-muted text-[10px]">
        ${sessionCost < 0.01 ? "<0.01" : sessionCost.toFixed(2)}
      </span>
    )}
  </>
);

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

interface StatsTabLabelProps {
  sessionDuration: number | null;
}

/** Stats tab label with session duration badge */
export const StatsTabLabel: React.FC<StatsTabLabelProps> = ({ sessionDuration }) => (
  <>
    Stats
    {sessionDuration !== null && (
      <span className="text-muted text-[10px]">{formatTabDuration(sessionDuration)}</span>
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
