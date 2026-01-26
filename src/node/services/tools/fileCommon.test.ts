import { describe, it, expect } from "bun:test";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import type { FileStat, Runtime } from "@/node/runtime/Runtime";
import {
  validatePlanModeAccess,
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
    const runtime = createRuntime({ type: "local", srcBaseDir: cwd });

    it("should allow relative paths within cwd", () => {
      expect(validatePathInCwd("src/file.ts", cwd, runtime)).toBeNull();
      expect(validatePathInCwd("./src/file.ts", cwd, runtime)).toBeNull();
      expect(validatePathInCwd("file.ts", cwd, runtime)).toBeNull();
    });

    it("should allow absolute paths within extraAllowedDirs", () => {
      expect(validatePathInCwd("/tmp/test.txt", cwd, runtime, ["/tmp"])).toBeNull();
    });

    it("should reject absolute paths outside cwd and extraAllowedDirs", () => {
      const result = validatePathInCwd("/etc/passwd", cwd, runtime, ["/tmp"]);
      expect(result).not.toBeNull();
      expect(result?.error).toContain("restricted to the workspace directory");
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
    const runtime = createRuntime({ type: "local", srcBaseDir: cwd });

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

  describe("validatePlanModeAccess", () => {
    const planFilePath = "~/.mux/plans/plan.md";
    const resolvedPlanFilePath = "/home/user/.mux/plans/plan.md";

    const mockRuntime = {
      resolvePath: (targetPath: string): Promise<string> => {
        if (targetPath === planFilePath) {
          return Promise.resolve(resolvedPlanFilePath);
        }
        if (targetPath === resolvedPlanFilePath) {
          return Promise.resolve(resolvedPlanFilePath);
        }
        if (targetPath === "src/main.ts") {
          return Promise.resolve("/home/user/project/src/main.ts");
        }
        return Promise.resolve(targetPath);
      },
    } as unknown as Runtime;

    const config: ToolConfiguration = {
      cwd: "/home/user/project",
      runtime: mockRuntime,
      runtimeTempDir: "/tmp",
      planFileOnly: true,
      planFilePath,
    };

    it("should allow editing when filePath is exactly planFilePath", async () => {
      expect(await validatePlanModeAccess(planFilePath, config)).toBeNull();
    });

    it("should reject alternate paths that resolve to the plan file", async () => {
      const result = await validatePlanModeAccess(resolvedPlanFilePath, config);
      expect(result).not.toBeNull();
      expect(result?.error).toContain("exact plan file path");
      expect(result?.error).toContain(planFilePath);
      expect(result?.error).toContain(resolvedPlanFilePath);
      expect(result?.error).toContain("resolves to the plan file");
    });

    it("should reject non-plan files in plan mode", async () => {
      const result = await validatePlanModeAccess("src/main.ts", config);
      expect(result).not.toBeNull();
      expect(result?.error).toContain("only the plan file can be edited");
      expect(result?.error).toContain("exact plan file path");
      expect(result?.error).toContain(planFilePath);
      expect(result?.error).toContain("src/main.ts");
    });
  });
});
