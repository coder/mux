import { describe, test, expect } from "bun:test";
import type { DiffHunk } from "@/common/types/review";
import { buildQuickHunkReviewNote } from "./quickReviewNotes";

function makeHunk(overrides: Partial<DiffHunk> = {}): DiffHunk {
  return {
    id: "hunk-1",
    filePath: "src/example.ts",
    oldStart: 10,
    oldLines: 3,
    newStart: 10,
    newLines: 3,
    content: "-const a = 1;\n+const a = 2;\n console.log(a);",
    header: "@@ -10,3 +10,3 @@",
    ...overrides,
  };
}

describe("buildQuickHunkReviewNote", () => {
  test("returns correct filePath and userNote", () => {
    const hunk = makeHunk();

    const note = buildQuickHunkReviewNote({
      hunk,
      userNote: "Looks good",
    });

    expect(note.filePath).toBe("src/example.ts");
    expect(note.userNote).toBe("Looks good");
  });

  test("builds correct lineRange from hunk coordinates", () => {
    const hunk = makeHunk({
      oldStart: 12,
      oldLines: 4,
      newStart: 20,
      newLines: 5,
      header: "@@ -12,4 +20,5 @@",
    });

    const note = buildQuickHunkReviewNote({
      hunk,
      userNote: "Coordinate check",
    });

    expect(note.lineRange).toBe("-12-15 +20-24");
  });

  test("includes selectedDiff matching hunk.content", () => {
    const hunk = makeHunk({
      content: "-old line\n+new line\n unchanged",
    });

    const note = buildQuickHunkReviewNote({
      hunk,
      userNote: "Diff included",
    });

    expect(note.selectedDiff).toBe(hunk.content);
  });

  test("handles small hunks by including all lines in selectedCode", () => {
    const hunk = makeHunk({
      oldStart: 40,
      oldLines: 5,
      newStart: 40,
      newLines: 5,
      header: "@@ -40,5 +40,5 @@",
      content: [
        "-const a = 1;",
        "+const a = 2;",
        " const b = 3;",
        "-console.log(a);",
        "+console.log(a, b);",
      ].join("\n"),
    });

    const note = buildQuickHunkReviewNote({
      hunk,
      userNote: "Small hunk",
    });

    const selectedLines = note.selectedCode.split("\n");

    expect(selectedLines).toHaveLength(5);
    expect(note.selectedCode).toContain("const a = 1;");
    expect(note.selectedCode).toContain("const a = 2;");
    expect(note.selectedCode).toContain("const b = 3;");
    expect(note.selectedCode).toContain("console.log(a);");
    expect(note.selectedCode).toContain("console.log(a, b);");
    expect(note.selectedCode).not.toContain("lines omitted");
  });

  test("handles large hunks by eliding middle lines when over 20 lines", () => {
    const content = Array.from(
      { length: 25 },
      (_, index) => `+const line${index + 1} = ${index + 1};`
    ).join("\n");

    const hunk = makeHunk({
      oldStart: 100,
      oldLines: 25,
      newStart: 200,
      newLines: 25,
      header: "@@ -100,25 +200,25 @@",
      content,
    });

    const note = buildQuickHunkReviewNote({
      hunk,
      userNote: "Large hunk",
    });

    const selectedLines = note.selectedCode.split("\n");

    expect(selectedLines).toHaveLength(21);
    expect(note.selectedCode).toContain("(5 lines omitted)");
    expect(note.selectedCode).toContain("const line1 = 1;");
    expect(note.selectedCode).toContain("const line10 = 10;");
    expect(note.selectedCode).toContain("const line16 = 16;");
    expect(note.selectedCode).toContain("const line25 = 25;");
    expect(note.selectedCode).not.toContain("const line11 = 11;");
    expect(note.selectedCode).not.toContain("const line15 = 15;");
  });
});
