import { describe, test, expect } from "bun:test";
import type { AutoCompactionCheckResult } from "./autoCompactionCheck";
import { shouldTriggerAutoCompaction } from "./shouldTriggerAutoCompaction";

describe("shouldTriggerAutoCompaction", () => {
  test("returns false when no autoCompactionCheck provided", () => {
    expect(shouldTriggerAutoCompaction(undefined, false, false)).toBe(false);
  });

  test("returns false when already compacting", () => {
    const check: AutoCompactionCheckResult = {
      usagePercentage: 80,
      thresholdPercentage: 60,
      shouldShowWarning: true,
      shouldForceCompact: false,
    };
    expect(shouldTriggerAutoCompaction(check, true, false)).toBe(false);
  });

  test("returns false when editing a message", () => {
    const check: AutoCompactionCheckResult = {
      usagePercentage: 80,
      thresholdPercentage: 60,
      shouldShowWarning: true,
      shouldForceCompact: false,
    };
    expect(shouldTriggerAutoCompaction(check, false, true)).toBe(false);
  });

  test("returns false when usage below threshold", () => {
    const check: AutoCompactionCheckResult = {
      usagePercentage: 50,
      thresholdPercentage: 60,
      shouldShowWarning: false,
      shouldForceCompact: false,
    };
    expect(shouldTriggerAutoCompaction(check, false, false)).toBe(false);
  });

  test("returns true when usage at threshold", () => {
    const check: AutoCompactionCheckResult = {
      usagePercentage: 60,
      thresholdPercentage: 60,
      shouldShowWarning: true,
      shouldForceCompact: false,
    };
    expect(shouldTriggerAutoCompaction(check, false, false)).toBe(true);
  });

  test("returns true when usage above threshold", () => {
    const check: AutoCompactionCheckResult = {
      usagePercentage: 85,
      thresholdPercentage: 60,
      shouldShowWarning: true,
      shouldForceCompact: false,
    };
    expect(shouldTriggerAutoCompaction(check, false, false)).toBe(true);
  });
});
