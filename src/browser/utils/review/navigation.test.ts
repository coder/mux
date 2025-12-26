/**
 * Tests for review panel navigation utilities.
 *
 * These tests verify that navigation respects the order of hunks passed in,
 * which is critical for sort-aware navigation (e.g., "last-edit" sorting).
 */

import { describe, test, expect } from "bun:test";
import { findNextHunkId, findNextHunkIdAfterFileRemoval } from "./navigation";
import type { DiffHunk } from "@/common/types/review";

// Helper to create minimal DiffHunk for testing
function makeHunk(id: string, filePath: string): DiffHunk {
  return {
    id,
    filePath,
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    content: "",
    header: "@@ -1,1 +1,1 @@",
    changeType: "modified",
  };
}

describe("findNextHunkId", () => {
  test("returns next hunk when current is not last", () => {
    // Hunks sorted by "last-edit" (newest first): C -> B -> A
    const hunks = [makeHunk("C", "c.ts"), makeHunk("B", "b.ts"), makeHunk("A", "a.ts")];

    expect(findNextHunkId(hunks, "C")).toBe("B");
    expect(findNextHunkId(hunks, "B")).toBe("A");
  });

  test("returns previous hunk when current is last", () => {
    const hunks = [makeHunk("C", "c.ts"), makeHunk("B", "b.ts"), makeHunk("A", "a.ts")];

    expect(findNextHunkId(hunks, "A")).toBe("B");
  });

  test("returns null when only one hunk", () => {
    const hunks = [makeHunk("only", "only.ts")];

    expect(findNextHunkId(hunks, "only")).toBeNull();
  });

  test("returns null when hunk not found", () => {
    const hunks = [makeHunk("A", "a.ts"), makeHunk("B", "b.ts")];

    expect(findNextHunkId(hunks, "nonexistent")).toBeNull();
  });

  test("returns null for empty array", () => {
    expect(findNextHunkId([], "any")).toBeNull();
  });

  test("respects sort order - navigation follows array order not file order", () => {
    // This is the key regression test:
    // If hunks are sorted by last-edit (newest first), navigation should
    // follow that order, NOT the original file order.
    //
    // File order: a.ts, b.ts, c.ts
    // Sort by last-edit (newest first): c.ts (5m ago), a.ts (1h ago), b.ts (2h ago)
    const hunks = [
      makeHunk("C", "c.ts"), // newest
      makeHunk("A", "a.ts"), // middle
      makeHunk("B", "b.ts"), // oldest
    ];

    // When on C (first in sorted order), next should be A, not B
    expect(findNextHunkId(hunks, "C")).toBe("A");

    // When on A (middle in sorted order), next should be B
    expect(findNextHunkId(hunks, "A")).toBe("B");

    // When on B (last in sorted order), should go back to A
    expect(findNextHunkId(hunks, "B")).toBe("A");
  });
});

describe("findNextHunkIdAfterFileRemoval", () => {
  test("returns next hunk in different file (forward)", () => {
    const hunks = [
      makeHunk("A1", "a.ts"),
      makeHunk("A2", "a.ts"),
      makeHunk("B1", "b.ts"),
      makeHunk("C1", "c.ts"),
    ];

    // Removing all of a.ts, starting from A1 -> should go to B1
    expect(findNextHunkIdAfterFileRemoval(hunks, "A1", "a.ts")).toBe("B1");

    // Removing all of a.ts, starting from A2 -> should go to B1
    expect(findNextHunkIdAfterFileRemoval(hunks, "A2", "a.ts")).toBe("B1");
  });

  test("returns previous hunk in different file when no next", () => {
    const hunks = [makeHunk("A1", "a.ts"), makeHunk("B1", "b.ts"), makeHunk("B2", "b.ts")];

    // Removing all of b.ts, starting from B1 -> should go to A1
    expect(findNextHunkIdAfterFileRemoval(hunks, "B1", "b.ts")).toBe("A1");
  });

  test("returns null when all hunks are in same file", () => {
    const hunks = [makeHunk("A1", "a.ts"), makeHunk("A2", "a.ts")];

    expect(findNextHunkIdAfterFileRemoval(hunks, "A1", "a.ts")).toBeNull();
  });

  test("respects sort order for file removal navigation", () => {
    // Sorted by last-edit: c.ts (newest), a.ts, b.ts (oldest)
    // a.ts has 2 hunks
    const hunks = [
      makeHunk("C1", "c.ts"),
      makeHunk("A1", "a.ts"),
      makeHunk("A2", "a.ts"),
      makeHunk("B1", "b.ts"),
    ];

    // When removing a.ts from A1, next different file should be B1 (forward in sort order)
    expect(findNextHunkIdAfterFileRemoval(hunks, "A1", "a.ts")).toBe("B1");

    // When removing c.ts from C1, next different file should be A1 (forward in sort order)
    expect(findNextHunkIdAfterFileRemoval(hunks, "C1", "c.ts")).toBe("A1");

    // When removing b.ts from B1, should go back to A2 (backward, different file)
    expect(findNextHunkIdAfterFileRemoval(hunks, "B1", "b.ts")).toBe("A2");
  });
});
