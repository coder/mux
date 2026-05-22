import { describe, expect, it } from "bun:test";
import type { DiffHunk } from "@/common/types/review";
import {
  filterDismissedAssistedHunks,
  findAssistedMatch,
  formatAssistedFilter,
  hunkMatchesAssisted,
  parseAssistedFilter,
} from "./assistedReview";

const baseHunk = (overrides: Partial<DiffHunk> = {}): DiffHunk => ({
  id: "h1",
  filePath: "src/foo.ts",
  oldStart: 1,
  oldLines: 0,
  newStart: 10,
  newLines: 5,
  content: "",
  header: "@@",
  ...overrides,
});

describe("parseAssistedFilter", () => {
  it("returns null for empty input", () => {
    expect(parseAssistedFilter("")).toBeNull();
    expect(parseAssistedFilter("   ")).toBeNull();
  });

  it("parses whole-file path", () => {
    expect(parseAssistedFilter("src/foo.ts")).toEqual({ path: "src/foo.ts" });
  });

  it("parses single-line range", () => {
    expect(parseAssistedFilter("src/foo.ts:42")).toEqual({
      path: "src/foo.ts",
      range: { start: 42, end: 42 },
    });
  });

  it("parses inclusive range", () => {
    expect(parseAssistedFilter("src/foo.ts:10-20")).toEqual({
      path: "src/foo.ts",
      range: { start: 10, end: 20 },
    });
  });

  it("normalizes reversed range", () => {
    expect(parseAssistedFilter("src/foo.ts:20-10")?.range).toEqual({ start: 10, end: 20 });
  });

  it("falls back to whole-file when range portion is malformed", () => {
    // The trailing ':bogus' is treated as part of the path so we don't
    // silently drop unparseable user input.
    expect(parseAssistedFilter("src/foo.ts:bogus")).toEqual({ path: "src/foo.ts:bogus" });
  });
});

describe("hunkMatchesAssisted", () => {
  it("matches whole-file filter regardless of range", () => {
    expect(hunkMatchesAssisted(baseHunk(), { path: "src/foo.ts" })).toBe(true);
  });

  it("matches overlapping new-side range", () => {
    expect(
      hunkMatchesAssisted(baseHunk(), { path: "src/foo.ts", range: { start: 12, end: 13 } })
    ).toBe(true);
  });

  it("rejects non-overlapping range", () => {
    expect(
      hunkMatchesAssisted(baseHunk(), { path: "src/foo.ts", range: { start: 100, end: 200 } })
    ).toBe(false);
  });

  it("falls back to old-side span for pure deletions", () => {
    const deletion = baseHunk({ newLines: 0, oldStart: 50, oldLines: 4 });
    expect(
      hunkMatchesAssisted(deletion, { path: "src/foo.ts", range: { start: 52, end: 52 } })
    ).toBe(true);
  });

  it("matches via oldPath when file was renamed", () => {
    const renamed = baseHunk({ filePath: "src/new.ts", oldPath: "src/old.ts" });
    expect(hunkMatchesAssisted(renamed, { path: "src/old.ts" })).toBe(true);
  });
});

describe("findAssistedMatch", () => {
  it("returns first match with its declared index", () => {
    const hunk = baseHunk();
    const result = findAssistedMatch(hunk, [
      { path: "src/other.ts" },
      { path: "src/foo.ts", range: { start: 10, end: 14 }, comment: "Look here" },
      { path: "src/foo.ts" },
    ]);
    expect(result?.index).toBe(1);
    expect(result?.entry.comment).toBe("Look here");
  });

  it("returns null when nothing matches", () => {
    expect(findAssistedMatch(baseHunk(), [{ path: "src/other.ts" }])).toBeNull();
  });
});

describe("formatAssistedFilter", () => {
  it("round-trips whole-file paths", () => {
    expect(formatAssistedFilter({ path: "src/foo.ts" })).toBe("src/foo.ts");
  });

  it("formats single-line ranges without a hyphen", () => {
    expect(formatAssistedFilter({ path: "a", range: { start: 5, end: 5 } })).toBe("a:5");
  });

  it("formats multi-line ranges", () => {
    expect(formatAssistedFilter({ path: "a", range: { start: 5, end: 9 } })).toBe("a:5-9");
  });
});

describe("filterDismissedAssistedHunks", () => {
  it("returns the input array reference unchanged when no keys are dismissed", () => {
    // Identity preservation is important: downstream useMemo consumers
    // depend on a stable reference when nothing has changed.
    const raw = [{ path: "src/foo.ts" }, { path: "src/bar.ts", range: { start: 1, end: 2 } }];
    expect(filterDismissedAssistedHunks(raw, [])).toBe(raw);
  });

  it("drops entries whose formatted key matches the dismissed list", () => {
    const raw = [
      { path: "src/foo.ts" },
      { path: "src/bar.ts", range: { start: 1, end: 2 } },
      { path: "src/baz.ts", range: { start: 5, end: 5 } },
    ];
    expect(filterDismissedAssistedHunks(raw, ["src/bar.ts:1-2", "src/baz.ts:5"])).toEqual([
      { path: "src/foo.ts" },
    ]);
  });

  it("ignores dismissed keys that don't match any current entry", () => {
    const raw = [{ path: "src/foo.ts" }];
    expect(filterDismissedAssistedHunks(raw, ["src/gone.ts:10"])).toEqual(raw);
  });
});
