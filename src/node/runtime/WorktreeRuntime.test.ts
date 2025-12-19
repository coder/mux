import { describe, expect, it } from "bun:test";
import * as os from "os";
import * as path from "path";
import * as fsPromises from "fs/promises";
import { execSync } from "node:child_process";
import { WorktreeRuntime } from "./WorktreeRuntime";
import type { InitLogger } from "./Runtime";

function initGitRepo(projectPath: string): void {
  execSync("git init -b main", { cwd: projectPath, stdio: "ignore" });
  execSync('git config user.email "test@example.com"', { cwd: projectPath, stdio: "ignore" });
  execSync('git config user.name "test"', { cwd: projectPath, stdio: "ignore" });
  // Ensure tests don't hang when developers have global commit signing enabled.
  execSync("git config commit.gpgsign false", { cwd: projectPath, stdio: "ignore" });
  execSync("bash -lc 'echo \"hello\" > README.md'", { cwd: projectPath, stdio: "ignore" });
  execSync("git add README.md", { cwd: projectPath, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: projectPath, stdio: "ignore" });
}

function createNullInitLogger(): InitLogger {
  return {
    logStep: (_message: string) => undefined,
    logStdout: (_line: string) => undefined,
    logStderr: (_line: string) => undefined,
    logComplete: (_exitCode: number) => undefined,
  };
}

describe("WorktreeRuntime constructor", () => {
  it("should expand tilde in srcBaseDir", () => {
    const runtime = new WorktreeRuntime("~/workspace");
    const workspacePath = runtime.getWorkspacePath("/home/user/project", "branch");

    // The workspace path should use the expanded home directory
    const expected = path.join(os.homedir(), "workspace", "project", "branch");
    expect(workspacePath).toBe(expected);
  });

  it("should handle absolute paths without expansion", () => {
    const runtime = new WorktreeRuntime("/absolute/path");
    const workspacePath = runtime.getWorkspacePath("/home/user/project", "branch");

    const expected = path.join("/absolute/path", "project", "branch");
    expect(workspacePath).toBe(expected);
  });

  it("should handle bare tilde", () => {
    const runtime = new WorktreeRuntime("~");
    const workspacePath = runtime.getWorkspacePath("/home/user/project", "branch");

    const expected = path.join(os.homedir(), "project", "branch");
    expect(workspacePath).toBe(expected);
  });
});

describe("WorktreeRuntime.resolvePath", () => {
  it("should expand tilde to home directory", async () => {
    const runtime = new WorktreeRuntime("/tmp");
    const resolved = await runtime.resolvePath("~");
    expect(resolved).toBe(os.homedir());
  });

  it("should expand tilde with path", async () => {
    const runtime = new WorktreeRuntime("/tmp");
    // Use a path that likely exists (or use /tmp if ~ doesn't have subdirs)
    const resolved = await runtime.resolvePath("~/..");
    const expected = path.dirname(os.homedir());
    expect(resolved).toBe(expected);
  });

  it("should resolve absolute paths", async () => {
    const runtime = new WorktreeRuntime("/tmp");
    const resolved = await runtime.resolvePath("/tmp");
    expect(resolved).toBe("/tmp");
  });

  it("should resolve non-existent paths without checking existence", async () => {
    const runtime = new WorktreeRuntime("/tmp");
    const resolved = await runtime.resolvePath("/this/path/does/not/exist/12345");
    // Should resolve to absolute path without checking if it exists
    expect(resolved).toBe("/this/path/does/not/exist/12345");
  });

  it("should resolve relative paths from cwd", async () => {
    const runtime = new WorktreeRuntime("/tmp");
    const resolved = await runtime.resolvePath(".");
    // Should resolve to absolute path
    expect(path.isAbsolute(resolved)).toBe(true);
  });
});

describe("WorktreeRuntime.deleteWorkspace", () => {
  it("deletes agent branches when removing worktrees", async () => {
    const rootDir = await fsPromises.realpath(
      await fsPromises.mkdtemp(path.join(os.tmpdir(), "worktree-runtime-delete-"))
    );

    try {
      const projectPath = path.join(rootDir, "repo");
      await fsPromises.mkdir(projectPath, { recursive: true });
      initGitRepo(projectPath);

      const srcBaseDir = path.join(rootDir, "src");
      await fsPromises.mkdir(srcBaseDir, { recursive: true });

      const runtime = new WorktreeRuntime(srcBaseDir);
      const initLogger = createNullInitLogger();

      const branchName = "agent_explore_aaaaaaaaaa";
      const createResult = await runtime.createWorkspace({
        projectPath,
        branchName,
        trunkBranch: "main",
        directoryName: branchName,
        initLogger,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      const before = execSync(`git branch --list "${branchName}"`, {
        cwd: projectPath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      expect(before).toContain(branchName);

      const deleteResult = await runtime.deleteWorkspace(projectPath, branchName, true);
      expect(deleteResult.success).toBe(true);

      const after = execSync(`git branch --list "${branchName}"`, {
        cwd: projectPath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      expect(after).toBe("");
    } finally {
      await fsPromises.rm(rootDir, { recursive: true, force: true });
    }
  }, 20_000);
});
