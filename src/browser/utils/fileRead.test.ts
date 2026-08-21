import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildReadFileScript,
  EXIT_CODE_OUTSIDE_WORKSPACE,
  EXIT_CODE_TOO_LARGE,
  EXIT_CODE_TOO_MANY_LINES,
  processFileContents,
} from "./fileRead";

describe("buildReadFileScript", () => {
  test("generates script with size check", () => {
    const script = buildReadFileScript("test.txt");
    expect(script).toContain("realpath './test.txt'");
    expect(script).toContain('stat -c %s "$resolved"');
    expect(script).toContain('base64 < "$resolved"');
  });

  test("escapes paths with spaces", () => {
    const script = buildReadFileScript("path/to/my file.txt");
    expect(script).toContain("'./path/to/my file.txt'");
  });

  test("escapes single quotes", () => {
    const script = buildReadFileScript("file'with'quotes.txt");
    expect(script).toContain("'./file'\"'\"'with'\"'\"'quotes.txt'");
  });

  test("supports smaller caller-specific size and line budgets", () => {
    const script = buildReadFileScript("test.txt", { maxSizeBytes: 1234, maxLineCount: 99 });

    expect(script).toContain('[ "$size" -gt 1234 ] && exit 42');
    expect(script).toContain("awk 'NR > 99 { exit 43 }' \"$resolved\"");
    expect(script).toContain('exit "$awk_status"');
  });

  test("rejects symlinks that resolve outside the workspace", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "mux-file-read-outside-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "mux-file-read-ws-"));

    try {
      writeFileSync(join(outsideDir, "secret.txt"), "outside secret\n");
      symlinkSync(join(outsideDir, "secret.txt"), join(workspaceDir, "escape.txt"));

      const result = spawnSync("bash", ["-lc", buildReadFileScript("escape.txt")], {
        cwd: workspaceDir,
      });
      expect(result.status).toBe(EXIT_CODE_OUTSIDE_WORKSPACE);
      expect(result.stdout.toString()).not.toContain("outside secret");
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("still reads symlinks that stay inside the workspace", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "mux-file-read-ws-"));

    try {
      writeFileSync(join(workspaceDir, "real.txt"), "inside contents\n");
      symlinkSync(join(workspaceDir, "real.txt"), join(workspaceDir, "link.txt"));

      const result = spawnSync("bash", ["-lc", buildReadFileScript("link.txt")], {
        cwd: workspaceDir,
      });
      expect(result.status).toBe(0);
      const processed = processFileContents(result.stdout.toString(), result.status ?? 0);
      // stat sizes the link inode itself (pre-existing quirk), so assert the decoded content.
      expect(processed).toMatchObject({ type: "text", content: "inside contents\n" });
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("reads files whose names look like command options", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "mux-file-read-"));

    try {
      writeFileSync(join(tempDir, "-n"), "dash file contents\n");
      const result = spawnSync("bash", ["-lc", buildReadFileScript("-n")], { cwd: tempDir });
      expect(result.status).toBe(0);
      const processed = processFileContents(result.stdout.toString(), result.status ?? 0);
      expect(processed).toEqual({
        type: "text",
        content: "dash file contents\n",
        size: 19,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
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
