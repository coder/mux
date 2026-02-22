import { describe, expect, test } from "bun:test";
import { shouldRunInitialBackfill } from "./backfillDecision";

describe("shouldRunInitialBackfill", () => {
  test("returns true when session workspaces exist but watermark coverage is missing", () => {
    expect(
      shouldRunInitialBackfill({
        eventCount: 1,
        watermarkCount: 0,
        sessionWorkspaceCount: 2,
        hasAnyWatermarkAtOrAboveZero: false,
      })
    ).toBe(true);

    expect(
      shouldRunInitialBackfill({
        eventCount: 0,
        watermarkCount: 0,
        sessionWorkspaceCount: 1,
        hasAnyWatermarkAtOrAboveZero: false,
      })
    ).toBe(true);
  });

  test("returns true when watermark rows cover only part of the session set", () => {
    expect(
      shouldRunInitialBackfill({
        eventCount: 10,
        watermarkCount: 1,
        sessionWorkspaceCount: 2,
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
        hasAnyWatermarkAtOrAboveZero: false,
      })
    ).toBe(false);

    expect(
      shouldRunInitialBackfill({
        eventCount: 5,
        watermarkCount: 0,
        sessionWorkspaceCount: 0,
        hasAnyWatermarkAtOrAboveZero: true,
      })
    ).toBe(false);
  });
});
