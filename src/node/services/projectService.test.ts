import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { Config } from "@/node/config";
import { ProjectService } from "./projectService";

describe("ProjectService", () => {
  let tempDir: string;
  let config: Config;
  let service: ProjectService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "projectservice-test-"));
    config = new Config(tempDir);
    service = new ProjectService(config);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("listDirectory", () => {
    it("returns root node with the actual requested path, not empty string", async () => {
      // Create test directory structure
      const testDir = path.join(tempDir, "test-project");
      await fs.mkdir(testDir);
      await fs.mkdir(path.join(testDir, "subdir1"));
      await fs.mkdir(path.join(testDir, "subdir2"));
      await fs.writeFile(path.join(testDir, "file.txt"), "test");

      const result = await service.listDirectory(testDir);

      expect(result.success).toBe(true);
      if (!result.success) throw new Error("Expected success");

      // Critical regression test: root.path must be the actual path, not ""
      // This was broken when buildFileTree() was used, which always returns path: ""
      expect(result.data.path).toBe(testDir);
      expect(result.data.name).toBe(testDir);
      expect(result.data.isDirectory).toBe(true);
    });

    it("returns only immediate subdirectories as children", async () => {
      const testDir = path.join(tempDir, "nested");
      await fs.mkdir(testDir);
      await fs.mkdir(path.join(testDir, "child1"));
      await fs.mkdir(path.join(testDir, "child1", "grandchild")); // nested
      await fs.mkdir(path.join(testDir, "child2"));
      await fs.writeFile(path.join(testDir, "file.txt"), "test"); // file, not dir

      const result = await service.listDirectory(testDir);

      expect(result.success).toBe(true);
      if (!result.success) throw new Error("Expected success");

      // Should only have child1 and child2, not grandchild or file.txt
      expect(result.data.children.length).toBe(2);
      const childNames = result.data.children.map((c) => c.name).sort();
      expect(childNames).toEqual(["child1", "child2"]);
    });

    it("children have correct full paths", async () => {
      const testDir = path.join(tempDir, "paths-test");
      await fs.mkdir(testDir);
      await fs.mkdir(path.join(testDir, "mysubdir"));

      const result = await service.listDirectory(testDir);

      expect(result.success).toBe(true);
      if (!result.success) throw new Error("Expected success");

      expect(result.data.children.length).toBe(1);
      const child = result.data.children[0];
      expect(child.name).toBe("mysubdir");
      expect(child.path).toBe(path.join(testDir, "mysubdir"));
      expect(child.isDirectory).toBe(true);
    });

    it("resolves relative paths to absolute", async () => {
      // Create a subdir in tempDir
      const subdir = path.join(tempDir, "relative-test");
      await fs.mkdir(subdir);

      const result = await service.listDirectory(subdir);

      expect(result.success).toBe(true);
      if (!result.success) throw new Error("Expected success");

      // Should be resolved to absolute path
      expect(path.isAbsolute(result.data.path)).toBe(true);
      expect(result.data.path).toBe(subdir);
    });

    it("handles empty directory", async () => {
      const emptyDir = path.join(tempDir, "empty");
      await fs.mkdir(emptyDir);

      const result = await service.listDirectory(emptyDir);

      expect(result.success).toBe(true);
      if (!result.success) throw new Error("Expected success");

      expect(result.data.path).toBe(emptyDir);
      expect(result.data.children).toEqual([]);
    });

    it("handles '.' path by resolving to current working directory", async () => {
      // Save cwd and change to tempDir for this test
      const originalCwd = process.cwd();
      // Use realpath to resolve symlinks (e.g., /var -> /private/var on macOS)
      const realTempDir = await fs.realpath(tempDir);
      process.chdir(realTempDir);

      try {
        const result = await service.listDirectory(".");

        expect(result.success).toBe(true);
        if (!result.success) throw new Error("Expected success");

        expect(result.data.path).toBe(realTempDir);
        expect(path.isAbsolute(result.data.path)).toBe(true);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("returns error for non-existent directory", async () => {
      const result = await service.listDirectory(path.join(tempDir, "does-not-exist"));

      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected failure");
      expect(result.error).toContain("ENOENT");
    });

    it("expands ~ to home directory", async () => {
      const result = await service.listDirectory("~");

      expect(result.success).toBe(true);
      if (!result.success) throw new Error("Expected success");

      expect(result.data.path).toBe(os.homedir());
    });

    it("expands ~/subpath to home directory subpath", async () => {
      const result = await service.listDirectory("~/.");

      expect(result.success).toBe(true);
      if (!result.success) throw new Error("Expected success");

      expect(result.data.path).toBe(os.homedir());
    });
  });

  describe("gitInit", () => {
    it("initializes git repo in non-git directory with initial commit", async () => {
      const testDir = path.join(tempDir, "new-project");
      await fs.mkdir(testDir);

      const result = await service.gitInit(testDir);

      expect(result.success).toBe(true);

      // Verify .git directory was created
      const gitDir = path.join(testDir, ".git");
      const stat = await fs.stat(gitDir);
      expect(stat.isDirectory()).toBe(true);

      // Verify a branch exists (main) after the initial commit
      const branchResult = await service.listBranches(testDir);
      expect(branchResult.branches).toContain("main");
      expect(branchResult.recommendedTrunk).toBe("main");
    });

    it("succeeds for unborn git repo (git init but no commits)", async () => {
      const testDir = path.join(tempDir, "unborn-git");
      await fs.mkdir(testDir);

      // Create an unborn repo (git init without commits)
      execSync("git init -b main", { cwd: testDir, stdio: "ignore" });

      const result = await service.gitInit(testDir);

      expect(result.success).toBe(true);

      // Verify branch exists after the commit
      const branchResult = await service.listBranches(testDir);
      expect(branchResult.branches).toContain("main");
    });

    it("returns error for git repo with existing commits", async () => {
      const testDir = path.join(tempDir, "existing-git");
      await fs.mkdir(testDir);

      // Create a repo with a commit
      execSync("git init -b main", { cwd: testDir, stdio: "ignore" });
      execSync('git -c user.name="test" -c user.email="test@test" commit --allow-empty -m "test"', {
        cwd: testDir,
        stdio: "ignore",
      });

      const result = await service.gitInit(testDir);

      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected failure");
      expect(result.error).toContain("already a git repository");
    });

    it("returns error for empty project path", async () => {
      const result = await service.gitInit("");

      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected failure");
      expect(result.error).toContain("required");
    });

    it("returns error for non-existent directory", async () => {
      const result = await service.gitInit("/non-existent-path-12345");

      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected failure");
      expect(result.error).toContain("does not exist");
    });
  });
});
