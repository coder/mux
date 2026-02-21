/**
 * Tests for review panel navigation utilities.
 *
 * These tests verify that navigation respects the order of hunks passed in,
 * which is critical for sort-aware navigation (e.g., "last-edit" sorting).
 */

import { describe, test, expect } from "bun:test";
import {
  findNextHunkId,
  findNextHunkIdAfterFileRemoval,
  flattenFileTreeLeaves,
  getAdjacentFilePath,
  getFileHunks,
} from "./navigation";
import type { DiffHunk } from "@/common/types/review";
import type { FileTreeNode } from "@/common/utils/git/numstatParser";

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

describe("flattenFileTreeLeaves", () => {
  test("returns empty array for null input", () => {
    expect(flattenFileTreeLeaves(null)).toEqual([]);
  });

  test("returns single file for a flat tree", () => {
    const root: FileTreeNode = {
      name: "",
      path: "",
      isDirectory: true,
      children: [
        {
          name: "index.ts",
          path: "index.ts",
          isDirectory: false,
          children: [],
        },
      ],
    };

    expect(flattenFileTreeLeaves(root)).toEqual(["index.ts"]);
  });

  test("returns multiple files in depth-first order for a nested tree", () => {
    const root: FileTreeNode = {
      name: "",
      path: "",
      isDirectory: true,
      children: [
        {
          name: "src",
          path: "src",
          isDirectory: true,
          children: [
            {
              name: "components",
              path: "src/components",
              isDirectory: true,
              children: [
                {
                  name: "Button.tsx",
                  path: "src/components/Button.tsx",
                  isDirectory: false,
                  children: [],
                },
                {
                  name: "Card.tsx",
                  path: "src/components/Card.tsx",
                  isDirectory: false,
                  children: [],
                },
              ],
            },
            {
              name: "index.ts",
              path: "src/index.ts",
              isDirectory: false,
              children: [],
            },
          ],
        },
        {
          name: "README.md",
          path: "README.md",
          isDirectory: false,
          children: [],
        },
      ],
    };

    expect(flattenFileTreeLeaves(root)).toEqual([
      "src/components/Button.tsx",
      "src/components/Card.tsx",
      "src/index.ts",
      "README.md",
    ]);
  });

  test("normalizes rename syntax to renamed leaf paths", () => {
    const root: FileTreeNode = {
      name: "",
      path: "",
      isDirectory: true,
      children: [
        {
          name: "src",
          path: "src",
          isDirectory: true,
          children: [
            {
              name: "{oldName.ts => newName.ts}",
              path: "src/{oldName.ts => newName.ts}",
              isDirectory: false,
              children: [],
            },
          ],
        },
        {
          name: "README.old.md => README.md",
          path: "README.old.md => README.md",
          isDirectory: false,
          children: [],
        },
      ],
    };

    expect(flattenFileTreeLeaves(root)).toEqual(["src/newName.ts", "README.md"]);
  });

  test("skips directory nodes and only returns leaf file paths", () => {
    const root: FileTreeNode = {
      name: "",
      path: "",
      isDirectory: true,
      children: [
        {
          name: "packages",
          path: "packages",
          isDirectory: true,
          children: [
            {
              name: "core",
              path: "packages/core",
              isDirectory: true,
              children: [
                {
                  name: "index.ts",
                  path: "packages/core/index.ts",
                  isDirectory: false,
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    };

    const result = flattenFileTreeLeaves(root);

    expect(result).toEqual(["packages/core/index.ts"]);
    expect(result).not.toContain("packages");
    expect(result).not.toContain("packages/core");
  });
});

describe("getAdjacentFilePath", () => {
  test("returns null for empty file list", () => {
    expect(getAdjacentFilePath([], "src/a.ts", 1)).toBeNull();
  });

  test("returns first file if current is not in list", () => {
    const files = ["src/a.ts", "src/b.ts", "src/c.ts"];

    expect(getAdjacentFilePath(files, "src/missing.ts", 1)).toBe("src/a.ts");
  });

  test("returns next file for direction 1", () => {
    const files = ["src/a.ts", "src/b.ts", "src/c.ts"];

    expect(getAdjacentFilePath(files, "src/b.ts", 1)).toBe("src/c.ts");
  });

  test("returns previous file for direction -1", () => {
    const files = ["src/a.ts", "src/b.ts", "src/c.ts"];

    expect(getAdjacentFilePath(files, "src/b.ts", -1)).toBe("src/a.ts");
  });

  test("wraps around from last to first for direction 1", () => {
    const files = ["src/a.ts", "src/b.ts", "src/c.ts"];

    expect(getAdjacentFilePath(files, "src/c.ts", 1)).toBe("src/a.ts");
  });

  test("wraps around from first to last for direction -1", () => {
    const files = ["src/a.ts", "src/b.ts", "src/c.ts"];

    expect(getAdjacentFilePath(files, "src/a.ts", -1)).toBe("src/c.ts");
  });
});

describe("getFileHunks", () => {
  test("returns empty array if no hunks match", () => {
    const hunks = [makeHunk("a", "src/a.ts"), makeHunk("b", "src/b.ts")];

    expect(getFileHunks(hunks, "src/c.ts")).toEqual([]);
  });

  test("returns only hunks matching the file path", () => {
    const hunkA = makeHunk("a", "src/a.ts");
    const hunkB = makeHunk("b", "src/b.ts");
    const hunks = [hunkA, hunkB];

    expect(getFileHunks(hunks, "src/b.ts")).toEqual([hunkB]);
  });

  test("returns multiple hunks for the same file", () => {
    const hunkA1 = makeHunk("a1", "src/a.ts");
    const hunkB = makeHunk("b", "src/b.ts");
    const hunkA2 = makeHunk("a2", "src/a.ts");
    const hunks = [hunkA1, hunkB, hunkA2];

    expect(getFileHunks(hunks, "src/a.ts")).toEqual([hunkA1, hunkA2]);
  });
});
