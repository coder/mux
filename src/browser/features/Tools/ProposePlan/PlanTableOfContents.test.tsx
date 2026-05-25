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
function HarnessRenderer({ entries, title }: { entries: PlanHeading[]; title?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div>
      <PlanTableOfContents entries={entries} contentRef={ref} title={title} />
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

  test("returns null when there are fewer than two visible (h2-h4) entries", () => {
    // A lone h1 produces zero list entries (h1 is reserved for the heading)
    // and would leave a TOC with only a title — useless for navigation.
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

  test("filters h1 entries out of the navigation list (they live in the heading)", () => {
    const entries: PlanHeading[] = [
      { renderIndex: 0, level: 1, text: "Intro" },
      { renderIndex: 1, level: 2, text: "First section" },
      { renderIndex: 2, level: 2, text: "Second section" },
    ];

    const view = render(<HarnessRenderer entries={entries} title="My Plan" />);

    // h2 entries remain as navigable buttons; h1 does not.
    expect(view.getByRole("button", { name: "First section" })).toBeDefined();
    expect(view.getByRole("button", { name: "Second section" })).toBeDefined();
    expect(view.queryByRole("button", { name: "Intro" })).toBeNull();
  });

  test("renders the supplied title as the TOC heading", () => {
    const entries: PlanHeading[] = [
      { renderIndex: 0, level: 2, text: "A" },
      { renderIndex: 1, level: 2, text: "B" },
    ];

    const view = render(<HarnessRenderer entries={entries} title="My Plan Title" />);
    const toc = view.getByTestId("plan-toc");
    expect(toc.textContent).toContain("My Plan Title");
    // Without any h1 in entries, the heading should NOT be a clickable button.
    expect(view.queryByRole("button", { name: "My Plan Title" })).toBeNull();
  });

  test("clicking the TOC heading scrolls to the plan's h1 when one exists", () => {
    const entries: PlanHeading[] = [
      { renderIndex: 0, level: 1, text: "Plan Title From Markdown" },
      { renderIndex: 1, level: 2, text: "First section" },
      { renderIndex: 2, level: 2, text: "Second section" },
    ];

    const view = render(<HarnessRenderer entries={entries} title="Plan Title From Markdown" />);

    const headings = Array.from(view.container.querySelectorAll<HTMLElement>("h1, h2, h3"));
    const scrollCalls: Array<{ target: HTMLElement; options: ScrollIntoViewOptions }> = [];
    for (const heading of headings) {
      heading.scrollIntoView = ((options: ScrollIntoViewOptions) => {
        scrollCalls.push({ target: heading, options });
      }) as HTMLElement["scrollIntoView"];
    }

    fireEvent.click(view.getByRole("button", { name: "Plan Title From Markdown" }));
    expect(scrollCalls).toHaveLength(1);
    expect(scrollCalls[0].target).toBe(headings[0]); // the h1
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

  test("normalizes indentation so the shallowest visible level sits at column 0", () => {
    // With h1 reserved for the heading, h2 (the shallowest visible) should
    // render at data-level=1, and h3 at data-level=2.
    const view = render(
      <HarnessRenderer
        entries={[
          { renderIndex: 0, level: 1, text: "Title" },
          { renderIndex: 1, level: 2, text: "Section" },
          { renderIndex: 2, level: 3, text: "Subsection" },
        ]}
      />
    );

    const items = view.container.querySelectorAll<HTMLElement>(".plan-toc-item");
    expect(items).toHaveLength(2);
    expect(items[0].dataset.level).toBe("1");
    expect(items[1].dataset.level).toBe("2");
  });
});
