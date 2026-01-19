import { describe, it, expect } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { FileStat, Runtime } from "@/node/runtime/Runtime";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { DockerRuntime } from "@/node/runtime/DockerRuntime";
import {
  validatePathInCwd,
  validateFileSize,
  validateNoRedundantPrefix,
  isPlanFilePath,
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
});

describe("isPlanFilePath", () => {
  it("should match canonical absolute plan path against ~/.mux alias in local runtimes", async () => {
    const previousMuxRoot = process.env.MUX_ROOT;

    const muxHome = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-home-"));
    process.env.MUX_ROOT = muxHome;

    try {
      const runtime = new LocalRuntime("/workspace/project");

      // Canonical (already-resolved) path under mux home.
      const canonicalPlanPath = path.join(muxHome, "plans", "proj", "branch.md");

      const config: ToolConfiguration = {
        cwd: "/workspace/project",
        runtime,
        runtimeTempDir: "/tmp",
        planFilePath: canonicalPlanPath,
      };

      // Absolute path should match exactly.
      expect(await isPlanFilePath(canonicalPlanPath, config)).toBe(true);

      // Tilde + ~/.mux prefix should resolve to mux home (which may be MUX_ROOT or ~/.mux-dev).
      expect(await isPlanFilePath("~/.mux/plans/proj/branch.md", config)).toBe(true);

      // If the caller uses the OS-home absolute path for ~/.mux, that may not match mux home
      // when mux is configured to use a different root (e.g. MUX_ROOT or NODE_ENV=development).
      const osHomeMuxPath = path.join(os.homedir(), ".mux", "plans", "proj", "branch.md");
      expect(await isPlanFilePath(osHomeMuxPath, config)).toBe(false);
    } finally {
      if (previousMuxRoot === undefined) {
        delete process.env.MUX_ROOT;
      } else {
        process.env.MUX_ROOT = previousMuxRoot;
      }
      await fsPromises.rm(muxHome, { recursive: true, force: true });
    }
  });

  it("should use DockerRuntime.resolvePath semantics when matching plan file", async () => {
    const runtime = new DockerRuntime({ image: "ubuntu:22.04" });

    const config: ToolConfiguration = {
      cwd: "/src",
      runtime,
      runtimeTempDir: "/tmp",
      planFilePath: "/var/mux/plans/proj/branch.md",
    };

    // Docker uses /var/mux for mux home (not ~/.mux), so only that absolute path matches.
    expect(await isPlanFilePath("/var/mux/plans/proj/branch.md", config)).toBe(true);

    // In Docker, ~ expands to the container user's home (e.g. /root), so this should not match.
    expect(await isPlanFilePath("~/.mux/plans/proj/branch.md", config)).toBe(false);

    // Non-absolute paths are resolved relative to /src (workspace), so this should not match either.
    expect(await isPlanFilePath("var/mux/plans/proj/branch.md", config)).toBe(false);
  });

  it("should handle SSH-like resolution (~/, absolute, and relative) consistently", async () => {
    const fakeSshRuntime: Runtime = {
      // Minimal subset needed for isPlanFilePath()
      resolvePath: (filePath: string) => {
        const home = "/home/test";
        const pwd = "/home/test/work";

        let resolved: string;
        if (filePath === "~") {
          resolved = home;
        } else if (filePath.startsWith("~/")) {
          resolved = path.posix.join(home, filePath.slice(2));
        } else if (filePath.startsWith("/")) {
          resolved = filePath;
        } else {
          resolved = path.posix.join(pwd, filePath);
        }

        return Promise.resolve(resolved);
      },
    } as unknown as Runtime;

    const config: ToolConfiguration = {
      cwd: "/home/test/work",
      runtime: fakeSshRuntime,
      runtimeTempDir: "/tmp",
      planFilePath: "/home/test/.mux/plans/proj/branch.md",
    };

    expect(await isPlanFilePath("/home/test/.mux/plans/proj/branch.md", config)).toBe(true);
    expect(await isPlanFilePath("~/.mux/plans/proj/branch.md", config)).toBe(true);

    // Relative path is resolved from PWD (not mux home), so it should not match.
    expect(await isPlanFilePath(".mux/plans/proj/branch.md", config)).toBe(false);
  });
});
