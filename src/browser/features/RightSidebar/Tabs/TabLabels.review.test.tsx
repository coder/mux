import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { installDom } from "../../../../../tests/ui/dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { ReviewTabLabel } from "./TabLabels";
import type { ReviewStats } from "./registry";

function makeStats(overrides: Partial<ReviewStats> = {}): ReviewStats {
  return {
    total: 10,
    read: 4,
    unreadAssisted: 0,
    ...overrides,
  };
}

describe("ReviewTabLabel pizzazz indicator", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  function renderLabel(stats: ReviewStats | null) {
    return render(
      <TooltipProvider>
        <ReviewTabLabel reviewStats={stats} />
      </TooltipProvider>
    );
  }

  test("hides the pizzazz pill when no unread agent-flagged hunks exist", () => {
    // Read/total badge still shows; the assisted pill is conditional on
    // unreadAssisted > 0 so its absence is the user-visible signal that
    // there's nothing pending agent focus.
    const { container, getByText } = renderLabel(makeStats({ unreadAssisted: 0 }));

    expect(getByText("Review")).toBeTruthy();
    expect(getByText("4/10")).toBeTruthy();
    expect(container.querySelector("[data-testid='review-tab-assisted-pizzazz']")).toBeNull();
  });

  test("collapses the label into a single inline-flex group with the unread count", () => {
    // Behavioral: in the assisted state, the entire label (Review +
    // Sparkles + count) is one inline-flex items-center group tinted in
    // --color-review-accent. Wrapping everything in one alignment context
    // is what keeps the digit visually aligned with the icon — separately
    // baselined siblings drift apart.
    const { container, getByText, getByTestId, queryByText } = renderLabel(
      makeStats({ unreadAssisted: 3 })
    );

    const pill = getByTestId("review-tab-assisted-pizzazz");
    expect(pill).toBeTruthy();
    // Single shared alignment context — items-center keeps the digit
    // visually centered with the Sparkles icon. A regression to
    // items-baseline would re-introduce the misalignment the user
    // reported.
    expect(pill.className).toContain("items-center");
    expect(pill.className).toContain("inline-flex");
    // Accent color tints the entire group via cascade.
    expect(pill.className).toContain("text-review-accent");
    // No animation — explicitly assert because the previous iteration
    // shipped `animate-pulse` and the user found it distracting.
    expect(pill.className).not.toContain("animate-pulse");
    // No background chrome — chrome (bg + padding + rounded) broke the
    // parent strip's baseline rhythm. Keep this assertion so a future
    // "make it pop more" change can't quietly regress alignment.
    expect(pill.className).not.toContain("bg-review-accent");
    expect(pill.className).not.toContain("rounded");
    // Review word + count both render inside the indicator. The changing
    // numeric count must use the repo's semantic numeric utility, not raw
    // tabular-nums, so it matches other counters.
    expect(getByText("Review")).toBeTruthy();
    const count = getByText("3");
    expect(count.className).toContain("counter-nums");
    expect(count.className).not.toContain("tabular-nums");
    expect(pill.textContent ?? "").toContain("3");
    // Critical: the read/total backup badge is suppressed while there
    // are unread assisted hunks. Two adjacent numbers ("Review ✦ 3 4/10")
    // are hard to parse, so the assisted count owns the visual space.
    expect(queryByText("4/10")).toBeNull();
    expect(container).toBeTruthy();
  });

  test("singular aria-label for exactly one unread assisted hunk", () => {
    // Pluralization is a small but real correctness branch — guard it
    // explicitly so a regression like "Review — 1 unread agent-flagged
    // hunks" doesn't slip through.
    const { getByTestId } = renderLabel(makeStats({ unreadAssisted: 1 }));

    const pill = getByTestId("review-tab-assisted-pizzazz");
    expect(pill.getAttribute("aria-label")).toBe("Review — 1 unread agent-flagged hunk");
  });

  test("plural aria-label for multiple unread assisted hunks", () => {
    const { getByTestId } = renderLabel(makeStats({ unreadAssisted: 5 }));

    const pill = getByTestId("review-tab-assisted-pizzazz");
    expect(pill.getAttribute("aria-label")).toBe("Review — 5 unread agent-flagged hunks");
  });

  test("hides read/total badge when no review stats are available yet", () => {
    // Initial mount before the panel has reported any stats — the label
    // shouldn't render "0/0" noise, and (independently) the pizzazz pill
    // should also stay hidden because unreadAssisted defaults to 0.
    const { container, getByText, queryByText } = renderLabel(null);

    expect(getByText("Review")).toBeTruthy();
    expect(queryByText("0/0")).toBeNull();
    expect(container.querySelector("[data-testid='review-tab-assisted-pizzazz']")).toBeNull();
  });
});
