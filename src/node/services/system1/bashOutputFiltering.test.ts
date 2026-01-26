import { describe, expect, it } from "bun:test";
import {
  applySystem1KeepRangesToOutput,
  formatNumberedLinesForSystem1,
  getHeuristicKeepRangesForBashOutput,
  formatSystem1BashFilterNotice,
  splitBashOutputLines,
} from "./bashOutputFiltering";

describe("bashOutputFiltering", () => {
  describe("splitBashOutputLines", () => {
    it("returns [] for empty output", () => {
      expect(splitBashOutputLines("")).toEqual([]);
    });

    it("splits on newlines", () => {
      expect(splitBashOutputLines("a\nb\nc")).toEqual(["a", "b", "c"]);
    });
  });

  describe("formatNumberedLinesForSystem1", () => {
    it("adds 1-based line numbers", () => {
      expect(formatNumberedLinesForSystem1(["a", "b"]).split("\n")).toEqual(["0001| a", "0002| b"]);
    });
  });

  describe("formatSystem1BashFilterNotice", () => {
    it("includes a cleanup warning when fullOutputPath is present", () => {
      const notice = formatSystem1BashFilterNotice({
        keptLines: 1,
        totalLines: 2,
        trigger: "lines",
        fullOutputPath: "/tmp/bash-s1.txt",
      });

      expect(notice).toContain("Full output saved to /tmp/bash-s1.txt");
      expect(notice).toContain("automatically cleaned up");
      expect(notice).toContain("may already be gone");
    });

    it("omits the full output path when fullOutputPath is missing", () => {
      const notice = formatSystem1BashFilterNotice({
        keptLines: 1,
        totalLines: 2,
        trigger: "bytes",
      });

      expect(notice).toBe("Auto-filtered output: kept 1/2 lines (trigger: bytes).");
    });
  });

  describe("getHeuristicKeepRangesForBashOutput", () => {
    it("keeps error context and respects maxKeptLines", () => {
      const rawOutput = [
        "starting...",
        "step 1 ok",
        "ERROR: expected X, got Y",
        "  at path/to/file.ts:12:3",
        "done",
      ].join("\n");

      const lines = splitBashOutputLines(rawOutput);
      const keepRanges = getHeuristicKeepRangesForBashOutput({
        lines,
        maxKeptLines: 3,
      });

      const applied = applySystem1KeepRangesToOutput({
        rawOutput,
        keepRanges,
        maxKeptLines: 3,
      });

      expect(applied).toBeDefined();
      expect(applied?.keptLines).toBeLessThanOrEqual(3);
      expect(applied?.filteredOutput).toContain("ERROR:");
    });

    it("treats git conflict markers as important lines", () => {
      const rawOutput = [
        "start",
        "src/foo.ts:1:<<<<<<< HEAD",
        "src/foo.ts:2:=======",
        "src/foo.ts:3:>>>>>>> main",
        "end",
      ].join("\n");

      const lines = splitBashOutputLines(rawOutput);
      const keepRanges = getHeuristicKeepRangesForBashOutput({
        lines,
        maxKeptLines: 10,
      });

      const applied = applySystem1KeepRangesToOutput({
        rawOutput,
        keepRanges,
        maxKeptLines: 10,
      });

      expect(applied).toBeDefined();
      expect(applied?.filteredOutput).toContain("<<<<<<<");
      expect(applied?.filteredOutput).toContain("=======");
      expect(applied?.filteredOutput).toContain(">>>>>>>");
    });
  });

  describe("applySystem1KeepRangesToOutput", () => {
    it("returns undefined when keep ranges are empty", () => {
      const applied = applySystem1KeepRangesToOutput({
        rawOutput: "a\nb\nc",
        keepRanges: [],
        maxKeptLines: 10,
      });
      expect(applied).toBeUndefined();
    });

    it("clamps and swaps out-of-order ranges", () => {
      const applied = applySystem1KeepRangesToOutput({
        rawOutput: "a\nb\nc\nd\ne",
        keepRanges: [{ start: 10, end: 2 }],
        maxKeptLines: 10,
      });

      expect(applied).toEqual({
        filteredOutput: "b\nc\nd\ne",
        keptLines: 4,
        totalLines: 5,
      });
    });

    it("merges overlapping ranges and enforces maxKeptLines", () => {
      const applied = applySystem1KeepRangesToOutput({
        rawOutput: "a\nb\nc\nd\ne\nf",
        keepRanges: [
          { start: 2, end: 4 },
          { start: 4, end: 6 },
        ],
        maxKeptLines: 3,
      });

      expect(applied).toEqual({
        filteredOutput: "b\nc\nd",
        keptLines: 3,
        totalLines: 6,
      });

      // Subset-only guarantee: every kept line must exist in the original output.
      const rawLines = splitBashOutputLines("a\nb\nc\nd\ne\nf");
      const keptLines = splitBashOutputLines(applied!.filteredOutput);
      for (const line of keptLines) {
        expect(rawLines.includes(line)).toBe(true);
      }
    });
  });
});
