import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { Config } from "@/node/config";
import { ProjectService, type CloneEvent } from "./projectService";

async function createLocalGitRepository(rootDir: string, repoName: string): Promise<string> {
  const repoPath = path.join(rootDir, repoName);
  await fs.mkdir(repoPath, { recursive: true });
  await fs.writeFile(path.join(repoPath, "README.md"), "# test\n", "utf-8");

  execSync("git init -b main", { cwd: repoPath, stdio: "ignore" });
  execSync("git add README.md", { cwd: repoPath, stdio: "ignore" });
  execSync('git -c user.name="test" -c user.email="test@test" commit -m "initial"', {
    cwd: repoPath,
    stdio: "ignore",
  });

  return repoPath;
}

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

  describe("clone", () => {
    it("clones a local repository and registers it as a project", async () => {
      const sourceRepoPath = await createLocalGitRepository(tempDir, "source-repo");
      const cloneParentDir = path.join(tempDir, "clones");

      const result = await service.clone({
        repoUrl: sourceRepoPath,
        cloneParentDir,
      });

      expect(result.success).toBe(true);
      if (!result.success) throw new Error("Expected success");

      const expectedProjectPath = path.resolve(cloneParentDir, "source-repo");
      expect(result.data.normalizedPath).toBe(expectedProjectPath);
      expect(result.data.projectConfig).toEqual({ workspaces: [] });

      const gitDir = await fs.stat(path.join(expectedProjectPath, ".git"));
      expect(gitDir.isDirectory()).toBe(true);

      const loadedConfig = config.loadConfigOrDefault();
      expect(loadedConfig.projects.has(expectedProjectPath)).toBe(true);
      expect(loadedConfig.defaultProjectCloneDir).toBeUndefined();
    });

    it("normalizes owner/repo shorthand to a valid GitHub remote URL", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const cloneParentDir = path.join(tempDir, "shorthand-clones");
      const fakeBinDir = path.join(tempDir, "fake-bin");
      const fakeGitPath = path.join(fakeBinDir, "git");
      const fakeGitArgsLogPath = path.join(tempDir, "fake-git-args.log");
      const originalPath = process.env.PATH ?? "";
      const originalFakeGitArgsLogPath = process.env.FAKE_GIT_ARGS_LOG;
      const originalHome = process.env.HOME;
      const originalSshAuthSock = process.env.SSH_AUTH_SOCK;

      await fs.mkdir(fakeBinDir, { recursive: true });
      await fs.writeFile(
        fakeGitPath,
        `#!/bin/sh
printf '%s\n' "$@" > "$FAKE_GIT_ARGS_LOG"
if [ "$1" = "clone" ]; then
  mkdir -p "$5/.git"
  exit 0
fi
exit 1
`,
        "utf-8"
      );
      await fs.chmod(fakeGitPath, 0o755);

      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
      process.env.FAKE_GIT_ARGS_LOG = fakeGitArgsLogPath;
      process.env.HOME = tempDir;
      delete process.env.SSH_AUTH_SOCK;

      try {
        const result = await service.clone({
          repoUrl: "owner/repo",
          cloneParentDir,
        });

        expect(result.success).toBe(true);
        if (!result.success) throw new Error("Expected success");

        const loggedArgs = (await fs.readFile(fakeGitArgsLogPath, "utf-8")).trim().split("\n");

        expect(loggedArgs[0]).toBe("clone");
        expect(loggedArgs[1]).toBe("--progress");
        expect(loggedArgs[2]).toBe("--");
        expect(loggedArgs[3]).toMatch(
          /^((https:\/\/github\.com\/owner\/repo\.git)|(git@github\.com:owner\/repo\.git))$/
        );
        expect(loggedArgs[4]).toBe(path.resolve(cloneParentDir, "repo"));
      } finally {
        process.env.PATH = originalPath;
        if (originalFakeGitArgsLogPath === undefined) {
          delete process.env.FAKE_GIT_ARGS_LOG;
        } else {
          process.env.FAKE_GIT_ARGS_LOG = originalFakeGitArgsLogPath;
        }
        if (originalHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = originalHome;
        }
        if (originalSshAuthSock === undefined) {
          delete process.env.SSH_AUTH_SOCK;
        } else {
          process.env.SSH_AUTH_SOCK = originalSshAuthSock;
        }
      }
    });

    it("normalizes owner/repo shorthand to GitHub SSH when SSH credentials are available", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const cloneParentDir = path.join(tempDir, "ssh-shorthand-clones");
      const fakeBinDir = path.join(tempDir, "fake-bin-ssh");
      const fakeGitPath = path.join(fakeBinDir, "git");
      const fakeGitArgsLogPath = path.join(tempDir, "fake-git-ssh-args.log");
      const originalPath = process.env.PATH ?? "";
      const originalFakeGitArgsLogPath = process.env.FAKE_GIT_ARGS_LOG;
      const originalHome = process.env.HOME;
      const originalSshAuthSock = process.env.SSH_AUTH_SOCK;

      await fs.mkdir(fakeBinDir, { recursive: true });
      await fs.writeFile(
        fakeGitPath,
        `#!/bin/sh
printf '%s\n' "$@" > "$FAKE_GIT_ARGS_LOG"
if [ "$1" = "clone" ]; then
  mkdir -p "$5/.git"
  exit 0
fi
exit 1
`,
        "utf-8"
      );
      await fs.chmod(fakeGitPath, 0o755);

      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
      process.env.FAKE_GIT_ARGS_LOG = fakeGitArgsLogPath;
      process.env.HOME = tempDir;
      process.env.SSH_AUTH_SOCK = path.join(tempDir, "fake-ssh-agent.sock");

      try {
        const result = await service.clone({
          repoUrl: "owner/repo",
          cloneParentDir,
        });

        expect(result.success).toBe(true);
        if (!result.success) throw new Error("Expected success");

        const loggedArgs = (await fs.readFile(fakeGitArgsLogPath, "utf-8")).trim().split("\n");

        expect(loggedArgs[0]).toBe("clone");
        expect(loggedArgs[1]).toBe("--progress");
        expect(loggedArgs[2]).toBe("--");
        expect(loggedArgs[3]).toBe("git@github.com:owner/repo.git");
        expect(loggedArgs[4]).toBe(path.resolve(cloneParentDir, "repo"));
      } finally {
        process.env.PATH = originalPath;
        if (originalFakeGitArgsLogPath === undefined) {
          delete process.env.FAKE_GIT_ARGS_LOG;
        } else {
          process.env.FAKE_GIT_ARGS_LOG = originalFakeGitArgsLogPath;
        }
        if (originalHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = originalHome;
        }
        if (originalSshAuthSock === undefined) {
          delete process.env.SSH_AUTH_SOCK;
        } else {
          process.env.SSH_AUTH_SOCK = originalSshAuthSock;
        }
      }
    });

    it("returns error when clone destination already exists", async () => {
      const sourceRepoPath = await createLocalGitRepository(tempDir, "source-repo");
      const cloneParentDir = path.join(tempDir, "clones");
      const existingDestination = path.join(cloneParentDir, "source-repo");

      await fs.mkdir(existingDestination, { recursive: true });

      const result = await service.clone({
        repoUrl: sourceRepoPath,
        cloneParentDir,
      });

      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected failure");
      expect(result.error).toContain("Destination already exists");
    });
  });

  describe("cloneWithProgress", () => {
    it("emits progress events and registers project on success", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const sourceRepoPath = await createLocalGitRepository(tempDir, "source-repo-progress");
      const cloneParentDir = path.join(tempDir, "progress-clones");
      const fakeBinDir = path.join(tempDir, "fake-bin-progress");
      const fakeGitPath = path.join(fakeBinDir, "git");
      const originalPath = process.env.PATH ?? "";

      await fs.mkdir(fakeBinDir, { recursive: true });
      await fs.writeFile(
        fakeGitPath,
        `#!/bin/sh
if [ "$1" = "clone" ]; then
  echo 'progress: starting' >&2
  mkdir -p "$5/.git"
  exit 0
fi
exit 1
`,
        "utf-8"
      );
      await fs.chmod(fakeGitPath, 0o755);

      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;

      try {
        const events: CloneEvent[] = [];
        for await (const event of service.cloneWithProgress({
          repoUrl: sourceRepoPath,
          cloneParentDir,
        })) {
          events.push(event);
        }

        const progressEvent = events.find((event) => event.type === "progress");
        expect(progressEvent?.type).toBe("progress");
        if (progressEvent?.type !== "progress") throw new Error("Expected progress event");
        expect(progressEvent.line).toContain("progress: starting");

        const successEvent = events.find((event) => event.type === "success");
        expect(successEvent?.type).toBe("success");
        if (successEvent?.type !== "success") throw new Error("Expected success event");

        const expectedProjectPath = path.resolve(cloneParentDir, "source-repo-progress");
        expect(successEvent.normalizedPath).toBe(expectedProjectPath);

        const loadedConfig = config.loadConfigOrDefault();
        expect(loadedConfig.projects.has(expectedProjectPath)).toBe(true);
      } finally {
        process.env.PATH = originalPath;
      }
    });

    it("cleans up partial clone and yields cancellation event when aborted", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const sourceRepoPath = await createLocalGitRepository(tempDir, "source-repo-cancel");
      const cloneParentDir = path.join(tempDir, "cancel-clones");
      const fakeBinDir = path.join(tempDir, "fake-bin-cancel");
      const fakeGitPath = path.join(fakeBinDir, "git");
      const originalPath = process.env.PATH ?? "";

      await fs.mkdir(fakeBinDir, { recursive: true });
      await fs.writeFile(
        fakeGitPath,
        `#!/bin/sh
if [ "$1" = "clone" ]; then
  echo 'progress: starting' >&2
  mkdir -p "$5/.git"
  sleep 1000 &
  pid=$!
  trap 'kill $pid 2>/dev/null; exit 0' TERM INT
  wait $pid
  exit 0
fi
exit 1
`,
        "utf-8"
      );
      await fs.chmod(fakeGitPath, 0o755);

      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;

      const controller = new AbortController();
      let sawProgress = false;
      let lastEvent: CloneEvent | null = null;

      try {
        for await (const event of service.cloneWithProgress(
          {
            repoUrl: sourceRepoPath,
            cloneParentDir,
          },
          controller.signal
        )) {
          lastEvent = event;
          if (!sawProgress && event.type === "progress") {
            sawProgress = true;
            controller.abort();
          }
        }
      } finally {
        process.env.PATH = originalPath;
      }

      expect(sawProgress).toBe(true);
      expect(lastEvent?.type).toBe("error");
      if (lastEvent?.type !== "error") throw new Error("Expected error event");
      expect(lastEvent.error).toContain("Clone cancelled");

      const expectedProjectPath = path.resolve(cloneParentDir, "source-repo-cancel");
      expect(config.loadConfigOrDefault().projects.has(expectedProjectPath)).toBe(false);

      try {
        await fs.stat(expectedProjectPath);
        throw new Error("Expected clone destination to be cleaned up");
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        expect(err.code).toBe("ENOENT");
      }
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
