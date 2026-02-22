import { describe, expect, test } from "bun:test";
import { shouldRunInitialBackfill } from "./backfillDecision";

describe("shouldRunInitialBackfill", () => {
  test("returns false when events already exist", () => {
    expect(
      shouldRunInitialBackfill({
        eventCount: 1,
        watermarkCount: 0,
        hasSessionDirectories: true,
      })
    ).toBe(false);
  });

  test("returns false when watermark rows already exist but events are empty", () => {
    expect(
      shouldRunInitialBackfill({
        eventCount: 0,
        watermarkCount: 1,
        hasSessionDirectories: true,
      })
    ).toBe(false);
  });

  test("returns true only for uninitialized analytics with session directories", () => {
    expect(
      shouldRunInitialBackfill({
        eventCount: 0,
        watermarkCount: 0,
        hasSessionDirectories: true,
      })
    ).toBe(true);

    expect(
      shouldRunInitialBackfill({
        eventCount: 0,
        watermarkCount: 0,
        hasSessionDirectories: false,
      })
    ).toBe(false);
  });
});
