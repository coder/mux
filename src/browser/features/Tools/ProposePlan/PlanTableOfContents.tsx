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
  /**
   * Heading rendered at the top of the TOC. Defaults to "Contents".
   *
   * The plan title is the natural label for a plan TOC, so we let the host
   * surface it here — that conserves vertical space (no separate "CONTENTS"
   * label *and* an h1 list entry) and tightens the visual hierarchy: the
   * title sits at column 0, h2 entries align with it, and h3+ are minimally
   * indented under their parent h2.
   */
  title?: string;
  className?: string;
}

const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";
const DEFAULT_HEADING = "Contents";

export const PlanTableOfContents: React.FC<PlanTableOfContentsProps> = (props) => {
  // h1 is reserved for the TOC's heading (the plan title), so it never appears
  // as a list entry — but it still consumes a renderIndex because the rendered
  // DOM still contains an <h1>. h5/h6 are also hidden as visual noise.
  const visibleEntries = props.entries.filter((entry) => entry.level >= 2 && entry.level <= 4);
  if (visibleEntries.length < 2) {
    // A TOC with 0 or 1 entries adds visual chrome without navigation value.
    // (Note: this check intentionally excludes the title, since the title is
    // a single label, not a navigable destination on its own.)
    return null;
  }

  // Normalize indentation: anchor the shallowest visible level at column 0 so
  // a plan that starts at "###" doesn't look uniformly indented.
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

  // Use the supplied title when non-blank; fall back to "Contents" otherwise.
  // Treat "  " as blank — a whitespace-only title would render as an empty
  // heading line and look broken.
  const trimmedTitle = props.title?.trim();
  const headingText = trimmedTitle && trimmedTitle.length > 0 ? trimmedTitle : DEFAULT_HEADING;
  // If the plan's source markdown begins with an h1, clicking the TOC heading
  // jumps to that h1 (the natural "top of plan" target). Otherwise the heading
  // is a static label — there's nothing meaningful to scroll to.
  const titleHeadingEntry = props.entries.find((entry) => entry.level === 1);

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
        {titleHeadingEntry ? (
          <TooltipIfPresent tooltip={headingText} side="right" align="start">
            <button
              type="button"
              className="plan-toc-heading plan-toc-heading-link"
              onClick={() => handleNavigate(titleHeadingEntry.renderIndex)}
            >
              {headingText}
            </button>
          </TooltipIfPresent>
        ) : (
          <div className="plan-toc-heading">{headingText}</div>
        )}
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
               *
               * `side="right"` keeps the tooltip from drifting off the left
               * edge of the transcript — the toc lives in the left gutter.
               */}
              <TooltipIfPresent tooltip={entry.text} side="right" align="start">
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
