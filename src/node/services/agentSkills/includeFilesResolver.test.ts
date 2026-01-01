import * as fs from "node:fs/promises";
import { execSync } from "node:child_process";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";
import {
  renderContextFile,
  renderContextFileError,
  resolveIncludeFiles,
  renderIncludedFilesContext,
} from "./includeFilesResolver";

describe("includeFilesResolver", () => {
  describe("renderContextFile", () => {
    test("renders file with code fence and language detection", () => {
      const result = renderContextFile({
        path: "example.ts",
        content: 'const x = 1;\nconsole.log("hello");',
        truncated: false,
      });

      expect(result).toBe(
        '<@example.ts>\n```ts\nconst x = 1;\nconsole.log("hello");\n```\n</@example.ts>'
      );
    });

    test("includes truncated attribute when content is truncated", () => {
      const result = renderContextFile({
        path: "large.json",
        content: '{"key": "value"}',
        truncated: true,
      });

      expect(result).toContain('<@large.json truncated="true">');
      expect(result).toContain("```json");
    });

    test("uses plain fence for unknown extensions", () => {
      const result = renderContextFile({
        path: "unknown.xyz",
        content: "some content",
        truncated: false,
      });

      expect(result).toContain("```\n");
      expect(result).not.toContain("```xyz");
    });
  });

  describe("renderContextFileError", () => {
    test("renders error with escaped attributes", () => {
      const result = renderContextFileError("bad/file.ts", 'Error with "quotes" & <brackets>');
      expect(result).toBe(
        '<@bad/file.ts error="Error with &quot;quotes&quot; &amp; &lt;brackets&gt;" />'
      );
    });
  });

  describe("resolveIncludeFiles", () => {
    test("matches files with glob patterns", async () => {
      using tempDir = new DisposableTempDir("include-files-test");

      // Create test files
      await fs.mkdir(path.join(tempDir.path, "src"), { recursive: true });
      await fs.writeFile(path.join(tempDir.path, "src/a.ts"), "const a = 1;");
      await fs.writeFile(path.join(tempDir.path, "src/b.ts"), "const b = 2;");
      await fs.writeFile(path.join(tempDir.path, "src/c.js"), "const c = 3;");
      await fs.writeFile(path.join(tempDir.path, "README.md"), "# Readme");

      const runtime = new LocalRuntime(tempDir.path);
      const result = await resolveIncludeFiles(runtime, tempDir.path, ["src/*.ts"]);

      expect(result.errors).toHaveLength(0);
      expect(result.files.length).toBe(2);

      const paths = result.files.map((f) => f.path).sort();
      expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
    });

    test("handles multiple patterns", async () => {
      using tempDir = new DisposableTempDir("include-files-multi");

      await fs.mkdir(path.join(tempDir.path, "src"), { recursive: true });
      await fs.writeFile(path.join(tempDir.path, "src/main.ts"), "main");
      await fs.writeFile(path.join(tempDir.path, "README.md"), "readme");

      const runtime = new LocalRuntime(tempDir.path);
      const result = await resolveIncludeFiles(runtime, tempDir.path, ["src/*.ts", "*.md"]);

      expect(result.errors).toHaveLength(0);
      expect(result.files.length).toBe(2);

      const paths = result.files.map((f) => f.path).sort();
      expect(paths).toEqual(["README.md", "src/main.ts"]);
    });

    test("supports listMode=git for deep paths", async () => {
      using tempDir = new DisposableTempDir("include-files-git");
      execSync("git init -b main", { cwd: tempDir.path, stdio: "ignore" });

      await fs.mkdir(path.join(tempDir.path, "a/b/c/d/e"), { recursive: true });
      await fs.writeFile(path.join(tempDir.path, "a/b/c/d/e/f.txt"), "deep");

      const runtime = new LocalRuntime(tempDir.path);
      const result = await resolveIncludeFiles(runtime, tempDir.path, ["a/b/c/d/e/f.txt"], {
        listMode: "git",
      });

      expect(result.errors).toHaveLength(0);
      expect(result.files.map((f) => f.path)).toEqual(["a/b/c/d/e/f.txt"]);
    });

    test("deduplicates files matched by multiple patterns", async () => {
      using tempDir = new DisposableTempDir("include-files-dedup");

      await fs.writeFile(path.join(tempDir.path, "file.ts"), "content");

      const runtime = new LocalRuntime(tempDir.path);
      const result = await resolveIncludeFiles(runtime, tempDir.path, ["*.ts", "file.*"]);

      expect(result.files.length).toBe(1);
      expect(result.files[0]?.path).toBe("file.ts");
    });

    test("skips binary files", async () => {
      using tempDir = new DisposableTempDir("include-files-binary");

      // Create a binary file with null bytes
      await fs.writeFile(path.join(tempDir.path, "binary.dat"), Buffer.from([0x00, 0x01, 0x02]));
      await fs.writeFile(path.join(tempDir.path, "text.txt"), "normal text");

      const runtime = new LocalRuntime(tempDir.path);
      const result = await resolveIncludeFiles(runtime, tempDir.path, ["*"]);

      // Should only include text file
      expect(result.files.length).toBe(1);
      expect(result.files[0]?.path).toBe("text.txt");

      // Binary file should be in errors
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]?.pattern).toBe("binary.dat");
      expect(result.errors[0]?.error).toContain("Binary");
    });

    test("returns empty for non-matching patterns", async () => {
      using tempDir = new DisposableTempDir("include-files-empty");

      await fs.writeFile(path.join(tempDir.path, "file.txt"), "content");

      const runtime = new LocalRuntime(tempDir.path);
      const result = await resolveIncludeFiles(runtime, tempDir.path, ["*.nonexistent"]);

      expect(result.files).toHaveLength(0);
      expect(result.errors).toHaveLength(0); // No match is not an error
    });
  });

  describe("renderIncludedFilesContext", () => {
    test("renders all files and errors as XML", () => {
      const result = renderIncludedFilesContext({
        files: [
          { path: "a.ts", content: "const a = 1;", truncated: false },
          { path: "b.json", content: '{"b": 2}', truncated: true },
        ],
        errors: [{ pattern: "c.bin", error: "Binary file" }],
      });

      expect(result).toContain("<@a.ts>");
      expect(result).toContain("<@b.json");
      expect(result).toContain('truncated="true"');
      expect(result).toContain('<@c.bin error="Binary file" />');
    });
  });
});
