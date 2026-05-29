import { describe, expect, it } from "bun:test";
import type { DiffHunk } from "@/common/types/review";
import { sliceHunkByNewLineRange } from "./sliceHunkContent";

/**
 * Build a synthetic hunk that goes from new-line `newStart` to `newStart+N-1`
 * with `N` context lines (no +/-). Useful for line-count math.
 */
function contextHunk(newStart: number, count: number): DiffHunk {
  const lines = Array.from({ length: count }, (_, i) => ` line${newStart + i}`).join("\n");
  return {
    id: "h",
    filePath: "src/foo.ts",
    oldStart: newStart,
    oldLines: count,
    newStart,
    newLines: count,
    content: lines,
    header: `@@ -${newStart},${count} +${newStart},${count} @@`,
  };
}

describe("sliceHunkByNewLineRange", () => {
  it("returns null when the range covers the whole hunk", () => {
    const hunk = contextHunk(10, 5); // lines 10..14
    expect(sliceHunkByNewLineRange(hunk, { start: 10, end: 14 })).toBeNull();
    expect(sliceHunkByNewLineRange(hunk, { start: 1, end: 999 })).toBeNull();
  });

  it("returns null when the range is fully outside the hunk", () => {
    const hunk = contextHunk(10, 5);
    expect(sliceHunkByNewLineRange(hunk, { start: 100, end: 200 })).toBeNull();
    expect(sliceHunkByNewLineRange(hunk, { start: 1, end: 5 })).toBeNull();
  });

  it("returns null for pure deletions (newLines === 0)", () => {
    const hunk: DiffHunk = {
      id: "h",
      filePath: "src/foo.ts",
      oldStart: 10,
      oldLines: 3,
      newStart: 10,
      newLines: 0,
      content: "-removed1\n-removed2\n-removed3",
      header: "@@",
    };
    expect(sliceHunkByNewLineRange(hunk, { start: 10, end: 12 })).toBeNull();
  });

  it("splits a context-only hunk into before/inside/after", () => {
    const hunk = contextHunk(10, 5); // lines 10,11,12,13,14
    const slice = sliceHunkByNewLineRange(hunk, { start: 12, end: 13 });
    expect(slice).not.toBeNull();
    if (!slice) return;
    expect(slice.beforeContent.split("\n")).toEqual([" line10", " line11"]);
    expect(slice.insideContent.split("\n")).toEqual([" line12", " line13"]);
    expect(slice.afterContent.split("\n")).toEqual([" line14"]);
    // Line-number starts mirror the diff numbering walk.
    expect(slice.beforeOldStart).toBe(10);
    expect(slice.beforeNewStart).toBe(10);
    expect(slice.insideOldStart).toBe(12);
    expect(slice.insideNewStart).toBe(12);
    expect(slice.afterOldStart).toBe(14);
    expect(slice.afterNewStart).toBe(14);
    expect(slice.beforeLineCount).toBe(2);
    expect(slice.afterLineCount).toBe(1);
  });

  it("groups deletion lines with the following region's bucket", () => {
    // Hunk: -10 (removed), +10 new line, +11 inside, -11 trailing (removed)
    const hunk: DiffHunk = {
      id: "h",
      filePath: "src/foo.ts",
      oldStart: 10,
      oldLines: 2,
      newStart: 10,
      newLines: 2,
      content: ["-old10", "+new10", "+new11", "-old11"].join("\n"),
      header: "@@",
    };
    const slice = sliceHunkByNewLineRange(hunk, { start: 11, end: 11 });
    expect(slice).not.toBeNull();
    if (!slice) return;
    // `-old10` precedes the +10 line (in `before`) → goes with before.
    expect(slice.beforeContent.split("\n")).toEqual(["-old10", "+new10"]);
    // The inside slice keeps the trailing `-old11` because no later non-`-` exists.
    expect(slice.insideContent.split("\n")).toEqual(["+new11", "-old11"]);
    expect(slice.afterContent).toBe("");
    expect(slice.afterLineCount).toBe(0);
  });

  it("returns null when the inside slice would be empty", () => {
    // Hunk has only one new-line (10), agent asked for 5..9 (outside).
    const hunk = contextHunk(10, 3); // 10,11,12
    expect(sliceHunkByNewLineRange(hunk, { start: 5, end: 9 })).toBeNull();
  });

  it("works at hunk boundaries (inside-only-front)", () => {
    const hunk = contextHunk(10, 5); // 10..14
    const slice = sliceHunkByNewLineRange(hunk, { start: 10, end: 11 });
    expect(slice).not.toBeNull();
    if (!slice) return;
    expect(slice.beforeContent).toBe("");
    expect(slice.beforeLineCount).toBe(0);
    expect(slice.insideContent.split("\n")).toEqual([" line10", " line11"]);
    expect(slice.afterContent.split("\n")).toEqual([" line12", " line13", " line14"]);
  });
});
