import { describe, expect, it } from "bun:test";
import { truncateBashOutput } from "./truncateBashOutput";
import { BASH_HARD_MAX_LINES, BASH_MAX_TOTAL_BYTES } from "@/common/constants/toolLimits";

describe("truncateBashOutput", () => {
  it("returns output unchanged when within limits", () => {
    const output = "line1\nline2\nline3";
    const result = truncateBashOutput(output);

    expect(result.truncated).toBe(false);
    expect(result.output).toBe(output);
    expect(result.originalLines).toBe(3);
  });

  it("truncates when line count exceeds BASH_HARD_MAX_LINES", () => {
    const lines = Array.from({ length: BASH_HARD_MAX_LINES + 100 }, (_, i) => `line${i}`);
    const output = lines.join("\n");
    const result = truncateBashOutput(output);

    expect(result.truncated).toBe(true);
    expect(result.originalLines).toBe(BASH_HARD_MAX_LINES + 100);

    const resultLines = result.output.split("\n");
    expect(resultLines.length).toBeLessThanOrEqual(BASH_HARD_MAX_LINES);

    // Should keep tail (most recent lines)
    expect(resultLines[resultLines.length - 1]).toBe(`line${BASH_HARD_MAX_LINES + 99}`);
  });

  it("truncates when byte count exceeds BASH_MAX_TOTAL_BYTES", () => {
    // Create output that exceeds byte limit but not line limit
    const longLine = "x".repeat(1000);
    const lines = Array.from({ length: 50 }, () => longLine);
    const output = lines.join("\n");

    expect(Buffer.byteLength(output, "utf-8")).toBeGreaterThan(BASH_MAX_TOTAL_BYTES);
    expect(lines.length).toBeLessThan(BASH_HARD_MAX_LINES);

    const result = truncateBashOutput(output);

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output, "utf-8")).toBeLessThanOrEqual(BASH_MAX_TOTAL_BYTES);
  });

  it("handles empty output", () => {
    const result = truncateBashOutput("");

    expect(result.truncated).toBe(false);
    expect(result.output).toBe("");
    expect(result.originalLines).toBe(1); // Empty string splits to [""]
  });

  it("handles single line output", () => {
    const result = truncateBashOutput("single line");

    expect(result.truncated).toBe(false);
    expect(result.output).toBe("single line");
    expect(result.originalLines).toBe(1);
  });

  it("handles output exactly at BASH_HARD_MAX_LINES", () => {
    const lines = Array.from({ length: BASH_HARD_MAX_LINES }, (_, i) => `line${i}`);
    const output = lines.join("\n");
    const result = truncateBashOutput(output);

    expect(result.truncated).toBe(false);
    expect(result.output).toBe(output);
    expect(result.originalLines).toBe(BASH_HARD_MAX_LINES);
  });

  it("handles output exactly at BASH_MAX_TOTAL_BYTES", () => {
    // Create output exactly at byte limit
    const targetBytes = BASH_MAX_TOTAL_BYTES;
    let output = "";
    while (Buffer.byteLength(output + "x", "utf-8") <= targetBytes) {
      output += "x";
    }

    const result = truncateBashOutput(output);

    expect(result.truncated).toBe(false);
    expect(result.output).toBe(output);
  });

  it("handles multi-byte characters correctly", () => {
    // Use emoji which are 4 bytes each
    const emoji = "🎉";
    const lines = Array.from({ length: 50 }, () => emoji.repeat(200));
    const output = lines.join("\n");

    const result = truncateBashOutput(output);

    // Should not produce invalid UTF-8 (would throw on .split or .length)
    expect(() => result.output.split("\n")).not.toThrow();
    expect(Buffer.byteLength(result.output, "utf-8")).toBeLessThanOrEqual(BASH_MAX_TOTAL_BYTES);
  });
});
