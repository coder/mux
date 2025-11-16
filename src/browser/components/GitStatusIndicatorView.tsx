import React from "react";
import { createPortal } from "react-dom";
import type { GitStatus } from "@/common/types/workspace";
import type { GitCommit, GitBranchHeader } from "@/node/utils/git/parseGitLog";
import { cn } from "@/common/lib/utils";

// Helper for indicator colors
const getIndicatorColor = (branch: number): string => {
  switch (branch) {
    case 0:
      return "#6bcc6b"; // Green for HEAD
    case 1:
      return "#6ba3cc"; // Blue for origin/main
    case 2:
      return "#b66bcc"; // Purple for origin/branch
    default:
      return "#6b6b6b"; // Gray fallback
  }
};

export interface GitStatusIndicatorViewProps {
  gitStatus: GitStatus | null;
  tooltipPosition?: "right" | "bottom";
  // Tooltip data
  branchHeaders: GitBranchHeader[] | null;
  commits: GitCommit[] | null;
  dirtyFiles: string[] | null;
  isLoading: boolean;
  errorMessage: string | null;
  // Interaction
  showTooltip: boolean;
  tooltipCoords: { top: number; left: number };
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onTooltipMouseEnter: () => void;
  onTooltipMouseLeave: () => void;
  onContainerRef: (el: HTMLSpanElement | null) => void;
}

/**
 * Pure presentation component for git status indicator.
 * Displays git status (ahead/behind/dirty) with tooltip on hover.
 * All data is passed as props - no IPC calls or side effects.
 */
export const GitStatusIndicatorView: React.FC<GitStatusIndicatorViewProps> = ({
  gitStatus,
  tooltipPosition = "right",
  branchHeaders,
  commits,
  dirtyFiles,
  isLoading,
  errorMessage,
  showTooltip,
  tooltipCoords,
  onMouseEnter,
  onMouseLeave,
  onTooltipMouseEnter,
  onTooltipMouseLeave,
  onContainerRef,
}) => {
  // Handle null gitStatus (loading state)
  if (!gitStatus) {
    return (
      <span
        className="text-accent relative mr-1.5 flex items-center gap-1 font-mono text-[11px]"
        aria-hidden="true"
      />
    );
  }

  // Render empty placeholder when nothing to show (prevents layout shift)
  if (gitStatus.ahead === 0 && gitStatus.behind === 0 && !gitStatus.dirty) {
    return (
      <span
        className="text-accent relative mr-1.5 flex items-center gap-1 font-mono text-[11px]"
        aria-hidden="true"
      />
    );
  }

  // Render colored indicator characters
  const renderIndicators = (indicators: string) => {
    return (
      <span className="text-placeholder mr-2 shrink-0 font-mono whitespace-pre">
        {Array.from(indicators).map((char, index) => (
          <span key={index} style={{ color: getIndicatorColor(index) }}>
            {char}
          </span>
        ))}
      </span>
    );
  };

  // Render branch header showing which column corresponds to which branch
  const renderBranchHeaders = () => {
    if (!branchHeaders || branchHeaders.length === 0) {
      return null;
    }

    return (
      <div className="border-separator-light mb-2 flex flex-col gap-0.5 border-b pb-2">
        {branchHeaders.map((header, index) => (
          <div key={index} className="flex gap-2 font-mono leading-snug">
            <span className="text-placeholder mr-2 shrink-0 font-mono whitespace-pre">
              {/* Create spacing to align with column */}
              {Array.from({ length: header.columnIndex }).map((_, i) => (
                <span key={i} style={{ color: getIndicatorColor(i) }}>
                  {" "}
                </span>
              ))}
              <span style={{ color: getIndicatorColor(header.columnIndex) }}>!</span>
            </span>
            <span className="text-foreground">[{header.branch}]</span>
          </div>
        ))}
      </div>
    );
  };

  // Render dirty files section
  const renderDirtySection = () => {
    if (!dirtyFiles || dirtyFiles.length === 0) {
      return null;
    }

    const LIMIT = 20;
    const displayFiles = dirtyFiles.slice(0, LIMIT);
    const isTruncated = dirtyFiles.length > LIMIT;

    return (
      <div className="border-separator-light mb-2 border-b pb-2">
        <div className="text-git-dirty mb-1 font-mono font-semibold">Uncommitted changes:</div>
        <div className="flex flex-col gap-px">
          {displayFiles.map((line, index) => (
            <div
              key={index}
              className="text-foreground font-mono text-[11px] leading-snug whitespace-pre"
            >
              {line}
            </div>
          ))}
        </div>
        {isTruncated && (
          <div className="text-muted-light mt-1 text-[10px] italic">
            (showing {LIMIT} of {dirtyFiles.length} files)
          </div>
        )}
      </div>
    );
  };

  // Render tooltip content
  const renderTooltipContent = () => {
    if (isLoading) {
      return "Loading...";
    }

    if (errorMessage) {
      return errorMessage;
    }

    if (!commits || commits.length === 0) {
      return "No commits to display";
    }

    return (
      <>
        {renderDirtySection()}
        {renderBranchHeaders()}
        <div className="flex flex-col gap-1">
          {commits.map((commit, index) => (
            <div key={`${commit.hash}-${index}`} className="flex flex-col gap-0.5">
              <div className="flex gap-2 font-mono leading-snug">
                {renderIndicators(commit.indicators)}
                <span className="text-accent shrink-0 select-all">{commit.hash}</span>
                <span className="text-muted-light shrink-0">{commit.date}</span>
                <span className="text-foreground flex-1 break-words">{commit.subject}</span>
              </div>
            </div>
          ))}
        </div>
      </>
    );
  };

  // Render tooltip via portal to bypass overflow constraints
  const tooltipElement = (
    <div
      className={cn(
        "fixed z-[10000] bg-modal-bg text-foreground border border-separator-light rounded px-3 py-2 text-[11px] font-mono whitespace-pre max-w-96 max-h-[400px] overflow-auto shadow-[0_4px_12px_rgba(0,0,0,0.5)] pointer-events-auto transition-opacity duration-200",
        showTooltip ? "opacity-100 visible" : "opacity-0 invisible"
      )}
      style={{
        top: `${tooltipCoords.top}px`,
        left: `${tooltipCoords.left}px`,
        transform: tooltipPosition === "right" ? "translateY(-50%)" : "none",
      }}
      onMouseEnter={onTooltipMouseEnter}
      onMouseLeave={onTooltipMouseLeave}
    >
      {renderTooltipContent()}
    </div>
  );

  return (
    <>
      <span
        ref={onContainerRef}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        className="text-accent relative mr-1.5 flex items-center gap-1 font-mono text-[11px]"
      >
        {gitStatus.ahead > 0 && (
          <span className="flex items-center font-normal">↑{gitStatus.ahead}</span>
        )}
        {gitStatus.behind > 0 && (
          <span className="flex items-center font-normal">↓{gitStatus.behind}</span>
        )}
        {gitStatus.dirty && (
          <span className="text-git-dirty flex items-center leading-none font-normal">*</span>
        )}
      </span>

      {createPortal(tooltipElement, document.body)}
    </>
  );
};
