import { describe, it, expect } from "bun:test";
import type { FileStat } from "@/node/runtime/Runtime";
import {
  validatePathInCwd,
  validateFileSize,
  validateNoRedundantPrefix,
  MAX_FILE_SIZE,
} from "./fileCommon";
import { createRuntime } from "@/node/runtime/runtimeFactory";

describe("fileCommon", () => {
  describe("validateFileSize", () => {
    it("should return null for files within size limit", () => {
      const stats: FileStat = {
        size: 1024, // 1KB
        modifiedTime: new Date(),
        isDirectory: false,
      };

      expect(validateFileSize(stats)).toBeNull();
    });

    it("should return null for files at exactly the limit", () => {
      const stats: FileStat = {
        size: MAX_FILE_SIZE,
        modifiedTime: new Date(),
        isDirectory: false,
      };

      expect(validateFileSize(stats)).toBeNull();
    });

    it("should return error for files exceeding size limit", () => {
      const stats: FileStat = {
        size: MAX_FILE_SIZE + 1,
        modifiedTime: new Date(),
        isDirectory: false,
      };

      const result = validateFileSize(stats);
      expect(result).not.toBeNull();
      expect(result?.error).toContain("too large");
      expect(result?.error).toContain("system tools");
    });

    it("should include size information in error message", () => {
      const stats: FileStat = {
        size: MAX_FILE_SIZE * 2, // 2MB
        modifiedTime: new Date(),
        isDirectory: false,
      };

      const result = validateFileSize(stats);
      expect(result?.error).toContain("2.00MB");
      expect(result?.error).toContain("1.00MB");
    });

    it("should suggest alternative tools in error message", () => {
      const stats: FileStat = {
        size: MAX_FILE_SIZE + 1,
        modifiedTime: new Date(),
        isDirectory: false,
      };

      const result = validateFileSize(stats);
      expect(result?.error).toContain("grep");
      expect(result?.error).toContain("sed");
    });
  });

  describe("validatePathInCwd", () => {
    const cwd = "/workspace/project";
    const runtime = createRuntime({ type: "worktree", srcBaseDir: cwd });

    it("should allow relative paths within cwd", () => {
      expect(validatePathInCwd("src/file.ts", cwd, runtime)).toBeNull();
      expect(validatePathInCwd("./src/file.ts", cwd, runtime)).toBeNull();
      expect(validatePathInCwd("file.ts", cwd, runtime)).toBeNull();
    });

    it("should allow absolute paths within cwd", () => {
      expect(validatePathInCwd("/workspace/project/src/file.ts", cwd, runtime)).toBeNull();
      expect(validatePathInCwd("/workspace/project/file.ts", cwd, runtime)).toBeNull();
    });

    it("should reject paths that go up and outside cwd with ..", () => {
      const result = validatePathInCwd("../outside.ts", cwd, runtime);
      expect(result).not.toBeNull();
      expect(result?.error).toContain("restricted to the workspace directory");
      expect(result?.error).toContain("/workspace/project");
    });

    it("should reject paths that go multiple levels up", () => {
      const result = validatePathInCwd("../../outside.ts", cwd, runtime);
      expect(result).not.toBeNull();
      expect(result?.error).toContain("restricted to the workspace directory");
    });

    it("should reject paths that go down then up outside cwd", () => {
      const result = validatePathInCwd("src/../../outside.ts", cwd, runtime);
      expect(result).not.toBeNull();
      expect(result?.error).toContain("restricted to the workspace directory");
    });

    it("should reject absolute paths outside cwd", () => {
      const result = validatePathInCwd("/etc/passwd", cwd, runtime);
      expect(result).not.toBeNull();
      expect(result?.error).toContain("restricted to the workspace directory");
    });

    it("should reject absolute paths in different directory tree", () => {
      const result = validatePathInCwd("/home/user/file.ts", cwd, runtime);
      expect(result).not.toBeNull();
      expect(result?.error).toContain("restricted to the workspace directory");
    });

    it("should handle paths with trailing slashes", () => {
      expect(validatePathInCwd("src/", cwd, runtime)).toBeNull();
    });

    it("should handle nested paths correctly", () => {
      expect(validatePathInCwd("src/components/Button/index.ts", cwd, runtime)).toBeNull();
      expect(validatePathInCwd("./src/components/Button/index.ts", cwd, runtime)).toBeNull();
    });

    it("should provide helpful error message mentioning to ask user", () => {
      const result = validatePathInCwd("../outside.ts", cwd, runtime);
      expect(result?.error).toContain("ask the user for permission");
    });

    it("should work with cwd that has trailing slash", () => {
      const cwdWithSlash = "/workspace/project/";
      expect(validatePathInCwd("src/file.ts", cwdWithSlash, runtime)).toBeNull();

      const result = validatePathInCwd("../outside.ts", cwdWithSlash, runtime);
      expect(result).not.toBeNull();
    });
  });

  describe("validateNoRedundantPrefix", () => {
    const cwd = "/workspace/project";
    const runtime = createRuntime({ type: "worktree", srcBaseDir: cwd });

    it("should allow relative paths", () => {
      expect(validateNoRedundantPrefix("src/file.ts", cwd, runtime)).toBeNull();
      expect(validateNoRedundantPrefix("./src/file.ts", cwd, runtime)).toBeNull();
      expect(validateNoRedundantPrefix("file.ts", cwd, runtime)).toBeNull();
    });

    it("should auto-correct absolute paths that contain the cwd prefix", () => {
      const result = validateNoRedundantPrefix("/workspace/project/src/file.ts", cwd, runtime);
      expect(result).not.toBeNull();
      expect(result?.correctedPath).toBe("src/file.ts");
      expect(result?.warning).toContain("Using relative paths");
      expect(result?.warning).toContain("saves tokens");
      expect(result?.warning).toContain("auto-corrected");
    });

    it("should auto-correct absolute paths at the cwd root", () => {
      const result = validateNoRedundantPrefix("/workspace/project/file.ts", cwd, runtime);
      expect(result).not.toBeNull();
      expect(result?.correctedPath).toBe("file.ts");
      expect(result?.warning).toContain("auto-corrected");
    });

    it("should allow absolute paths outside cwd (they will be caught by validatePathInCwd)", () => {
      // This validation only catches redundant prefixes, not paths outside cwd
      expect(validateNoRedundantPrefix("/etc/passwd", cwd, runtime)).toBeNull();
      expect(validateNoRedundantPrefix("/home/user/file.ts", cwd, runtime)).toBeNull();
    });

    it("should handle paths with ..", () => {
      // Relative paths with .. are fine for this check
      expect(validateNoRedundantPrefix("../outside.ts", cwd, runtime)).toBeNull();
      expect(validateNoRedundantPrefix("src/../../outside.ts", cwd, runtime)).toBeNull();
    });

    it("should work with cwd that has trailing slash", () => {
      const cwdWithSlash = "/workspace/project/";
      const result = validateNoRedundantPrefix(
        "/workspace/project/src/file.ts",
        cwdWithSlash,
        runtime
      );
      expect(result).not.toBeNull();
      expect(result?.correctedPath).toBe("src/file.ts");
      expect(result?.warning).toContain("auto-corrected");
    });

    it("should handle nested paths correctly", () => {
      const result = validateNoRedundantPrefix(
        "/workspace/project/src/components/Button/index.ts",
        cwd,
        runtime
      );
      expect(result).not.toBeNull();
      expect(result?.correctedPath).toBe("src/components/Button/index.ts");
      expect(result?.warning).toContain("auto-corrected");
    });

    it("should auto-correct path that equals cwd exactly", () => {
      const result = validateNoRedundantPrefix("/workspace/project", cwd, runtime);
      expect(result).not.toBeNull();
      expect(result?.correctedPath).toBe(".");
      expect(result?.warning).toContain("auto-corrected");
    });

    it("should not match partial directory names", () => {
      // /workspace/project2 should NOT match /workspace/project
      expect(validateNoRedundantPrefix("/workspace/project2/file.ts", cwd, runtime)).toBeNull();
      expect(validateNoRedundantPrefix("/workspace/project-old/file.ts", cwd, runtime)).toBeNull();
    });

    it("should work with SSH runtime", () => {
      const sshRuntime = createRuntime({
        type: "ssh",
        host: "user@localhost",
        srcBaseDir: "/home/user/mux",
        identityFile: "/tmp/fake-key",
      });
      const sshCwd = "/home/user/mux/project/branch";

      // Should auto-correct absolute paths with redundant prefix on SSH too
      const result = validateNoRedundantPrefix(
        "/home/user/mux/project/branch/src/file.ts",
        sshCwd,
        sshRuntime
      );
      expect(result).not.toBeNull();
      expect(result?.correctedPath).toBe("src/file.ts");
      expect(result?.warning).toContain("auto-corrected");

      // Should allow relative paths on SSH
      expect(validateNoRedundantPrefix("src/file.ts", sshCwd, sshRuntime)).toBeNull();
    });
  });
});
