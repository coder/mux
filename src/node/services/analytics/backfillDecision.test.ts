import { describe, expect, test } from "bun:test";
import { shouldRunInitialBackfill } from "./backfillDecision";

describe("shouldRunInitialBackfill", () => {
  test("returns false when events exist but no watermarks", () => {
    expect(
      shouldRunInitialBackfill({
        eventCount: 1,
        watermarkCount: 0,
        sessionWorkspaceCount: 2,
      })
    ).toBe(false);
  });

  test("returns true when watermark rows cover only part of the session set", () => {
    expect(
      shouldRunInitialBackfill({
        eventCount: 10,
        watermarkCount: 1,
        sessionWorkspaceCount: 2,
      })
    ).toBe(true);
  });

  test("returns false when watermark rows already cover all session workspaces", () => {
    expect(
      shouldRunInitialBackfill({
        eventCount: 0,
        watermarkCount: 2,
        sessionWorkspaceCount: 2,
      })
    ).toBe(false);
  });

  test("returns true only for uninitialized analytics with session workspaces", () => {
    expect(
      shouldRunInitialBackfill({
        eventCount: 0,
        watermarkCount: 0,
        sessionWorkspaceCount: 1,
      })
    ).toBe(true);

    expect(
      shouldRunInitialBackfill({
        eventCount: 0,
        watermarkCount: 0,
        sessionWorkspaceCount: 0,
      })
    ).toBe(false);
  });
});
