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

  test("shows the assisted-focus indicator with the unread count when assisted hunks pending", () => {
    // Behavioral: the Sparkles icon + count appears in --color-review-accent
    // whenever there's at least one agent-flagged hunk the user hasn't
    // marked read. The "Review" word is tinted in the same accent so the
    // label reads as a single attention cue (mirrors Goal tab tinting).
    // No animation — pulsing was too noisy next to other tabs.
    const { container, getByText, getByTestId } = renderLabel(makeStats({ unreadAssisted: 3 }));

    const pill = getByTestId("review-tab-assisted-pizzazz");
    expect(pill).toBeTruthy();
    // Accent color is the actual "pizzazz" — guard against accidental
    // regression to muted / no-color.
    expect(pill.className).toContain("text-review-accent");
    // No animation — explicitly assert because the previous iteration
    // shipped `animate-pulse` and the user found it distracting.
    expect(pill.className).not.toContain("animate-pulse");
    // No background chrome — the pill chrome (bg + padding) broke baseline
    // alignment in the parent strip (`items-baseline gap-1.5`). Keep this
    // assertion so a future "make it pop more" change doesn't regress
    // alignment.
    expect(pill.className).not.toContain("bg-review-accent");
    expect(pill.className).not.toContain("rounded");
    // Count is visible inside the indicator.
    expect(pill.textContent ?? "").toContain("3");
    // "Review" word itself is tinted accent so the whole label reads as
    // one cue rather than label + decoration.
    const reviewWord = getByText("Review");
    expect(reviewWord.className).toContain("text-review-accent");
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
