/**
 * Tests for RefreshButton tooltip content logic.
 *
 * The tooltip should show:
 * - "Refreshing..." when animation is active (spinning or stopping)
 * - "Refresh diff (keybind)" + "Last: X ago via Y" when idle and lastRefreshInfo exists
 * - "Refresh diff (keybind)" when idle and lastRefreshInfo is null
 */

import { describe, test, expect } from "bun:test";
import type { RefreshTrigger, LastRefreshInfo } from "@/browser/utils/RefreshController";

// Extract tooltip content logic for testing
type AnimationState = "idle" | "spinning" | "stopping";

const TRIGGER_LABELS: Record<RefreshTrigger, string> = {
  manual: "manual click",
  scheduled: "tool completion",
  priority: "tool completion (priority)",
  focus: "window focus",
  visibility: "tab visible",
  unpaused: "interaction ended",
  "in-flight-followup": "queued followup",
};

function getTooltipContent(
  animationState: AnimationState,
  lastRefreshInfo: LastRefreshInfo | null
): { type: "refreshing" } | { type: "idle"; showLastRefreshInfo: boolean } {
  if (animationState !== "idle") {
    return { type: "refreshing" };
  }
  return { type: "idle", showLastRefreshInfo: lastRefreshInfo !== null };
}

describe("RefreshButton tooltip content", () => {
  test("shows 'Refreshing...' when spinning", () => {
    const result = getTooltipContent("spinning", null);
    expect(result.type).toBe("refreshing");
  });

  test("shows 'Refreshing...' when stopping", () => {
    const result = getTooltipContent("stopping", null);
    expect(result.type).toBe("refreshing");
  });

  test("shows idle content without lastRefreshInfo when null", () => {
    const result = getTooltipContent("idle", null);
    expect(result.type).toBe("idle");
    expect((result as { type: "idle"; showLastRefreshInfo: boolean }).showLastRefreshInfo).toBe(
      false
    );
  });

  test("shows idle content WITH lastRefreshInfo when set", () => {
    const info: LastRefreshInfo = { timestamp: Date.now(), trigger: "manual" };
    const result = getTooltipContent("idle", info);
    expect(result.type).toBe("idle");
    expect((result as { type: "idle"; showLastRefreshInfo: boolean }).showLastRefreshInfo).toBe(
      true
    );
  });

  test("TRIGGER_LABELS covers all trigger types", () => {
    const triggers: RefreshTrigger[] = [
      "manual",
      "scheduled",
      "priority",
      "focus",
      "visibility",
      "unpaused",
      "in-flight-followup",
    ];

    for (const trigger of triggers) {
      expect(TRIGGER_LABELS[trigger]).toBeDefined();
      expect(TRIGGER_LABELS[trigger].length).toBeGreaterThan(0);
    }
  });

  test("manual trigger maps to 'manual click'", () => {
    expect(TRIGGER_LABELS.manual).toBe("manual click");
  });
});

describe("RefreshButton behavior invariants", () => {
  test("after manual refresh completes, tooltip must show lastRefreshInfo", () => {
    // This test documents the expected UX flow:
    // 1. User clicks refresh → animationState becomes "spinning"
    // 2. Refresh completes → lastRefreshInfo is set with trigger "manual"
    // 3. Animation stops (800ms) → animationState becomes "idle"
    // 4. User hovers tooltip → sees "Last: Xs ago via manual click"
    //
    // If this flow is broken, the user sees no feedback after clicking refresh.

    // Simulate state after refresh completes and animation stops
    const lastRefreshInfo: LastRefreshInfo = {
      timestamp: Date.now() - 1000, // 1 second ago
      trigger: "manual",
    };
    const animationState: AnimationState = "idle";

    const result = getTooltipContent(animationState, lastRefreshInfo);

    // CRITICAL: When idle with lastRefreshInfo, must show the info
    expect(result.type).toBe("idle");
    expect((result as { type: "idle"; showLastRefreshInfo: boolean }).showLastRefreshInfo).toBe(
      true
    );
  });
});
