/**
 * Tests for fileExplorer utilities.
 */

import { describe, expect, test } from "bun:test";
import {
  parseReadFileOutput,
  buildReadFileScript,
  buildListDirScript,
  parseLsOutput,
  base64ToUint8Array,
  processFileContents,
  EXIT_CODE_TOO_LARGE,
} from "./fileExplorer";

describe("parseReadFileOutput", () => {
  test("parses normal file output with LF line endings", () => {
    const output = "1234\nSGVsbG8gV29ybGQ=";
    const result = parseReadFileOutput(output);
    expect(result.size).toBe(1234);
    expect(result.base64).toBe("SGVsbG8gV29ybGQ=");
  });

  test("parses output with multi-line base64 (line wrapping)", () => {
    const output = "100\nU0dWc2JHOD0=\nV29ybGQ=";
    const result = parseReadFileOutput(output);
    expect(result.size).toBe(100);
    expect(result.base64).toBe("U0dWc2JHOD0=V29ybGQ=");
  });

  test("handles empty file (no newline after size)", () => {
    const output = "0";
    const result = parseReadFileOutput(output);
    expect(result.size).toBe(0);
    expect(result.base64).toBe("");
  });

  test("handles empty file with trailing newline", () => {
    const output = "0\n";
    const result = parseReadFileOutput(output);
    expect(result.size).toBe(0);
    expect(result.base64).toBe("");
  });

  test("strips CRLF line endings (Windows/SSH)", () => {
    const output = "50\r\nSGVsbG8=\r\nV29ybGQ=\r\n";
    const result = parseReadFileOutput(output);
    expect(result.size).toBe(50);
    expect(result.base64).toBe("SGVsbG8=V29ybGQ=");
  });

  test("throws on invalid output (no size)", () => {
    expect(() => parseReadFileOutput("")).toThrow("Invalid file output format");
    expect(() => parseReadFileOutput("not-a-number")).toThrow("Invalid file output format");
  });

  test("throws on invalid size after newline", () => {
    expect(() => parseReadFileOutput("abc\ndata")).toThrow("Invalid file size");
  });
});

describe("buildReadFileScript", () => {
  test("uses stdin redirect for base64 (cross-platform)", () => {
    const script = buildReadFileScript("test.txt");
    expect(script).toContain("base64 < ");
    expect(script).not.toMatch(/base64 '[^<]/); // Should not have base64 'file' without <
  });

  test("escapes paths with spaces", () => {
    const script = buildReadFileScript("path/to/my file.txt");
    expect(script).toContain("'path/to/my file.txt'");
  });

  test("escapes paths with quotes", () => {
    const script = buildReadFileScript("file'with'quotes.txt");
    expect(script).toContain("'file'\\''with'\\''quotes.txt'");
  });
});

describe("buildListDirScript", () => {
  test("emits a machine-readable listing that validates directory access first", () => {
    const script = buildListDirScript("nested/path");
    expect(script).toContain('[ -d "$dir" ] || exit 1');
    expect(script).toContain('[ -r "$dir" ] || exit 1');
    expect(script).toContain("printf 'd\\t%s\\n' \"$name\"");
    expect(script).toContain("printf 'f\\t%s\\n' \"$name\"");
  });
});

describe("parseLsOutput", () => {
  test("treats real directories as directories", () => {
    const nodes = parseLsOutput("d\tmydir", "");
    expect(nodes).toEqual([
      {
        name: "mydir",
        path: "mydir",
        isDirectory: true,
        children: [],
      },
    ]);
  });

  test("treats symlinks to directories like normal directories", () => {
    const nodes = parseLsOutput("d\tdir-link", "parent");
    expect(nodes).toEqual([
      {
        name: "dir-link",
        path: "parent/dir-link",
        isDirectory: true,
        children: [],
      },
    ]);
  });

  test("keeps symlinks to files non-expandable", () => {
    const nodes = parseLsOutput("f\tfile-link", "");
    expect(nodes).toEqual([
      {
        name: "file-link",
        path: "file-link",
        isDirectory: false,
        children: [],
      },
    ]);
  });

  test("keeps directories first when mixing real and symlinked entries", () => {
    const nodes = parseLsOutput(
      ["f\tzeta.txt", "f\talpha-link", "d\tbravo", "d\talpha-dir"].join("\n"),
      ""
    );

    expect(nodes.map((node) => ({ name: node.name, isDirectory: node.isDirectory }))).toEqual([
      { name: "alpha-dir", isDirectory: true },
      { name: "bravo", isDirectory: true },
      { name: "alpha-link", isDirectory: false },
      { name: "zeta.txt", isDirectory: false },
    ]);
  });

  test("preserves literal filename suffix characters", () => {
    const nodes = parseLsOutput(["f\tconfig@", "f\tliteral=", "f\tpipe|"].join("\n"), "");

    expect(nodes.map((node) => node.name)).toEqual(["config@", "literal=", "pipe|"]);
  });

  test("keeps broken symlinks file-like instead of crashing", () => {
    const nodes = parseLsOutput("f\tbroken-link", "");
    expect(nodes).toEqual([
      {
        name: "broken-link",
        path: "broken-link",
        isDirectory: false,
        children: [],
      },
    ]);
  });
});

describe("base64ToUint8Array", () => {
  test("decodes empty base64 to empty array", () => {
    const result = base64ToUint8Array("");
    expect(result.length).toBe(0);
  });

  test("decodes valid base64", () => {
    const result = base64ToUint8Array("SGVsbG8="); // "Hello"
    expect(new TextDecoder().decode(result)).toBe("Hello");
  });
});

describe("processFileContents", () => {
  test("returns error for EXIT_CODE_TOO_LARGE", () => {
    const result = processFileContents("", EXIT_CODE_TOO_LARGE);
    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect(result.message).toContain("too large");
    }
  });

  test("handles empty file", () => {
    const result = processFileContents("0", 0);
    expect(result.type).toBe("text");
    if (result.type === "text") {
      expect(result.content).toBe("");
      expect(result.size).toBe(0);
    }
  });

  test("decodes text file", () => {
    // "Hello World" in base64
    const result = processFileContents("11\nSGVsbG8gV29ybGQ=", 0);
    expect(result.type).toBe("text");
    if (result.type === "text") {
      expect(result.content).toBe("Hello World");
    }
  });
});
