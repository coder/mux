import { describe, expect, test } from "bun:test";

import { buildLargeDiffPreview } from "./FileEditToolCall";

function buildDiff(lineCount: number): string {
  return Array.from({ length: lineCount }, (_, index) => `+line-${index + 1}`).join("\n");
}

describe("buildLargeDiffPreview", () => {
  test("does not preview small diffs", () => {
    expect(buildLargeDiffPreview(buildDiff(12))).toBeNull();
  });

  test("caps large diff previews before rendering the full patch", () => {
    const preview = buildLargeDiffPreview(buildDiff(700));

    expect(preview).not.toBeNull();
    expect(preview?.totalLines).toBe(700);
    expect(preview?.displayedLines).toBe(240);
    expect(preview?.omittedLines).toBe(460);
    expect(preview?.previewDiff).toContain("+line-240");
    expect(preview?.previewDiff).not.toContain("+line-241");
  });

  test("previews character-heavy single-line diffs", () => {
    const preview = buildLargeDiffPreview(`+${"x".repeat(80_001)}`);

    expect(preview?.totalLines).toBe(1);
    expect(preview?.omittedLines).toBe(0);
  });
});
