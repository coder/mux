import { describe, expect, test } from "bun:test";

import { shouldCheckpointAfterSync } from "./checkpointDecision";

describe("shouldCheckpointAfterSync", () => {
  test("returns false for noop regardless of counts", () => {
    expect(shouldCheckpointAfterSync("noop", 5, 3)).toBe(false);
  });

  test("returns false for incremental with zero writes", () => {
    expect(shouldCheckpointAfterSync("incremental", 0, 0)).toBe(false);
  });

  test("returns true for full_rebuild with ingested workspaces", () => {
    expect(shouldCheckpointAfterSync("full_rebuild", 10, 0)).toBe(true);
  });

  test("returns true for incremental with ingested workspaces", () => {
    expect(shouldCheckpointAfterSync("incremental", 3, 0)).toBe(true);
  });

  test("returns true for incremental with purged workspaces only", () => {
    expect(shouldCheckpointAfterSync("incremental", 0, 2)).toBe(true);
  });

  test("returns true for full_rebuild even with zero ingested (purge-only rebuild)", () => {
    // full_rebuild always writes (it clears tables), so always checkpoint
    expect(shouldCheckpointAfterSync("full_rebuild", 0, 0)).toBe(true);
  });
});
