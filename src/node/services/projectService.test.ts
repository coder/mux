import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { Config } from "@/node/config";
import type { SshPromptRequest } from "@/common/orpc/schemas/ssh";
import { SshPromptService } from "@/node/services/sshPromptService";
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
      expect(loadedConfig.defaultProjectDir).toBeUndefined();
    });

    it("normalizes trailing-slash owner/repo shorthand to GitHub HTTPS when SSH agent is unavailable", async () => {
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
          repoUrl: "owner/repo/",
          cloneParentDir,
        });

        expect(result.success).toBe(true);
        if (!result.success) throw new Error("Expected success");

        const loggedArgs = (await fs.readFile(fakeGitArgsLogPath, "utf-8")).trim().split("\n");

        expect(loggedArgs[0]).toBe("clone");
        expect(loggedArgs[1]).toBe("--progress");
        expect(loggedArgs[2]).toBe("--");
        expect(loggedArgs[3]).toBe("https://github.com/owner/repo.git");
        expect(path.dirname(loggedArgs[4])).toBe(path.resolve(cloneParentDir));
        expect(path.basename(loggedArgs[4])).toMatch(/^repo\.mux-clone-[a-f0-9]{12}$/);
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
        expect(path.dirname(loggedArgs[4])).toBe(path.resolve(cloneParentDir));
        expect(path.basename(loggedArgs[4])).toMatch(/^repo\.mux-clone-[a-f0-9]{12}$/);
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

    it("yields error and rolls back when cloned project cannot be persisted in config", async () => {
      const sourceRepoPath = await createLocalGitRepository(tempDir, "source-repo-persist-fail");
      const cloneParentDir = path.join(tempDir, "persist-fail-clones");
      const nonPersistingConfig = new Config(tempDir);
      nonPersistingConfig.editConfig = () => Promise.resolve();
      const nonPersistingService = new ProjectService(nonPersistingConfig);

      const events: CloneEvent[] = [];
      for await (const event of nonPersistingService.cloneWithProgress({
        repoUrl: sourceRepoPath,
        cloneParentDir,
      })) {
        events.push(event);
      }

      const terminalEvent = events[events.length - 1];
      expect(terminalEvent?.type).toBe("error");
      if (terminalEvent?.type !== "error") throw new Error("Expected error event");
      expect(terminalEvent.error).toContain("persist");

      const expectedProjectPath = path.resolve(cloneParentDir, "source-repo-persist-fail");
      expect(nonPersistingConfig.loadConfigOrDefault().projects.has(expectedProjectPath)).toBe(
        false
      );

      try {
        await fs.stat(expectedProjectPath);
        throw new Error("Expected clone destination to be rolled back");
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        expect(err.code).toBe("ENOENT");
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

    it("cleans up temp clone directories when consumer stops iterating after abort", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const sourceRepoPath = await createLocalGitRepository(tempDir, "source-repo-stop");
      const cloneParentDir = path.join(tempDir, "stop-clones");
      const fakeBinDir = path.join(tempDir, "fake-bin-stop");
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

      try {
        for await (const event of service.cloneWithProgress(
          {
            repoUrl: sourceRepoPath,
            cloneParentDir,
          },
          controller.signal
        )) {
          if (event.type === "progress") {
            controller.abort();
            break;
          }
        }
      } finally {
        process.env.PATH = originalPath;
      }

      const cloneEntries = await fs
        .readdir(cloneParentDir)
        .catch((error: NodeJS.ErrnoException) =>
          error.code === "ENOENT" ? [] : Promise.reject(error)
        );

      expect(
        cloneEntries.filter((entry) => entry.startsWith("source-repo-stop.mux-clone-"))
      ).toEqual([]);
      expect(cloneEntries).not.toContain("source-repo-stop");
    });

    it("does not delete destination created concurrently during clone failure cleanup", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const sourceRepoPath = await createLocalGitRepository(tempDir, "source-repo-race");
      const cloneParentDir = path.join(tempDir, "race-clones");
      const expectedProjectPath = path.resolve(cloneParentDir, "source-repo-race");
      const concurrentMarkerPath = path.join(expectedProjectPath, "keep.txt");
      const fakeBinDir = path.join(tempDir, "fake-bin-race");
      const fakeGitPath = path.join(fakeBinDir, "git");
      const originalPath = process.env.PATH ?? "";
      const originalConcurrentDestPath = process.env.CONCURRENT_DEST_PATH;
      const originalConcurrentMarkerPath = process.env.CONCURRENT_MARKER_PATH;

      await fs.mkdir(fakeBinDir, { recursive: true });
      await fs.writeFile(
        fakeGitPath,
        `#!/bin/sh
if [ "$1" = "clone" ]; then
  mkdir -p "$5/.git"
  mkdir -p "$CONCURRENT_DEST_PATH"
  printf 'keep\n' > "$CONCURRENT_MARKER_PATH"
  exit 1
fi
exit 1
`,
        "utf-8"
      );
      await fs.chmod(fakeGitPath, 0o755);

      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
      process.env.CONCURRENT_DEST_PATH = expectedProjectPath;
      process.env.CONCURRENT_MARKER_PATH = concurrentMarkerPath;

      try {
        const events: CloneEvent[] = [];
        for await (const event of service.cloneWithProgress({
          repoUrl: sourceRepoPath,
          cloneParentDir,
        })) {
          events.push(event);
        }

        const terminalEvent = events[events.length - 1];
        expect(terminalEvent?.type).toBe("error");
        if (terminalEvent?.type !== "error") throw new Error("Expected error event");
        expect(terminalEvent.error).toContain("Clone failed");

        const destinationStat = await fs.stat(expectedProjectPath);
        expect(destinationStat.isDirectory()).toBe(true);
        expect((await fs.readFile(concurrentMarkerPath, "utf-8")).trim()).toBe("keep");

        const cloneParentEntries = await fs.readdir(cloneParentDir);
        const tempCloneEntries = cloneParentEntries.filter((entry) =>
          entry.startsWith("source-repo-race.mux-clone-")
        );
        expect(tempCloneEntries).toEqual([]);
      } finally {
        process.env.PATH = originalPath;
        if (originalConcurrentDestPath === undefined) {
          delete process.env.CONCURRENT_DEST_PATH;
        } else {
          process.env.CONCURRENT_DEST_PATH = originalConcurrentDestPath;
        }
        if (originalConcurrentMarkerPath === undefined) {
          delete process.env.CONCURRENT_MARKER_PATH;
        } else {
          process.env.CONCURRENT_MARKER_PATH = originalConcurrentMarkerPath;
        }
      }
    });
  });

  describe("cloneWithProgress SSH askpass", () => {
    async function collectCloneEvents(
      projectService: ProjectService,
      repoUrl: string,
      cloneParentDir: string
    ): Promise<CloneEvent[]> {
      const events: CloneEvent[] = [];
      for await (const event of projectService.cloneWithProgress({ repoUrl, cloneParentDir })) {
        events.push(event);
      }
      return events;
    }

    async function readLoggedEnv(logPath: string): Promise<Record<string, string>> {
      const envContent = await fs.readFile(logPath, "utf-8");
      return Object.fromEntries(
        envContent
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.includes("="))
          .map((line) => {
            const separatorIndex = line.indexOf("=");
            return [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)] as const;
          })
      );
    }

    async function writeFakeGitCloneEnvLoggingShim(
      fakeGitPath: string,
      options: { failIfSshAskpassIsSet: boolean }
    ): Promise<void> {
      const sshAskpassGuard = options.failIfSshAskpassIsSet
        ? `
  if [ -n "$SSH_ASKPASS" ]; then
    echo "Unexpected SSH_ASKPASS for non-SSH clone" >&2
    exit 128
  fi`
        : "";

      await fs.writeFile(
        fakeGitPath,
        `#!/bin/sh
if [ "$1" = "clone" ]; then
  printf 'SSH_ASKPASS=%s\nSSH_ASKPASS_REQUIRE=%s\nGIT_TERMINAL_PROMPT=%s\n' "\${SSH_ASKPASS:-}" "\${SSH_ASKPASS_REQUIRE:-}" "\${GIT_TERMINAL_PROMPT:-}" > "$FAKE_GIT_ENV_LOG"${sshAskpassGuard}
  mkdir -p "$5/.git"
  exit 0
fi
exit 1
`,
        "utf-8"
      );
      await fs.chmod(fakeGitPath, 0o755);
    }

    async function cloneAndCaptureAskpassEnv(options: {
      testCaseId: string;
      repoUrl: string;
      failIfSshAskpassIsSet: boolean;
    }): Promise<Record<string, string>> {
      const cloneParentDir = path.join(tempDir, `${options.testCaseId}-clone-parent`);
      const fakeBinDir = path.join(tempDir, `fake-bin-${options.testCaseId}`);
      const fakeGitPath = path.join(fakeBinDir, "git");
      const fakeGitEnvLogPath = path.join(tempDir, `fake-git-${options.testCaseId}-env.log`);
      const originalPath = process.env.PATH ?? "";
      const originalHome = process.env.HOME;
      const originalSshAuthSock = process.env.SSH_AUTH_SOCK;
      const originalFakeGitEnvLogPath = process.env.FAKE_GIT_ENV_LOG;

      await fs.mkdir(fakeBinDir, { recursive: true });
      await writeFakeGitCloneEnvLoggingShim(fakeGitPath, {
        failIfSshAskpassIsSet: options.failIfSshAskpassIsSet,
      });

      const sshPromptService = new SshPromptService(5000);
      const release = sshPromptService.registerInteractiveResponder();
      const sshCloneService = new ProjectService(config, sshPromptService);
      const onRequest = (request: SshPromptRequest) => {
        sshPromptService.respond(request.requestId, "yes");
      };
      sshPromptService.on("request", onRequest);

      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
      process.env.HOME = tempDir;
      process.env.SSH_AUTH_SOCK = path.join(tempDir, "fake-ssh-agent.sock");
      process.env.FAKE_GIT_ENV_LOG = fakeGitEnvLogPath;

      try {
        const events = await collectCloneEvents(sshCloneService, options.repoUrl, cloneParentDir);
        const successEvent = events.find((event) => event.type === "success");
        expect(successEvent?.type).toBe("success");

        return await readLoggedEnv(fakeGitEnvLogPath);
      } finally {
        sshPromptService.off("request", onRequest);
        release();
        process.env.PATH = originalPath;
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
        if (originalFakeGitEnvLogPath === undefined) {
          delete process.env.FAKE_GIT_ENV_LOG;
        } else {
          process.env.FAKE_GIT_ENV_LOG = originalFakeGitEnvLogPath;
        }
      }
    }

    it("SSH clone invokes askpass for host-key prompt and succeeds when accepted", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const cloneParentDir = path.join(tempDir, "ssh-askpass-host-key-accept");
      const fakeBinDir = path.join(tempDir, "fake-bin-ssh-host-key-accept");
      const fakeGitPath = path.join(fakeBinDir, "git");
      const fakeGitEnvLogPath = path.join(tempDir, "fake-git-ssh-host-key-accept-env.log");
      const originalPath = process.env.PATH ?? "";
      const originalHome = process.env.HOME;
      const originalSshAuthSock = process.env.SSH_AUTH_SOCK;
      const originalFakeGitEnvLogPath = process.env.FAKE_GIT_ENV_LOG;

      await fs.mkdir(fakeBinDir, { recursive: true });
      await fs.writeFile(
        fakeGitPath,
        `#!/bin/sh
if [ "$1" = "clone" ]; then
  printf 'SSH_ASKPASS=%s\nSSH_ASKPASS_REQUIRE=%s\nGIT_TERMINAL_PROMPT=%s\n' "\${SSH_ASKPASS:-}" "\${SSH_ASKPASS_REQUIRE:-}" "\${GIT_TERMINAL_PROMPT:-}" > "$FAKE_GIT_ENV_LOG"
  if [ -z "$SSH_ASKPASS" ]; then
    echo "Host key verification failed." >&2
    exit 128
  fi
  RESPONSE=$("$SSH_ASKPASS" "Are you sure you want to continue connecting (yes/no/[fingerprint])? ")
  if [ "$RESPONSE" != "yes" ]; then
    echo "Host key verification failed." >&2
    exit 128
  fi
  mkdir -p "$5/.git"
  exit 0
fi
exit 1
`,
        "utf-8"
      );
      await fs.chmod(fakeGitPath, 0o755);

      const sshPromptService = new SshPromptService(5000);
      const release = sshPromptService.registerInteractiveResponder();
      const sshCloneService = new ProjectService(config, sshPromptService);
      const capturedRequests: SshPromptRequest[] = [];
      const onRequest = (request: SshPromptRequest) => {
        capturedRequests.push(request);
        sshPromptService.respond(request.requestId, "yes");
      };
      sshPromptService.on("request", onRequest);

      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
      process.env.HOME = tempDir;
      process.env.SSH_AUTH_SOCK = path.join(tempDir, "fake-ssh-agent.sock");
      process.env.FAKE_GIT_ENV_LOG = fakeGitEnvLogPath;

      try {
        const events = await collectCloneEvents(
          sshCloneService,
          "testuser/testrepo",
          cloneParentDir
        );

        const successEvent = events.find((event) => event.type === "success");
        expect(successEvent?.type).toBe("success");

        const promptRequest = capturedRequests[0];
        expect(promptRequest?.kind).toBe("host-key");
        if (promptRequest?.kind !== "host-key") throw new Error("Expected host-key prompt request");
        expect(promptRequest.prompt).toContain("continue connecting");

        const env = await readLoggedEnv(fakeGitEnvLogPath);
        expect(env.SSH_ASKPASS).toContain("mux-askpass");
        expect(env.SSH_ASKPASS_REQUIRE).toBe("force");
        expect(env.GIT_TERMINAL_PROMPT).toBe("0");
      } finally {
        sshPromptService.off("request", onRequest);
        release();
        process.env.PATH = originalPath;
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
        if (originalFakeGitEnvLogPath === undefined) {
          delete process.env.FAKE_GIT_ENV_LOG;
        } else {
          process.env.FAKE_GIT_ENV_LOG = originalFakeGitEnvLogPath;
        }
      }
    });

    it("coalesces concurrent host-key prompts for the same SSH endpoint", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const cloneParentDir = path.join(tempDir, "ssh-askpass-host-key-dedupe");
      const fakeBinDir = path.join(tempDir, "fake-bin-ssh-host-key-dedupe");
      const fakeGitPath = path.join(fakeBinDir, "git");
      const originalPath = process.env.PATH ?? "";
      const originalHome = process.env.HOME;
      const originalSshAuthSock = process.env.SSH_AUTH_SOCK;

      await fs.mkdir(fakeBinDir, { recursive: true });
      await fs.writeFile(
        fakeGitPath,
        `#!/bin/sh
if [ "$1" = "clone" ]; then
  if [ -z "$SSH_ASKPASS" ]; then
    echo "Host key verification failed." >&2
    exit 128
  fi
  RESPONSE=$("$SSH_ASKPASS" "Are you sure you want to continue connecting (yes/no/[fingerprint])? ")
  if [ "$RESPONSE" != "yes" ]; then
    echo "Host key verification failed." >&2
    exit 128
  fi
  mkdir -p "$5/.git"
  exit 0
fi
exit 1
`,
        "utf-8"
      );
      await fs.chmod(fakeGitPath, 0o755);

      const sshPromptService = new SshPromptService(5000);
      const release = sshPromptService.registerInteractiveResponder();
      const sshCloneService = new ProjectService(config, sshPromptService);
      const capturedRequests: SshPromptRequest[] = [];
      const onRequest = (request: SshPromptRequest) => {
        capturedRequests.push(request);
        setTimeout(() => {
          sshPromptService.respond(request.requestId, "yes");
        }, 200);
      };
      sshPromptService.on("request", onRequest);

      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
      process.env.HOME = tempDir;
      process.env.SSH_AUTH_SOCK = path.join(tempDir, "fake-ssh-agent.sock");

      try {
        const [eventsA, eventsB] = await Promise.all([
          collectCloneEvents(sshCloneService, "github.com:org/repo-a.git", cloneParentDir),
          collectCloneEvents(sshCloneService, "github.com:org/repo-b.git", cloneParentDir),
        ]);

        expect(eventsA.some((event) => event.type === "success")).toBe(true);
        expect(eventsB.some((event) => event.type === "success")).toBe(true);

        const hostKeyRequests = capturedRequests.filter((request) => request.kind === "host-key");
        expect(hostKeyRequests).toHaveLength(1);
      } finally {
        sshPromptService.off("request", onRequest);
        release();
        process.env.PATH = originalPath;
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

    it("SSH clone yields ssh_host_key_rejected when host-key prompt is rejected", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const cloneParentDir = path.join(tempDir, "ssh-askpass-host-key-reject");
      const fakeBinDir = path.join(tempDir, "fake-bin-ssh-host-key-reject");
      const fakeGitPath = path.join(fakeBinDir, "git");
      const originalPath = process.env.PATH ?? "";
      const originalHome = process.env.HOME;
      const originalSshAuthSock = process.env.SSH_AUTH_SOCK;

      await fs.mkdir(fakeBinDir, { recursive: true });
      await fs.writeFile(
        fakeGitPath,
        `#!/bin/sh
if [ "$1" = "clone" ]; then
  if [ -z "$SSH_ASKPASS" ]; then
    echo "Host key verification failed." >&2
    exit 128
  fi
  RESPONSE=$("$SSH_ASKPASS" "Are you sure you want to continue connecting (yes/no/[fingerprint])? ")
  if [ "$RESPONSE" != "yes" ]; then
    echo "Host key verification failed." >&2
    exit 128
  fi
  mkdir -p "$5/.git"
  exit 0
fi
exit 1
`,
        "utf-8"
      );
      await fs.chmod(fakeGitPath, 0o755);

      const sshPromptService = new SshPromptService(5000);
      const release = sshPromptService.registerInteractiveResponder();
      const sshCloneService = new ProjectService(config, sshPromptService);
      const capturedRequests: SshPromptRequest[] = [];
      const onRequest = (request: SshPromptRequest) => {
        capturedRequests.push(request);
        sshPromptService.respond(request.requestId, "no");
      };
      sshPromptService.on("request", onRequest);

      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
      process.env.HOME = tempDir;
      process.env.SSH_AUTH_SOCK = path.join(tempDir, "fake-ssh-agent.sock");

      try {
        const events = await collectCloneEvents(
          sshCloneService,
          "testuser/testrepo",
          cloneParentDir
        );

        const terminalEvent = events[events.length - 1];
        expect(terminalEvent?.type).toBe("error");
        if (terminalEvent?.type !== "error") throw new Error("Expected error event");
        expect(terminalEvent.code).toBe("ssh_host_key_rejected");
        expect(terminalEvent.error).toContain("Host key verification failed");

        expect(capturedRequests[0]?.kind).toBe("host-key");
      } finally {
        sshPromptService.off("request", onRequest);
        release();
        process.env.PATH = originalPath;
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

    it("SSH clone yields ssh_prompt_timeout when host-key prompt expires", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const cloneParentDir = path.join(tempDir, "ssh-askpass-host-key-timeout");
      const fakeBinDir = path.join(tempDir, "fake-bin-ssh-host-key-timeout");
      const fakeGitPath = path.join(fakeBinDir, "git");
      const originalPath = process.env.PATH ?? "";
      const originalHome = process.env.HOME;
      const originalSshAuthSock = process.env.SSH_AUTH_SOCK;

      await fs.mkdir(fakeBinDir, { recursive: true });
      await fs.writeFile(
        fakeGitPath,
        `#!/bin/sh
if [ "$1" = "clone" ]; then
  if [ -z "$SSH_ASKPASS" ]; then
    echo "Host key verification failed." >&2
    exit 128
  fi
  RESPONSE=$("$SSH_ASKPASS" "Are you sure you want to continue connecting (yes/no/[fingerprint])? ")
  if [ "$RESPONSE" != "yes" ]; then
    echo "Host key verification failed." >&2
    exit 128
  fi
  mkdir -p "$5/.git"
  exit 0
fi
exit 1
`,
        "utf-8"
      );
      await fs.chmod(fakeGitPath, 0o755);

      const sshPromptService = new SshPromptService(50);
      const release = sshPromptService.registerInteractiveResponder();
      const sshCloneService = new ProjectService(config, sshPromptService);

      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
      process.env.HOME = tempDir;
      process.env.SSH_AUTH_SOCK = path.join(tempDir, "fake-ssh-agent.sock");

      try {
        const events = await collectCloneEvents(
          sshCloneService,
          "github.com:org/repo-timeout.git",
          cloneParentDir
        );

        const terminalEvent = events[events.length - 1];
        expect(terminalEvent?.type).toBe("error");
        if (terminalEvent?.type !== "error") throw new Error("Expected error event");
        expect(terminalEvent.code).toBe("ssh_prompt_timeout");
      } finally {
        release();
        process.env.PATH = originalPath;
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

    it("keeps ambiguous SSH transport failures as clone_failed", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const cloneParentDir = path.join(tempDir, "ssh-ambiguous-failure");
      const fakeBinDir = path.join(tempDir, "fake-bin-ssh-ambiguous-failure");
      const fakeGitPath = path.join(fakeBinDir, "git");
      const originalPath = process.env.PATH ?? "";
      const originalHome = process.env.HOME;
      const originalSshAuthSock = process.env.SSH_AUTH_SOCK;

      await fs.mkdir(fakeBinDir, { recursive: true });
      await fs.writeFile(
        fakeGitPath,
        `#!/bin/sh
if [ "$1" = "clone" ]; then
  echo "Connection closed by remote host" >&2
  exit 128
fi
exit 1
`,
        "utf-8"
      );
      await fs.chmod(fakeGitPath, 0o755);

      const sshPromptService = new SshPromptService(5000);
      const release = sshPromptService.registerInteractiveResponder();
      const sshCloneService = new ProjectService(config, sshPromptService);

      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
      process.env.HOME = tempDir;
      process.env.SSH_AUTH_SOCK = path.join(tempDir, "fake-ssh-agent.sock");

      try {
        const events = await collectCloneEvents(
          sshCloneService,
          "github.com:org/repo-ambiguous.git",
          cloneParentDir
        );

        const terminalEvent = events[events.length - 1];
        expect(terminalEvent?.type).toBe("error");
        if (terminalEvent?.type !== "error") throw new Error("Expected error event");
        expect(terminalEvent.code).toBe("clone_failed");
        expect(terminalEvent.error).toContain("Connection closed by remote host");
      } finally {
        release();
        process.env.PATH = originalPath;
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

    it("SSH clone yields ssh_credential_cancelled when credential prompt is cancelled", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const cloneParentDir = path.join(tempDir, "ssh-askpass-credential-cancel");
      const fakeBinDir = path.join(tempDir, "fake-bin-ssh-credential-cancel");
      const fakeGitPath = path.join(fakeBinDir, "git");
      const originalPath = process.env.PATH ?? "";
      const originalHome = process.env.HOME;
      const originalSshAuthSock = process.env.SSH_AUTH_SOCK;

      await fs.mkdir(fakeBinDir, { recursive: true });
      await fs.writeFile(
        fakeGitPath,
        `#!/bin/sh
if [ "$1" = "clone" ]; then
  if [ -z "$SSH_ASKPASS" ]; then
    echo "Permission denied (publickey,password)." >&2
    exit 128
  fi
  RESPONSE=$("$SSH_ASKPASS" "Enter passphrase for key '/home/user/.ssh/id_ed25519':")
  if [ -z "$RESPONSE" ]; then
    echo "Permission denied, please try again." >&2
    echo "git@github.com: Permission denied (publickey,password)." >&2
    exit 128
  fi
  mkdir -p "$5/.git"
  exit 0
fi
exit 1
`,
        "utf-8"
      );
      await fs.chmod(fakeGitPath, 0o755);

      const sshPromptService = new SshPromptService(5000);
      const release = sshPromptService.registerInteractiveResponder();
      const sshCloneService = new ProjectService(config, sshPromptService);
      const capturedRequests: SshPromptRequest[] = [];
      const onRequest = (request: SshPromptRequest) => {
        capturedRequests.push(request);
        sshPromptService.respond(request.requestId, "");
      };
      sshPromptService.on("request", onRequest);

      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
      process.env.HOME = tempDir;
      process.env.SSH_AUTH_SOCK = path.join(tempDir, "fake-ssh-agent.sock");

      try {
        const events = await collectCloneEvents(
          sshCloneService,
          "github.com:org/repo-credential-cancel.git",
          cloneParentDir
        );

        const terminalEvent = events[events.length - 1];
        expect(terminalEvent?.type).toBe("error");
        if (terminalEvent?.type !== "error") throw new Error("Expected error event");
        expect(terminalEvent.code).toBe("ssh_credential_cancelled");
        expect(terminalEvent.error).toContain("Permission denied");

        expect(capturedRequests[0]?.kind).toBe("credential");
      } finally {
        sshPromptService.off("request", onRequest);
        release();
        process.env.PATH = originalPath;
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

    it("clone failures include the last three meaningful stderr lines", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const cloneParentDir = path.join(tempDir, "clone-stderr-summary");
      const fakeBinDir = path.join(tempDir, "fake-bin-clone-stderr-summary");
      const fakeGitPath = path.join(fakeBinDir, "git");
      const originalPath = process.env.PATH ?? "";

      await fs.mkdir(fakeBinDir, { recursive: true });
      await fs.writeFile(
        fakeGitPath,
        `#!/bin/sh
if [ "$1" = "clone" ]; then
  echo "remote: Resolving deltas: 100% (1/1)" >&2
  echo "fatal: Could not read from remote repository." >&2
  echo "Please make sure you have the correct access rights" >&2
  echo "and the repository exists." >&2
  exit 128
fi
exit 1
`,
        "utf-8"
      );
      await fs.chmod(fakeGitPath, 0o755);

      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;

      try {
        const events = await collectCloneEvents(
          service,
          "https://github.com/org/repo-summary.git",
          cloneParentDir
        );

        const terminalEvent = events[events.length - 1];
        expect(terminalEvent?.type).toBe("error");
        if (terminalEvent?.type !== "error") throw new Error("Expected error event");
        expect(terminalEvent.code).toBe("clone_failed");
        expect(terminalEvent.error).toBe(
          [
            "fatal: Could not read from remote repository.",
            "Please make sure you have the correct access rights",
            "and the repository exists.",
          ].join("\n")
        );
        expect(terminalEvent.error).toContain("\n");
      } finally {
        process.env.PATH = originalPath;
      }
    });

    it("SSH clone invokes askpass for credential prompt and succeeds", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const cloneParentDir = path.join(tempDir, "ssh-askpass-credential");
      const fakeBinDir = path.join(tempDir, "fake-bin-ssh-credential");
      const fakeGitPath = path.join(fakeBinDir, "git");
      const originalPath = process.env.PATH ?? "";
      const originalHome = process.env.HOME;
      const originalSshAuthSock = process.env.SSH_AUTH_SOCK;

      await fs.mkdir(fakeBinDir, { recursive: true });
      await fs.writeFile(
        fakeGitPath,
        `#!/bin/sh
if [ "$1" = "clone" ]; then
  if [ -z "$SSH_ASKPASS" ]; then
    echo "Permission denied (publickey,password)." >&2
    exit 128
  fi
  RESPONSE=$("$SSH_ASKPASS" "Enter passphrase for key '/home/user/.ssh/id_ed25519':")
  if [ -z "$RESPONSE" ]; then
    echo "Permission denied (publickey,password)." >&2
    exit 128
  fi
  mkdir -p "$5/.git"
  exit 0
fi
exit 1
`,
        "utf-8"
      );
      await fs.chmod(fakeGitPath, 0o755);

      const sshPromptService = new SshPromptService(5000);
      const release = sshPromptService.registerInteractiveResponder();
      const sshCloneService = new ProjectService(config, sshPromptService);
      const capturedRequests: SshPromptRequest[] = [];
      const onRequest = (request: SshPromptRequest) => {
        capturedRequests.push(request);
        sshPromptService.respond(request.requestId, "test-passphrase");
      };
      sshPromptService.on("request", onRequest);

      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
      process.env.HOME = tempDir;
      process.env.SSH_AUTH_SOCK = path.join(tempDir, "fake-ssh-agent.sock");

      try {
        const events = await collectCloneEvents(
          sshCloneService,
          "testuser/testrepo",
          cloneParentDir
        );

        const successEvent = events.find((event) => event.type === "success");
        expect(successEvent?.type).toBe("success");

        const promptRequest = capturedRequests[0];
        expect(promptRequest?.kind).toBe("credential");
        if (promptRequest?.kind !== "credential")
          throw new Error("Expected credential prompt request");
        expect(promptRequest.prompt).toContain("Enter passphrase");
      } finally {
        sshPromptService.off("request", onRequest);
        release();
        process.env.PATH = originalPath;
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

    it("HTTPS clone does not set SSH askpass env vars", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const cloneParentDir = path.join(tempDir, "https-no-askpass");
      const fakeBinDir = path.join(tempDir, "fake-bin-https-no-askpass");
      const fakeGitPath = path.join(fakeBinDir, "git");
      const fakeGitEnvLogPath = path.join(tempDir, "fake-git-https-no-askpass-env.log");
      const originalPath = process.env.PATH ?? "";
      const originalHome = process.env.HOME;
      const originalSshAuthSock = process.env.SSH_AUTH_SOCK;
      const originalFakeGitEnvLogPath = process.env.FAKE_GIT_ENV_LOG;

      await fs.mkdir(fakeBinDir, { recursive: true });
      await fs.writeFile(
        fakeGitPath,
        `#!/bin/sh
if [ "$1" = "clone" ]; then
  printf 'SSH_ASKPASS=%s\nSSH_ASKPASS_REQUIRE=%s\nGIT_TERMINAL_PROMPT=%s\n' "\${SSH_ASKPASS:-}" "\${SSH_ASKPASS_REQUIRE:-}" "\${GIT_TERMINAL_PROMPT:-}" > "$FAKE_GIT_ENV_LOG"
  if [ -n "$SSH_ASKPASS" ]; then
    echo "Unexpected SSH_ASKPASS for HTTPS clone" >&2
    exit 128
  fi
  mkdir -p "$5/.git"
  exit 0
fi
exit 1
`,
        "utf-8"
      );
      await fs.chmod(fakeGitPath, 0o755);

      const sshPromptService = new SshPromptService(5000);
      const release = sshPromptService.registerInteractiveResponder();
      const sshCloneService = new ProjectService(config, sshPromptService);
      let sawPromptRequest = false;
      const onRequest = (request: SshPromptRequest) => {
        sawPromptRequest = true;
        sshPromptService.respond(request.requestId, "yes");
      };
      sshPromptService.on("request", onRequest);

      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
      process.env.HOME = tempDir;
      process.env.SSH_AUTH_SOCK = path.join(tempDir, "fake-ssh-agent.sock");
      process.env.FAKE_GIT_ENV_LOG = fakeGitEnvLogPath;

      try {
        const events = await collectCloneEvents(
          sshCloneService,
          "https://github.com/testuser/testrepo.git",
          cloneParentDir
        );

        const successEvent = events.find((event) => event.type === "success");
        expect(successEvent?.type).toBe("success");

        expect(sawPromptRequest).toBe(false);

        const env = await readLoggedEnv(fakeGitEnvLogPath);
        expect(env.SSH_ASKPASS).toBe("");
        expect(env.SSH_ASKPASS_REQUIRE).toBe("");
        expect(env.GIT_TERMINAL_PROMPT).toBe("0");
      } finally {
        sshPromptService.off("request", onRequest);
        release();
        process.env.PATH = originalPath;
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
        if (originalFakeGitEnvLogPath === undefined) {
          delete process.env.FAKE_GIT_ENV_LOG;
        } else {
          process.env.FAKE_GIT_ENV_LOG = originalFakeGitEnvLogPath;
        }
      }
    });

    it("sets SSH askpass env for ssh:// clone URL", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const env = await cloneAndCaptureAskpassEnv({
        testCaseId: "ssh-transport-ssh-scheme",
        repoUrl: "ssh://github.com/testuser/testrepo.git",
        failIfSshAskpassIsSet: false,
      });

      expect(env.SSH_ASKPASS).not.toBe("");
      expect(env.SSH_ASKPASS_REQUIRE).toBe("force");
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    });

    it("sets SSH askpass env for git+ssh:// clone URL", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const env = await cloneAndCaptureAskpassEnv({
        testCaseId: "ssh-transport-git-plus-ssh",
        repoUrl: "git+ssh://github.com/testuser/testrepo.git",
        failIfSshAskpassIsSet: false,
      });

      expect(env.SSH_ASKPASS).not.toBe("");
      expect(env.SSH_ASKPASS_REQUIRE).toBe("force");
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    });

    it("sets SSH askpass env for ssh+git:// clone URL", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const env = await cloneAndCaptureAskpassEnv({
        testCaseId: "ssh-transport-ssh-plus-git",
        repoUrl: "ssh+git://github.com/testuser/testrepo.git",
        failIfSshAskpassIsSet: false,
      });

      expect(env.SSH_ASKPASS).not.toBe("");
      expect(env.SSH_ASKPASS_REQUIRE).toBe("force");
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    });

    it("does not set SSH askpass env for git:// clone URL", async () => {
      if (process.platform === "win32") {
        // This test relies on a POSIX shell shim named "git" in PATH.
        return;
      }

      const env = await cloneAndCaptureAskpassEnv({
        testCaseId: "ssh-transport-git-scheme",
        repoUrl: "git://github.com/testuser/testrepo.git",
        failIfSshAskpassIsSet: true,
      });

      expect(env.SSH_ASKPASS).toBe("");
      expect(env.SSH_ASKPASS_REQUIRE).toBe("");
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
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

  describe("remove", () => {
    it("removes project with no workspaces", async () => {
      const projectPath = "/fake/project";
      const cfg = config.loadConfigOrDefault();
      cfg.projects.set(projectPath, { workspaces: [] });
      await config.saveConfig(cfg);

      const result = await service.remove(projectPath);

      expect(result.success).toBe(true);
      const after = config.loadConfigOrDefault();
      expect(after.projects.has(projectPath)).toBe(false);
    });

    it("returns project_not_found for unknown project", async () => {
      const result = await service.remove("/no/such/project");

      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected failure");
      expect(result.error.type).toBe("project_not_found");
    });

    it("blocks removal when workspaces still exist on disk", async () => {
      const wsDir = path.join(tempDir, "real-workspace");
      await fs.mkdir(wsDir, { recursive: true });

      const projectPath = "/fake/project";
      const cfg = config.loadConfigOrDefault();
      cfg.projects.set(projectPath, {
        workspaces: [{ path: wsDir }],
      });
      await config.saveConfig(cfg);

      const result = await service.remove(projectPath);

      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected failure");
      expect(result.error.type).toBe("workspace_blockers");
    });

    it("auto-prunes stale workspace entries and removes project", async () => {
      const stalePath = path.join(tempDir, "deleted-workspace-dir");
      // Do NOT create the directory — simulating manual deletion

      const projectPath = "/fake/project";
      const cfg = config.loadConfigOrDefault();
      cfg.projects.set(projectPath, {
        workspaces: [{ path: stalePath }],
      });
      await config.saveConfig(cfg);

      const result = await service.remove(projectPath);

      expect(result.success).toBe(true);
      const after = config.loadConfigOrDefault();
      expect(after.projects.has(projectPath)).toBe(false);
    });

    it("preserves remote runtime workspace entries even if path is not local", async () => {
      const projectPath = "/fake/project";
      const cfg = config.loadConfigOrDefault();
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: "/remote/host/workspace",
            runtimeConfig: { type: "ssh", host: "remote", srcBaseDir: "/remote" },
          },
        ],
      });
      await config.saveConfig(cfg);

      const result = await service.remove(projectPath);

      // Should block on the SSH workspace, not prune it
      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected failure");
      expect(result.error.type).toBe("workspace_blockers");

      // Workspace entry should still be in config
      const after = config.loadConfigOrDefault();
      const project = after.projects.get(projectPath);
      expect(project).toBeDefined();
      expect(project!.workspaces).toHaveLength(1);
    });

    it("prunes stale entries but blocks on remaining real workspaces", async () => {
      const stalePath = path.join(tempDir, "gone-workspace");
      const realDir = path.join(tempDir, "still-here");
      await fs.mkdir(realDir, { recursive: true });

      const projectPath = "/fake/project";
      const cfg = config.loadConfigOrDefault();
      cfg.projects.set(projectPath, {
        workspaces: [{ path: stalePath }, { path: realDir }],
      });
      await config.saveConfig(cfg);

      const result = await service.remove(projectPath);

      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected failure");
      expect(result.error.type).toBe("workspace_blockers");

      // Stale entry should have been pruned from config even though removal was blocked
      const after = config.loadConfigOrDefault();
      const project = after.projects.get(projectPath);
      expect(project).toBeDefined();
      expect(project!.workspaces).toHaveLength(1);
      expect(project!.workspaces[0]?.path).toBe(realDir);
    });
  });
});
