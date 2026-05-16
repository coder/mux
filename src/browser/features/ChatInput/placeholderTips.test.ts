import { describe, expect, test } from "bun:test";
import { PLACEHOLDER_TIPS, getPlaceholderTip } from "./placeholderTips";

const TWENTY_MIN_MS = 20 * 60 * 1000;

describe("getPlaceholderTip", () => {
  test("returns the same tip for every call inside a single 20-minute bucket", () => {
    // Anchor at a bucket boundary so any ms within the next 20 min must hash
    // to the same tip. If they don't, switching workspaces / re-rendering
    // inside the same bucket would reshuffle the tip — which is the exact
    // flicker we're trying to prevent.
    const bucketStart = TWENTY_MIN_MS * 100; // arbitrary aligned anchor
    const tip = getPlaceholderTip(bucketStart);
    expect(getPlaceholderTip(bucketStart + 1)).toBe(tip);
    expect(getPlaceholderTip(bucketStart + TWENTY_MIN_MS - 1)).toBe(tip);
  });

  test("advances to the next tip when the bucket boundary crosses", () => {
    // Crossing the boundary must rotate — otherwise the carousel is silently
    // stuck and the discoverability rationale is broken.
    const bucketStart = TWENTY_MIN_MS * 100;
    const before = getPlaceholderTip(bucketStart);
    const after = getPlaceholderTip(bucketStart + TWENTY_MIN_MS);
    expect(after).not.toBe(before);
  });

  test("wraps with modulo so long-running clocks never lose the placeholder", () => {
    // Far-future timestamps should still resolve to a tip rather than
    // undefined / out-of-bounds.
    const bigFuture = TWENTY_MIN_MS * PLACEHOLDER_TIPS.length * 5 + TWENTY_MIN_MS * 3;
    expect(PLACEHOLDER_TIPS).toContain(getPlaceholderTip(bigFuture));
  });

  test("falls back to the lead tip on non-finite or negative inputs", () => {
    // Defensive: mocked timers, broken clocks, or accidentally-passed
    // sentinels should never produce undefined or throw.
    expect(getPlaceholderTip(-1)).toBe(PLACEHOLDER_TIPS[0]);
    expect(getPlaceholderTip(Number.NaN)).toBe(PLACEHOLDER_TIPS[0]);
    expect(getPlaceholderTip(Number.POSITIVE_INFINITY)).toBe(PLACEHOLDER_TIPS[0]);
  });

  test("includes a tip surfacing the /orchestrate skill", () => {
    // /orchestrate is unadvertised in the system-prompt skill index, so the
    // tip carousel is one of the few discovery surfaces users will see it
    // on. If this tip disappears the skill becomes effectively invisible.
    expect(PLACEHOLDER_TIPS.some((tip) => tip.includes("/orchestrate"))).toBe(true);
  });
});
