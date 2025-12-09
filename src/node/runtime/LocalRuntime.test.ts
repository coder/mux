import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import { LocalRuntime } from "./LocalRuntime";
import type { InitLogger } from "./Runtime";

// Minimal mock logger - matches pattern in initHook.test.ts
function createMockLogger(): InitLogger & { steps: string[] } {
  const steps: string[] = [];
  return {
    steps,
    logStep: (msg: string) => steps.push(msg),
    logStdout: () => {
      /* no-op for test */
    },
    logStderr: () => {
      /* no-op for test */
    },
    logComplete: () => {
      /* no-op for test */
    },
  };
}

describe("LocalRuntime", () => {
  // Use a temp directory for tests
  let testDir: string;

  beforeAll(async () => {
    // Resolve real path to handle macOS symlinks (/var -> /private/var)
    testDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "localruntime-test-")));
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe("constructor and getWorkspacePath", () => {
    it("stores projectPath and returns it regardless of arguments", () => {
      const runtime = new LocalRuntime("/home/user/my-project");
      // Both arguments are ignored - always returns the project path
      expect(runtime.getWorkspacePath("/other/path", "some-branch")).toBe("/home/user/my-project");
      expect(runtime.getWorkspacePath("", "")).toBe("/home/user/my-project");
    });

    it("does not expand tilde (unlike WorktreeRuntime)", () => {
      // LocalRuntime stores the path as-is; callers must pass expanded paths
      const runtime = new LocalRuntime("~/my-project");
      expect(runtime.getWorkspacePath("", "")).toBe("~/my-project");
    });
  });

  describe("createWorkspace", () => {
    it("succeeds when directory exists", async () => {
      const runtime = new LocalRuntime(testDir);
      const logger = createMockLogger();

      const result = await runtime.createWorkspace({
        projectPath: testDir,
        branchName: "main",
        trunkBranch: "main",
        directoryName: "main",
        initLogger: logger,
      });

      expect(result.success).toBe(true);
      expect(result.workspacePath).toBe(testDir);
      expect(logger.steps.length).toBeGreaterThan(0);
      expect(logger.steps.some((s) => s.includes("project directory"))).toBe(true);
    });

    it("fails when directory does not exist", async () => {
      const nonExistentPath = path.join(testDir, "does-not-exist");
      const runtime = new LocalRuntime(nonExistentPath);
      const logger = createMockLogger();

      const result = await runtime.createWorkspace({
        projectPath: nonExistentPath,
        branchName: "main",
        trunkBranch: "main",
        directoryName: "main",
        initLogger: logger,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("does not exist");
    });
  });

  describe("deleteWorkspace", () => {
    it("returns success without deleting anything", async () => {
      const runtime = new LocalRuntime(testDir);

      // Create a test file to verify it isn't deleted
      const testFile = path.join(testDir, "delete-test.txt");
      await fs.writeFile(testFile, "should not be deleted");

      const result = await runtime.deleteWorkspace(testDir, "main", false);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.deletedPath).toBe(testDir);
      }

      // Verify file still exists
      const fileStillExists = await fs.access(testFile).then(
        () => true,
        () => false
      );
      expect(fileStillExists).toBe(true);

      // Cleanup
      await fs.unlink(testFile);
    });

    it("returns success even with force=true (still no-op)", async () => {
      const runtime = new LocalRuntime(testDir);

      const result = await runtime.deleteWorkspace(testDir, "main", true);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.deletedPath).toBe(testDir);
      }
      // Directory should still exist
      const dirExists = await fs.access(testDir).then(
        () => true,
        () => false
      );
      expect(dirExists).toBe(true);
    });
  });

  describe("renameWorkspace", () => {
    it("is a no-op that returns success with same path", async () => {
      const runtime = new LocalRuntime(testDir);

      const result = await runtime.renameWorkspace(testDir, "old", "new");

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.oldPath).toBe(testDir);
        expect(result.newPath).toBe(testDir);
      }
    });
  });

  describe("forkWorkspace", () => {
    it("returns error - operation not supported", async () => {
      const runtime = new LocalRuntime(testDir);
      const logger = createMockLogger();

      const result = await runtime.forkWorkspace({
        projectPath: testDir,
        sourceWorkspaceName: "main",
        newWorkspaceName: "feature",
        initLogger: logger,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Cannot fork");
      expect(result.error).toContain("project-dir");
    });
  });

  describe("inherited LocalBaseRuntime methods", () => {
    it("exec runs commands in projectPath", async () => {
      const runtime = new LocalRuntime(testDir);

      const stream = await runtime.exec("pwd", {
        cwd: testDir,
        timeout: 10,
      });

      const reader = stream.stdout.getReader();
      let output = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += new TextDecoder().decode(value);
      }

      const exitCode = await stream.exitCode;
      expect(exitCode).toBe(0);
      expect(output.trim()).toBe(testDir);
    });

    it("stat works on projectPath", async () => {
      const runtime = new LocalRuntime(testDir);

      const stat = await runtime.stat(testDir);

      expect(stat.isDirectory).toBe(true);
    });

    it("resolvePath expands tilde", async () => {
      const runtime = new LocalRuntime(testDir);

      const resolved = await runtime.resolvePath("~");

      expect(resolved).toBe(os.homedir());
    });

    it("normalizePath resolves relative paths", () => {
      const runtime = new LocalRuntime(testDir);

      const result = runtime.normalizePath(".", testDir);

      expect(result).toBe(testDir);
    });
  });

  describe("tilde expansion in file operations", () => {
    it("stat expands tilde paths", async () => {
      const runtime = new LocalRuntime(testDir);

      // Create a file in home directory's .mux folder
      const muxDir = path.join(os.homedir(), ".mux", "test-tilde");
      await fs.mkdir(muxDir, { recursive: true });
      const testFile = path.join(muxDir, "test.txt");
      await fs.writeFile(testFile, "test content");

      try {
        // Use tilde path - should work
        const stat = await runtime.stat("~/.mux/test-tilde/test.txt");
        expect(stat.size).toBeGreaterThan(0);
        expect(stat.isDirectory).toBe(false);
      } finally {
        await fs.rm(muxDir, { recursive: true, force: true });
      }
    });

    it("readFile expands tilde paths", async () => {
      const runtime = new LocalRuntime(testDir);

      // Create a file in home directory's .mux folder
      const muxDir = path.join(os.homedir(), ".mux", "test-tilde");
      await fs.mkdir(muxDir, { recursive: true });
      const testFile = path.join(muxDir, "read-test.txt");
      const content = "hello from tilde path";
      await fs.writeFile(testFile, content);

      try {
        // Use tilde path - should work
        const stream = runtime.readFile("~/.mux/test-tilde/read-test.txt");
        const reader = stream.getReader();
        let result = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          result += new TextDecoder().decode(value);
        }
        expect(result).toBe(content);
      } finally {
        await fs.rm(muxDir, { recursive: true, force: true });
      }
    });

    it("writeFile expands tilde paths", async () => {
      const runtime = new LocalRuntime(testDir);

      // Create parent directory in home
      const muxDir = path.join(os.homedir(), ".mux", "test-tilde-write");
      await fs.mkdir(muxDir, { recursive: true });

      try {
        // Use tilde path - should work
        const content = "written via tilde path";
        const stream = runtime.writeFile("~/.mux/test-tilde-write/write-test.txt");
        const writer = stream.getWriter();
        await writer.write(new TextEncoder().encode(content));
        await writer.close();

        // Verify file was written to correct location
        const written = await fs.readFile(path.join(muxDir, "write-test.txt"), "utf-8");
        expect(written).toBe(content);
      } finally {
        await fs.rm(muxDir, { recursive: true, force: true });
      }
    });
  });
});
