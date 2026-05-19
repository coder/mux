import React from "react";

interface ContextCollapseIndicatorProps {
  lineCount: number;
  onCollapse: (e: React.MouseEvent) => void;
  position: "above" | "below";
  /**
   * - "collapse" (default): button text reads "Collapse N lines …"; used to
   *   hide previously-loaded context.
   * - "expand": button text reads "Show N lines …"; used to reveal context
   *   that is currently hidden (Assisted-review trim).
   */
  mode?: "collapse" | "expand";
}

/**
 * Visual indicator for collapsing/expanding context lines.
 * Uses the squiggly line pattern established in BashOutputCollapsedIndicator.
 * Used between the main hunk content and surrounding context.
 */
export const ContextCollapseIndicator: React.FC<ContextCollapseIndicatorProps> = ({
  lineCount,
  onCollapse,
  position,
  mode = "collapse",
}) => {
  const verb = mode === "collapse" ? "Collapse" : "Show";
  const ariaLabel =
    mode === "collapse" ? `Collapse context ${position}` : `Show context ${position}`;
  return (
    <div className="flex items-center justify-center">
      <button
        onClick={onCollapse}
        className="text-muted hover:bg-background-highlight inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-px transition-colors"
        aria-label={ariaLabel}
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
          {verb} {lineCount} line{lineCount === 1 ? "" : "s"} {position}
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
