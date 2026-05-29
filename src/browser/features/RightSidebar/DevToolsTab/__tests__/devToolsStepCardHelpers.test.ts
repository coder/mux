import { describe, expect, test } from "bun:test";
import { truncateToFirstLine } from "../devToolsStepCardHelpers";

describe("truncateToFirstLine", () => {
  test("returns full first line when under max length", () => {
    expect(truncateToFirstLine("short text", 80)).toBe("short text");
  });

  test("truncates first line at maxLen with ellipsis", () => {
    const long = "a".repeat(100);
    const result = truncateToFirstLine(long, 80);
    expect(result).toBe(`${"a".repeat(80)}…`);
  });

  test("uses only first line of multiline input", () => {
    expect(truncateToFirstLine("line one\nline two\nline three", 80)).toBe("line one");
  });

  test("truncates long first line of multiline input", () => {
    const long = `${"b".repeat(100)}\nsecond line`;
    expect(truncateToFirstLine(long, 80)).toBe(`${"b".repeat(80)}…`);
  });

  test("returns empty string for empty input", () => {
    expect(truncateToFirstLine("", 80)).toBe("");
  });

  test("preserves whitespace on a whitespace-only first line", () => {
    expect(truncateToFirstLine("   \nactual content", 80)).toBe("   ");
  });

  test("handles first line exactly at maxLen boundary", () => {
    const exact = "c".repeat(80);
    expect(truncateToFirstLine(exact, 80)).toBe(exact);
  });
});
