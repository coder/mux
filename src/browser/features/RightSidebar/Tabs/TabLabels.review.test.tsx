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

  test("shows the pizzazz pill with the unread count when assisted hunks pending", () => {
    // Behavioral: the pill (with Sparkles icon + count + animate-pulse)
    // appears whenever there's at least one agent-flagged hunk the user
    // hasn't marked read. This is the "look at me" cue surfaced from the
    // Review pane onto the tab strip.
    const { container, getByText, getByTestId } = renderLabel(makeStats({ unreadAssisted: 3 }));

    const pill = getByTestId("review-tab-assisted-pizzazz");
    expect(pill).toBeTruthy();
    // Pulse animation must be present — that's the actual "pizzazz".
    expect(pill.className).toContain("animate-pulse");
    // Accent must be the review-accent color (matches the rest of the
    // assisted-review surface).
    expect(pill.className).toContain("text-review-accent");
    // Count is visible inside the pill.
    expect(pill.textContent ?? "").toContain("3");
    // Read/total still renders alongside.
    expect(getByText("4/10")).toBeTruthy();
    expect(container).toBeTruthy();
  });

  test("singular aria-label for exactly one unread assisted hunk", () => {
    // Pluralization is a small but real correctness branch — guard it
    // explicitly so a regression like "1 unread agent-flagged hunks" doesn't
    // slip through.
    const { getByTestId } = renderLabel(makeStats({ unreadAssisted: 1 }));

    const pill = getByTestId("review-tab-assisted-pizzazz");
    expect(pill.getAttribute("aria-label")).toBe("1 unread agent-flagged hunk");
  });

  test("plural aria-label for multiple unread assisted hunks", () => {
    const { getByTestId } = renderLabel(makeStats({ unreadAssisted: 5 }));

    const pill = getByTestId("review-tab-assisted-pizzazz");
    expect(pill.getAttribute("aria-label")).toBe("5 unread agent-flagged hunks");
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
