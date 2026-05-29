import { describe, it, expect } from "bun:test";
import {
  getThumbMetrics,
  parseDiffLines,
  pointerYToLineIndex,
  scrollTopForLine,
} from "./immersiveMinimapMath";

describe("parseDiffLines", () => {
  it("returns [] for empty content", () => {
    expect(parseDiffLines("")).toEqual([]);
  });

  it("skips hunk headers and maps add/remove/context lines", () => {
    const content = [
      "@@ -1,4 +1,4 @@",
      " context one",
      "-old line",
      "+new line",
      "@@ -8,2 +8,3 @@",
      " context two",
      "+another addition",
    ].join("\n");

    expect(parseDiffLines(content)).toEqual(["context", "remove", "add", "context", "add"]);
  });

  it("treats non-prefixed lines as context", () => {
    const content = [" context line", "unchanged line", "	indented context"].join("\n");

    expect(parseDiffLines(content)).toEqual(["context", "context", "context"]);
  });

  it("ignores trailing newline without creating a phantom line", () => {
    const content = "+added\n-context\n";

    expect(parseDiffLines(content)).toEqual(["add", "remove"]);
  });
});

describe("getThumbMetrics", () => {
  it("computes thumb metrics for a normal scrollable case", () => {
    const metrics = getThumbMetrics(0, 1000, 500, 300);

    expect(metrics.thumbHeight).toBe(150);
    expect(metrics.maxThumbTop).toBe(150);
    expect(metrics.thumbTop).toBe(0);
  });

  it("positions the thumb at the bottom when scrolled to bottom", () => {
    const metrics = getThumbMetrics(500, 1000, 500, 300);

    expect(metrics.thumbTop).toBe(metrics.maxThumbTop);
    expect(metrics.thumbTop).toBe(150);
  });

  it("fills the track when content height equals viewport height", () => {
    const metrics = getThumbMetrics(0, 500, 500, 300);

    expect(metrics.thumbHeight).toBe(300);
    expect(metrics.maxThumbTop).toBe(0);
    expect(metrics.thumbTop).toBe(0);
  });

  it("enforces a minimum thumb height for very tall content", () => {
    const metrics = getThumbMetrics(0, 10000, 500, 300);

    expect(metrics.thumbHeight).toBe(24);
    expect(metrics.maxThumbTop).toBe(276);
  });
});

describe("pointerYToLineIndex", () => {
  it("maps pointerY=0 to line 0", () => {
    expect(pointerYToLineIndex(0, 120, 11)).toBe(0);
  });

  it("maps pointerY at track bottom to the last line", () => {
    expect(pointerYToLineIndex(120, 120, 11)).toBe(10);
  });

  it("maps halfway pointer to the middle line", () => {
    expect(pointerYToLineIndex(150, 300, 100)).toBe(50);
  });

  it("keeps clicks in the lower portion of a band on the same line", () => {
    expect(pointerYToLineIndex(2.9, 300, 100)).toBe(0);
  });

  it("clamps negative pointerY to the first line", () => {
    expect(pointerYToLineIndex(-10, 120, 11)).toBe(0);
  });

  it("clamps pointerY above track height to the last line", () => {
    expect(pointerYToLineIndex(300, 120, 11)).toBe(10);
  });

  it("returns 0 when totalLines is 0", () => {
    expect(pointerYToLineIndex(40, 120, 0)).toBe(0);
  });
});

describe("scrollTopForLine", () => {
  it("returns 0 for the first line", () => {
    expect(scrollTopForLine(0, 11, 1000, 500)).toBe(0);
  });

  it("maps the last line to max scroll", () => {
    expect(scrollTopForLine(10, 11, 1000, 500)).toBe(500);
  });

  it("maps a middle line proportionally", () => {
    expect(scrollTopForLine(5, 11, 1000, 500)).toBe(250);
  });
});
