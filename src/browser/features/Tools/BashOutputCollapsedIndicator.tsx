import React from "react";

interface BashOutputCollapsedIndicatorProps {
  processId: string;
  collapsedCount: number;
  isExpanded: boolean;
  onToggle: () => void;
}

/**
 * Visual indicator showing collapsed bash_output calls.
 * Renders as a squiggly line with count badge between the first and last calls.
 * Clickable to expand/collapse the hidden calls.
 */
export const BashOutputCollapsedIndicator: React.FC<BashOutputCollapsedIndicatorProps> = ({
  processId,
  collapsedCount,
  isExpanded,
  onToggle,
}) => {
  return (
    <div className="px-3 py-1">
      <button
        onClick={onToggle}
        className="text-muted hover:bg-background-highlight inline-flex cursor-pointer items-center gap-2 rounded px-2 py-0.5 transition-colors"
      >
        {/* Squiggly line SVG - rotates when expanded */}
        <svg
          className={`text-border shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`}
          width="16"
          height="24"
          viewBox="0 0 16 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M8 0 Q12 4, 8 8 Q4 12, 8 16 Q12 20, 8 24"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
        <span className="text-[10px] font-medium">
          {isExpanded ? "Hide" : "Show"} {collapsedCount} more output check
          {collapsedCount === 1 ? "" : "s"} for{" "}
          <code className="font-monospace text-text-muted">{processId}</code>
        </span>
      </button>
    </div>
  );
};
