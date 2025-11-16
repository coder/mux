import { describe, test, expect } from "bun:test";
import { PlatformPaths } from "./paths.main";
import * as os from "os";
import * as path from "path";

describe("PlatformPaths", () => {
  describe("basename", () => {
    test("extracts basename from path using current platform", () => {
      expect(PlatformPaths.basename("/home/user/project")).toBe("project");
      expect(PlatformPaths.basename("/home/user/project/file.txt")).toBe("file.txt");
    });

    test("handles edge cases", () => {
      expect(PlatformPaths.basename("")).toBe("");
      expect(PlatformPaths.basename("project")).toBe("project");
    });
  });

  describe("parse", () => {
    test("parses absolute path on current platform", () => {
      const testPath = path.join("/", "home", "user", "projects", "cmux");
      const result = PlatformPaths.parse(testPath);
      expect(result.segments).toContain("home");
      expect(result.segments).toContain("user");
      expect(result.segments).toContain("projects");
      expect(result.basename).toBe("cmux");
    });

    test("parses relative path", () => {
      const result = PlatformPaths.parse("src/utils/paths.ts");
      expect(result.root).toBe("");
      expect(result.basename).toBe("paths.ts");
    });

    test("handles edge cases", () => {
      expect(PlatformPaths.parse("")).toEqual({ root: "", segments: [], basename: "" });
      expect(PlatformPaths.parse("file.txt").basename).toBe("file.txt");
    });
  });

  describe("abbreviate", () => {
    test("abbreviates path", () => {
      const testPath = path.join("/", "home", "user", "Projects", "coder", "cmux");
      const result = PlatformPaths.abbreviate(testPath);

      // Should end with the full basename
      expect(result.endsWith("cmux")).toBe(true);

      // Should be shorter than original (segments abbreviated)
      expect(result.length).toBeLessThan(testPath.length);
    });

    test("handles short paths", () => {
      const testPath = path.join("/", "home");
      const result = PlatformPaths.abbreviate(testPath);
      // Short paths should not be abbreviated much
      expect(result).toContain("home");
    });

    test("handles empty input", () => {
      expect(PlatformPaths.abbreviate("")).toBe("");
    });
  });

  describe("splitAbbreviated", () => {
    test("splits abbreviated path", () => {
      const testPath = path.join("/", "h", "u", "P", "c", "cmux");
      const result = PlatformPaths.splitAbbreviated(testPath);
      expect(result.basename).toBe("cmux");
      expect(result.dirPath.endsWith(path.sep)).toBe(true);
    });

    test("handles path without directory", () => {
      const result = PlatformPaths.splitAbbreviated("file.txt");
      expect(result.dirPath).toBe("");
      expect(result.basename).toBe("file.txt");
    });
  });

  describe("formatHome", () => {
    test("replaces home directory with tilde on Unix", () => {
      const home = os.homedir();
      const testPath = path.join(home, "projects", "cmux");
      const result = PlatformPaths.formatHome(testPath);

      // On Unix-like systems, should use tilde
      if (process.platform !== "win32") {
        expect(result).toBe("~/projects/cmux");
      } else {
        // On Windows, should keep full path
        expect(result).toContain(home);
      }
    });

    test("leaves non-home paths unchanged", () => {
      const result = PlatformPaths.formatHome("/tmp/test");
      expect(result).toBe("/tmp/test");
    });
  });

  describe("expandHome", () => {
    test("expands tilde to home directory", () => {
      const home = os.homedir();
      expect(PlatformPaths.expandHome("~")).toBe(home);
    });

    test("expands tilde with path", () => {
      const home = os.homedir();
      const sep = path.sep;
      const result = PlatformPaths.expandHome(`~${sep}projects${sep}cmux`);
      expect(result).toBe(path.join(home, "projects", "cmux"));
    });

    test("leaves absolute paths unchanged", () => {
      const testPath = path.join("/", "home", "user", "project");
      expect(PlatformPaths.expandHome(testPath)).toBe(testPath);
    });

    test("handles empty input", () => {
      expect(PlatformPaths.expandHome("")).toBe("");
    });
  });

  describe("getProjectName", () => {
    test("extracts project name from path", () => {
      const testPath = path.join("/", "home", "user", "projects", "cmux");
      expect(PlatformPaths.getProjectName(testPath)).toBe("cmux");
    });

    test("handles relative paths", () => {
      expect(PlatformPaths.getProjectName("projects/cmux")).toBe("cmux");
    });

    test("returns 'unknown' for empty path", () => {
      expect(PlatformPaths.getProjectName("")).toBe("unknown");
    });
  });

  describe("separator", () => {
    test("returns correct separator for platform", () => {
      const sep = PlatformPaths.separator;
      // Should match the current platform's separator
      expect(sep).toBe(path.sep);
    });
  });
});
