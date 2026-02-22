import { describe, expect, test } from "bun:test";
import { shouldRunInitialBackfill } from "./backfillDecision";

describe("shouldRunInitialBackfill", () => {
  test("returns true when session workspaces exist but watermark coverage is missing", () => {
    expect(
      shouldRunInitialBackfill({
        eventCount: 1,
        watermarkCount: 0,
        sessionWorkspaceCount: 2,
        hasSessionWorkspaceMissingWatermark: true,
        hasAnyWatermarkAtOrAboveZero: false,
      })
    ).toBe(true);

    expect(
      shouldRunInitialBackfill({
        eventCount: 0,
        watermarkCount: 0,
        sessionWorkspaceCount: 1,
        hasSessionWorkspaceMissingWatermark: true,
        hasAnyWatermarkAtOrAboveZero: false,
      })
    ).toBe(true);
  });

  test("returns true when any session workspace is missing a watermark row", () => {
    expect(
      shouldRunInitialBackfill({
        eventCount: 10,
        watermarkCount: 1,
        sessionWorkspaceCount: 2,
        hasSessionWorkspaceMissingWatermark: true,
        hasAnyWatermarkAtOrAboveZero: false,
      })
    ).toBe(true);
  });

  test("returns true when watermark count matches but IDs are stale", () => {
    expect(
      shouldRunInitialBackfill({
        eventCount: 3,
        watermarkCount: 2,
        sessionWorkspaceCount: 2,
        hasSessionWorkspaceMissingWatermark: true,
        hasAnyWatermarkAtOrAboveZero: false,
      })
    ).toBe(true);
  });

  test("returns true when events are missing but watermarks show prior assistant history", () => {
    expect(
      shouldRunInitialBackfill({
        eventCount: 0,
        watermarkCount: 2,
        sessionWorkspaceCount: 2,
        hasSessionWorkspaceMissingWatermark: false,
        hasAnyWatermarkAtOrAboveZero: true,
      })
    ).toBe(true);
  });

  test("returns false for fully initialized zero-event histories", () => {
    expect(
      shouldRunInitialBackfill({
        eventCount: 0,
        watermarkCount: 2,
        sessionWorkspaceCount: 2,
        hasSessionWorkspaceMissingWatermark: false,
        hasAnyWatermarkAtOrAboveZero: false,
      })
    ).toBe(false);
  });

  test("returns false when events already exist and watermark coverage is complete", () => {
    expect(
      shouldRunInitialBackfill({
        eventCount: 3,
        watermarkCount: 2,
        sessionWorkspaceCount: 2,
        hasSessionWorkspaceMissingWatermark: false,
        hasAnyWatermarkAtOrAboveZero: true,
      })
    ).toBe(false);
  });

  test("returns false when there are no session workspaces", () => {
    expect(
      shouldRunInitialBackfill({
        eventCount: 0,
        watermarkCount: 0,
        sessionWorkspaceCount: 0,
        hasSessionWorkspaceMissingWatermark: false,
        hasAnyWatermarkAtOrAboveZero: false,
      })
    ).toBe(false);

    expect(
      shouldRunInitialBackfill({
        eventCount: 5,
        watermarkCount: 0,
        sessionWorkspaceCount: 0,
        hasSessionWorkspaceMissingWatermark: false,
        hasAnyWatermarkAtOrAboveZero: true,
      })
    ).toBe(false);
  });
});
