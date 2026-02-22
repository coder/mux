import { describe, expect, test } from "bun:test";
import { shouldRunInitialBackfill } from "./backfillDecision";

describe("shouldRunInitialBackfill", () => {
  test("returns true when session workspaces exist but watermark coverage is missing", () => {
    expect(
      shouldRunInitialBackfill({
        eventCount: 1,
        watermarkCount: 0,
        sessionWorkspaceCount: 2,
      })
    ).toBe(true);

    expect(
      shouldRunInitialBackfill({
        eventCount: 0,
        watermarkCount: 0,
        sessionWorkspaceCount: 1,
      })
    ).toBe(true);
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

  test("returns false when there are no session workspaces", () => {
    expect(
      shouldRunInitialBackfill({
        eventCount: 0,
        watermarkCount: 0,
        sessionWorkspaceCount: 0,
      })
    ).toBe(false);

    expect(
      shouldRunInitialBackfill({
        eventCount: 5,
        watermarkCount: 0,
        sessionWorkspaceCount: 0,
      })
    ).toBe(false);
  });
});
