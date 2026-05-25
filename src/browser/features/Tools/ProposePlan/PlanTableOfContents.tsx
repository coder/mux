import React from "react";
import { cn } from "@/common/lib/utils";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import type { PlanHeading } from "./extractPlanHeadings";

/**
 * Sticky table of contents rendered alongside a plan in the chat transcript.
 *
 * Layout:
 * - The outer `<aside>` is absolutely positioned to the right of the plan via
 *   `left: 100%` (see `.plan-toc-aside` in globals.css). It is hidden by default
 *   and only revealed by a container query when the chat transcript has enough
 *   horizontal room beside the centered `max-w-4xl` plan.
 * - The inner `<nav>` uses `position: sticky` so it floats with the user while
 *   the plan is on screen, then naturally scrolls away once the plan exits the
 *   viewport (sticky is constrained to the parent's vertical bounds).
 *
 * Heading navigation is index-based: each entry stores its position among ALL
 * h1..h6 elements the plan renders, so clicking a TOC item does
 * `container.querySelectorAll("h1,h2,h3,h4,h5,h6")[renderIndex].scrollIntoView()`.
 * This avoids touching the shared markdown rehype pipeline just for plan TOC.
 */
export interface PlanTableOfContentsProps {
  /** Heading entries extracted from the plan markdown, in document order. */
  entries: PlanHeading[];
  /**
   * Ref to a DOM container whose subtree owns the rendered plan headings.
   * Must be a stable ancestor of the markdown output for `scrollIntoView` to
   * locate the right element.
   */
  contentRef: React.RefObject<HTMLElement | null>;
  className?: string;
}

const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";

export const PlanTableOfContents: React.FC<PlanTableOfContentsProps> = (props) => {
  // Hide deep nesting (h5/h6) — they add visual noise without aiding navigation
  // in plan content. They still take a renderIndex so DOM lookup stays aligned.
  const visibleEntries = props.entries.filter((entry) => entry.level <= 4);
  if (visibleEntries.length < 2) {
    // A TOC with 0 or 1 entries adds visual chrome without navigation value.
    return null;
  }

  // Normalize indentation: anchor the smallest visible level at column 0 so a
  // plan that starts at "##" doesn't look uniformly indented.
  const minLevel = Math.min(...visibleEntries.map((entry) => entry.level));

  const handleNavigate = (renderIndex: number) => {
    const container = props.contentRef.current;
    if (!container) return;
    const headings = container.querySelectorAll<HTMLElement>(HEADING_SELECTOR);
    const target = headings.item(renderIndex);
    // `scrollIntoView` is not implemented by happy-dom in unit tests; the guard
    // keeps tests from crashing while still exercising the lookup path.
    if (target && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "start" });
    }
  };

  return (
    <aside
      className={cn("plan-toc-aside", props.className)}
      aria-label="Plan contents"
      // The aside itself receives no pointer events; only the inner nav does.
      // This keeps the aside from interfering with text selection in margins
      // when the TOC happens to render above other transcript chrome.
      data-testid="plan-toc"
    >
      <nav className="plan-toc">
        <div className="plan-toc-heading">Contents</div>
        <ul className="plan-toc-list">
          {visibleEntries.map((entry) => (
            <li
              key={entry.renderIndex}
              className="plan-toc-item"
              data-level={entry.level - minLevel + 1}
            >
              {/*
               * Wrap with TooltipIfPresent so users can see the full heading
               * text when it's truncated by the toc's narrow column width
               * (long titles get `text-overflow: ellipsis` via CSS).
               */}
              <TooltipIfPresent tooltip={entry.text} side="left" align="start">
                <button
                  type="button"
                  className="plan-toc-link"
                  onClick={() => handleNavigate(entry.renderIndex)}
                >
                  {entry.text}
                </button>
              </TooltipIfPresent>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
};
