import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildReadFileScript,
  EXIT_CODE_TOO_LARGE,
  EXIT_CODE_TOO_MANY_LINES,
  processFileContents,
} from "./fileRead";

describe("buildReadFileScript", () => {
  test("generates script with size check", () => {
    const script = buildReadFileScript("test.txt");
    expect(script).toContain("stat -c %s 'test.txt'");
    expect(script).toContain("base64 < 'test.txt'");
  });

  test("escapes paths with spaces", () => {
    const script = buildReadFileScript("path/to/my file.txt");
    expect(script).toContain("'path/to/my file.txt'");
  });

  test("escapes single quotes", () => {
    const script = buildReadFileScript("file'with'quotes.txt");
    expect(script).toContain("'file'\"'\"'with'\"'\"'quotes.txt'");
  });

  test("supports smaller caller-specific size and line budgets", () => {
    const script = buildReadFileScript("test.txt", { maxSizeBytes: 1234, maxLineCount: 99 });

    expect(script).toContain('[ "$size" -gt 1234 ] && exit 42');
    expect(script).toContain("awk 'NR > 99 { exit 43 }' 'test.txt'");
    expect(script).toContain('exit "$awk_status"');
  });

  test("preserves non-budget awk failures while keeping line-budget exits", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "mux-file-read-"));

    try {
      const missingFileResult = spawnSync(
        "bash",
        ["-lc", buildReadFileScript("missing.txt", { maxLineCount: 1 })],
        { cwd: tempDir }
      );
      expect(missingFileResult.status).not.toBe(EXIT_CODE_TOO_MANY_LINES);

      writeFileSync(join(tempDir, "two-lines.txt"), "first\nsecond\n");
      const tooManyLinesResult = spawnSync(
        "bash",
        ["-lc", buildReadFileScript("two-lines.txt", { maxLineCount: 1 })],
        { cwd: tempDir }
      );
      expect(tooManyLinesResult.status).toBe(EXIT_CODE_TOO_MANY_LINES);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("processFileContents", () => {
  test("returns error for file too large", () => {
    const result = processFileContents("", EXIT_CODE_TOO_LARGE);
    expect(result).toEqual({
      type: "error",
      message: "File is too large to display. Maximum: 10 MB.",
    });
  });

  test("returns error for too many lines", () => {
    const result = processFileContents("", EXIT_CODE_TOO_MANY_LINES);
    expect(result).toEqual({
      type: "error",
      message: "File has too many lines to display.",
    });
  });

  test("handles empty file", () => {
    const result = processFileContents("0", 0);
    expect(result).toEqual({ type: "text", content: "", size: 0 });
  });

  test("decodes text content", () => {
    const result = processFileContents("11\nSGVsbG8gV29ybGQ=", 0);
    expect(result).toEqual({ type: "text", content: "Hello World", size: 11 });
  });
});
