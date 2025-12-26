import React from "react";

interface ContextCollapseIndicatorProps {
  lineCount: number;
  onCollapse: (e: React.MouseEvent) => void;
  position: "above" | "below";
}

/**
 * Visual indicator for collapsing expanded context lines.
 * Uses the squiggly line pattern established in BashOutputCollapsedIndicator.
 * Placed between expanded context and the main hunk content.
 */
export const ContextCollapseIndicator: React.FC<ContextCollapseIndicatorProps> = ({
  lineCount,
  onCollapse,
  position,
}) => {
  return (
    <div className="flex items-center justify-center">
      <button
        onClick={onCollapse}
        className="text-muted hover:bg-background-highlight inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-px transition-colors"
        aria-label={`Collapse context ${position}`}
      >
        {/* Squiggly line SVG - horizontal orientation for separator */}
        <svg
          className="text-border shrink-0"
          width="24"
          height="8"
          viewBox="0 0 24 8"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M0 4 Q4 0, 8 4 Q12 8, 16 4 Q20 0, 24 4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
        <span className="text-[10px] font-medium">
          Collapse {lineCount} line{lineCount === 1 ? "" : "s"} {position}
        </span>
        <svg
          className="text-border shrink-0"
          width="24"
          height="8"
          viewBox="0 0 24 8"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M0 4 Q4 0, 8 4 Q12 8, 16 4 Q20 0, 24 4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </button>
    </div>
  );
};
