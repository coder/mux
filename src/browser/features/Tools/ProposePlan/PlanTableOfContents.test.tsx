import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useRef } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { installDom } from "../../../../../tests/ui/dom";
import { PlanTableOfContents } from "./PlanTableOfContents";
import type { PlanHeading } from "./extractPlanHeadings";

/**
 * Renders the PlanTableOfContents against a hand-rolled DOM that contains real
 * <h1>/<h2>/<h3> elements. We test the click → scrollIntoView wiring here
 * (instead of inside ProposePlanToolCall.test.tsx) because sibling test files
 * mock MarkdownCore at file scope; those mocks make Streamdown render plain text
 * without heading tags, which would break index-based DOM lookups.
 */
function HarnessRenderer({ entries }: { entries: PlanHeading[] }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div>
      <PlanTableOfContents entries={entries} contentRef={ref} />
      <div ref={ref} data-testid="plan-body">
        <h1>Intro</h1>
        <p>...</p>
        <h2>First section</h2>
        <p>...</p>
        <h2>Second section</h2>
        <p>...</p>
        <h3>Nested</h3>
      </div>
    </div>
  );
}

describe("PlanTableOfContents", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("returns null when given fewer than two visible headings", () => {
    const view = render(<HarnessRenderer entries={[{ renderIndex: 0, level: 1, text: "Only" }]} />);
    expect(view.queryByTestId("plan-toc")).toBeNull();
  });

  test("ignores deeply nested headings (h5/h6) for display", () => {
    const view = render(
      <HarnessRenderer
        entries={[
          { renderIndex: 0, level: 5, text: "Too deep one" },
          { renderIndex: 1, level: 6, text: "Too deep two" },
        ]}
      />
    );
    // Both entries are filtered out as too-deep, leaving 0 visible — TOC hidden.
    expect(view.queryByTestId("plan-toc")).toBeNull();
  });

  test("scrolls the correct rendered heading into view when an entry is clicked", () => {
    const entries: PlanHeading[] = [
      { renderIndex: 0, level: 1, text: "Intro" },
      { renderIndex: 1, level: 2, text: "First section" },
      { renderIndex: 2, level: 2, text: "Second section" },
      { renderIndex: 3, level: 3, text: "Nested" },
    ];

    const view = render(<HarnessRenderer entries={entries} />);

    const headings = Array.from(view.container.querySelectorAll<HTMLElement>("h1, h2, h3"));
    expect(headings).toHaveLength(4);

    const scrollCalls: Array<{ target: HTMLElement; options: ScrollIntoViewOptions }> = [];
    for (const heading of headings) {
      heading.scrollIntoView = ((options: ScrollIntoViewOptions) => {
        scrollCalls.push({ target: heading, options });
      }) as HTMLElement["scrollIntoView"];
    }

    fireEvent.click(view.getByRole("button", { name: "Second section" }));

    expect(scrollCalls).toHaveLength(1);
    expect(scrollCalls[0].target).toBe(headings[2]);
    // Top alignment ensures the heading lands just below the scrollport edge.
    expect(scrollCalls[0].options.block).toBe("start");
  });

  test("normalizes indentation so the shallowest level sits at the leftmost column", () => {
    // All entries are h3/h4 — they should render flush-left even though level is 3+.
    const view = render(
      <HarnessRenderer
        entries={[
          { renderIndex: 0, level: 3, text: "Outer" },
          { renderIndex: 1, level: 4, text: "Inner" },
        ]}
      />
    );

    const items = view.container.querySelectorAll<HTMLElement>(".plan-toc-item");
    expect(items[0].dataset.level).toBe("1");
    expect(items[1].dataset.level).toBe("2");
  });
});
