import { describe, test, expect } from "bun:test";
import type { DiffHunk } from "@/common/types/review";
import { buildQuickHunkReviewNote, buildQuickLineReviewNote } from "./quickReviewNotes";

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

describe("buildQuickLineReviewNote", () => {
  test("builds note data for a single selected line", () => {
    const hunk = makeHunk({
      content: "-const a = 1;\n+const a = 2;\n const b = a;",
    });

    const note = buildQuickLineReviewNote({
      hunk,
      startIndex: 1,
      endIndex: 1,
      userNote: "Use a constant here",
    });

    expect(note.lineRange).toBe("+10");
    expect(note.selectedDiff).toBe("+const a = 2;");
    expect(note.selectedCode).toContain("+ const a = 2;");
    expect(note.oldStart).toBe(1);
    expect(note.newStart).toBe(10);
    expect(note.userNote).toBe("Use a constant here");
  });

  test("builds ranges from selected line span", () => {
    const hunk = makeHunk({
      oldStart: 50,
      oldLines: 4,
      newStart: 50,
      newLines: 4,
      content: "-const a = 1;\n+const a = 2;\n const b = 3;\n-console.log(a);\n+console.log(a, b);",
      header: "@@ -50,4 +50,4 @@",
    });

    const note = buildQuickLineReviewNote({
      hunk,
      startIndex: 0,
      endIndex: 2,
      userNote: "Please revisit this block",
    });

    expect(note.lineRange).toBe("-50-51 +50-51");
    expect(note.selectedDiff).toBe("-const a = 1;\n+const a = 2;\n const b = 3;");
    expect(note.oldStart).toBe(50);
    expect(note.newStart).toBe(50);
  });

  test("keeps old/new coordinates for context-only selections", () => {
    const hunk = makeHunk({
      oldStart: 30,
      oldLines: 3,
      newStart: 40,
      newLines: 3,
      content:
        "-const removed = 1;\n+const added = 1;\n const keepOne = added;\n const keepTwo = keepOne;",
      header: "@@ -30,3 +40,3 @@",
    });

    const note = buildQuickLineReviewNote({
      hunk,
      startIndex: 2,
      endIndex: 3,
      userNote: "Context-only selection",
    });

    expect(note.lineRange).toBe("-31-32 +41-42");
    expect(note.selectedDiff).toBe(" const keepOne = added;\n const keepTwo = keepOne;");
    expect(note.oldStart).toBe(31);
    expect(note.newStart).toBe(41);
  });

  test("clamps out-of-bounds selection indices", () => {
    const hunk = makeHunk({
      content: "-old\n+new\n context",
      oldStart: 7,
      oldLines: 2,
      newStart: 7,
      newLines: 2,
    });

    const note = buildQuickLineReviewNote({
      hunk,
      startIndex: -50,
      endIndex: 99,
      userNote: "Clamp selection",
    });

    expect(note.lineRange).toBe("-7-8 +7-8");
    expect(note.selectedDiff).toBe("-old\n+new\n context");
  });

  test("elides selectedCode for ranges longer than 20 lines", () => {
    const content = Array.from(
      { length: 30 },
      (_, index) => `+const line${index + 1} = ${index + 1};`
    ).join("\n");

    const hunk = makeHunk({
      oldStart: 1,
      oldLines: 30,
      newStart: 100,
      newLines: 30,
      content,
      header: "@@ -1,30 +100,30 @@",
    });

    const note = buildQuickLineReviewNote({
      hunk,
      startIndex: 0,
      endIndex: 29,
      userNote: "Large range",
    });

    const selectedLines = note.selectedCode.split("\n");
    expect(selectedLines).toHaveLength(21);
    expect(note.selectedCode).toContain("(10 lines omitted)");
    expect(note.selectedCode).toContain("const line1 = 1;");
    expect(note.selectedCode).toContain("const line10 = 10;");
    expect(note.selectedCode).toContain("const line21 = 21;");
    expect(note.selectedCode).toContain("const line30 = 30;");
    expect(note.selectedCode).not.toContain("const line11 = 11;");
  });
});
