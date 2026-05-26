import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useRef } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

import { installDom } from "../../../../../tests/ui/dom";
import { PlanTableOfContents } from "./PlanTableOfContents";
import type { PlanHeading } from "./extractPlanHeadings";

/**
 * Captures the live IntersectionObserver instances created by the component
 * under test so individual tests can drive observer callbacks deterministically.
 * happy-dom ships a no-op IntersectionObserver stub; replacing it with this
 * controllable harness is the only way to simulate scroll events synchronously.
 */
interface ObserverHandle {
  callback: IntersectionObserverCallback;
  observed: Element[];
}

function installControllableIntersectionObserver(): {
  handles: ObserverHandle[];
  restore: () => void;
} {
  const handles: ObserverHandle[] = [];
  const previous = (globalThis as unknown as { IntersectionObserver?: unknown })
    .IntersectionObserver;

  class ControllableIntersectionObserver {
    private readonly handle: ObserverHandle;
    constructor(cb: IntersectionObserverCallback) {
      this.handle = { callback: cb, observed: [] };
      handles.push(this.handle);
    }
    observe(target: Element): void {
      this.handle.observed.push(target);
    }
    unobserve(target: Element): void {
      const idx = this.handle.observed.indexOf(target);
      if (idx >= 0) this.handle.observed.splice(idx, 1);
    }
    disconnect(): void {
      this.handle.observed.length = 0;
    }
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
    ControllableIntersectionObserver;

  return {
    handles,
    restore: () => {
      (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver = previous;
    },
  };
}

/** Build a minimal IntersectionObserverEntry-shaped object for tests. */
function makeEntry(target: HTMLElement, top: number): Partial<IntersectionObserverEntry> {
  const boundingClientRect: DOMRect = {
    top,
    bottom: top + 20,
    left: 0,
    right: 100,
    width: 100,
    height: 20,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
  const intersectionRect: DOMRectReadOnly = boundingClientRect;
  return {
    target,
    boundingClientRect,
    intersectionRatio: top < 0 ? 0 : 1,
    intersectionRect,
    isIntersecting: top >= 0,
    rootBounds: null,
    time: 0,
  };
}

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

  test("updates the active indicator when an IntersectionObserver tick reports a heading has scrolled past the trigger", () => {
    const io = installControllableIntersectionObserver();
    try {
      const entries: PlanHeading[] = [
        { renderIndex: 0, level: 1, text: "Intro" },
        { renderIndex: 1, level: 2, text: "First section" },
        { renderIndex: 2, level: 2, text: "Second section" },
      ];

      const view = render(<HarnessRenderer entries={entries} title="Intro" />);

      // The component should have created exactly one observer with the
      // tracked headings observed.
      expect(io.handles).toHaveLength(1);
      const handle = io.handles[0];
      expect(handle.observed.length).toBeGreaterThan(0);

      const headings = Array.from(
        view.container.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")
      );

      // Simulate the user scrolling so the SECOND h2 ("Second section") has
      // just crossed above the trigger. We report intersection entries for
      // both h2s — first h2 at top=-100 (passed), second h2 at top=10
      // (passed), third heading (the h3 outside the visible set isn't
      // tracked).
      const secondSection = headings[2];
      const firstSection = headings[1];
      const title = headings[0];

      act(() => {
        handle.callback(
          [
            makeEntry(title, -200),
            makeEntry(firstSection, -100),
            makeEntry(secondSection, 10),
          ] as unknown as IntersectionObserverEntry[],
          handle as unknown as IntersectionObserver
        );
      });

      // Active entry should be the SECOND section (the last passed in document
      // order). Its button is the one tagged aria-current="location".
      const activeBtn = view.container.querySelector<HTMLElement>('[aria-current="location"]');
      expect(activeBtn).not.toBeNull();
      expect(activeBtn?.textContent).toBe("Second section");

      // The active <li> also carries data-active="true" for CSS styling.
      const activeItem = view.container.querySelector<HTMLElement>(
        '.plan-toc-item[data-active="true"]'
      );
      expect(activeItem).not.toBeNull();
      expect(activeItem?.textContent).toContain("Second section");

      // Now simulate scrolling further so the second section moves above and
      // there are no more headings ahead — last-passed is still the second
      // section.
      act(() => {
        handle.callback(
          [makeEntry(secondSection, -50)] as unknown as IntersectionObserverEntry[],
          handle as unknown as IntersectionObserver
        );
      });

      const stillActive = view.container.querySelector<HTMLElement>('[aria-current="location"]');
      expect(stillActive?.textContent).toBe("Second section");
    } finally {
      io.restore();
    }
  });

  test("clicking a TOC entry marks it active immediately so the indicator does not lag scroll", () => {
    const io = installControllableIntersectionObserver();
    try {
      const entries: PlanHeading[] = [
        { renderIndex: 0, level: 2, text: "Alpha" },
        { renderIndex: 1, level: 2, text: "Beta" },
        { renderIndex: 2, level: 2, text: "Gamma" },
      ];

      const view = render(<HarnessRenderer entries={entries} />);

      // Click the LAST entry; its active state must immediately reflect the
      // click rather than waiting for the observer to fire post-scroll.
      fireEvent.click(view.getByRole("button", { name: "Gamma" }));

      // Exactly one entry should be marked active, and it must be the clicked one.
      const active = view.container.querySelectorAll<HTMLElement>('[aria-current="location"]');
      expect(active).toHaveLength(1);
      expect(active[0].textContent).toBe("Gamma");
    } finally {
      io.restore();
    }
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
