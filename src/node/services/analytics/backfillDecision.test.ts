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
        hasWatermarkMissingSessionWorkspace: false,
        hasAnyWatermarkAtOrAboveZero: false,
      })
    ).toBe(true);

    expect(
      shouldRunInitialBackfill({
        eventCount: 0,
        watermarkCount: 0,
        sessionWorkspaceCount: 1,
        hasSessionWorkspaceMissingWatermark: true,
        hasWatermarkMissingSessionWorkspace: false,
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
        hasWatermarkMissingSessionWorkspace: false,
        hasAnyWatermarkAtOrAboveZero: false,
      })
    ).toBe(true);
  });

  test("returns true when a watermark references a workspace missing on disk", () => {
    expect(
      shouldRunInitialBackfill({
        eventCount: 3,
        watermarkCount: 2,
        sessionWorkspaceCount: 2,
        hasSessionWorkspaceMissingWatermark: false,
        hasWatermarkMissingSessionWorkspace: true,
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
        hasWatermarkMissingSessionWorkspace: false,
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
        hasWatermarkMissingSessionWorkspace: false,
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
        hasWatermarkMissingSessionWorkspace: false,
        hasAnyWatermarkAtOrAboveZero: true,
      })
    ).toBe(false);
  });

  test("returns false when there are no session workspaces and the DB is empty", () => {
    expect(
      shouldRunInitialBackfill({
        eventCount: 0,
        watermarkCount: 0,
        sessionWorkspaceCount: 0,
        hasSessionWorkspaceMissingWatermark: false,
        hasWatermarkMissingSessionWorkspace: false,
        hasAnyWatermarkAtOrAboveZero: false,
      })
    ).toBe(false);
  });

  test("returns true when there are no session workspaces but stale DB rows remain", () => {
    expect(
      shouldRunInitialBackfill({
        eventCount: 5,
        watermarkCount: 0,
        sessionWorkspaceCount: 0,
        hasSessionWorkspaceMissingWatermark: false,
        hasWatermarkMissingSessionWorkspace: false,
        hasAnyWatermarkAtOrAboveZero: true,
      })
    ).toBe(true);

    expect(
      shouldRunInitialBackfill({
        eventCount: 0,
        watermarkCount: 2,
        sessionWorkspaceCount: 0,
        hasSessionWorkspaceMissingWatermark: false,
        hasWatermarkMissingSessionWorkspace: false,
        hasAnyWatermarkAtOrAboveZero: false,
      })
    ).toBe(true);
  });
});
