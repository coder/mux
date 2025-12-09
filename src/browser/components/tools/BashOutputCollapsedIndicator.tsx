import React from "react";

interface BashOutputCollapsedIndicatorProps {
  processId: string;
  collapsedCount: number;
}

/**
 * Visual indicator showing collapsed bash_output calls.
 * Renders as a squiggly line with count badge between the first and last calls.
 */
export const BashOutputCollapsedIndicator: React.FC<BashOutputCollapsedIndicatorProps> = ({
  processId,
  collapsedCount,
}) => {
  return (
    <div className="text-muted flex items-center gap-2 px-3 py-1">
      {/* Squiggly line SVG */}
      <svg
        className="text-border shrink-0"
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
        {collapsedCount} more output check{collapsedCount === 1 ? "" : "s"} for{" "}
        <code className="font-monospace text-text-muted">{processId}</code>
      </span>
    </div>
  );
};
