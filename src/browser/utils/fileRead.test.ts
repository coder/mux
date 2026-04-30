import { describe, expect, test } from "bun:test";
import { buildReadFileScript, EXIT_CODE_TOO_LARGE, processFileContents } from "./fileRead";

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
});

describe("processFileContents", () => {
  test("returns error for file too large", () => {
    const result = processFileContents("", EXIT_CODE_TOO_LARGE);
    expect(result).toEqual({
      type: "error",
      message: "File is too large to display. Maximum: 10 MB.",
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
