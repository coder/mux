import { describe, expect, it } from "bun:test";
import * as os from "os";
import * as path from "path";
import * as fsPromises from "fs/promises";
import { execSync } from "node:child_process";
import type { InitLogger } from "@/node/runtime/Runtime";
import { WorktreeManager } from "./WorktreeManager";

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

describe("WorktreeManager constructor", () => {
  it("should expand tilde in srcBaseDir", () => {
    const manager = new WorktreeManager("~/workspace");
    const workspacePath = manager.getWorkspacePath("/home/user/project", "branch");

    // The workspace path should use the expanded home directory
    const expected = path.join(os.homedir(), "workspace", "project", "branch");
    expect(workspacePath).toBe(expected);
  });

  it("should handle absolute paths without expansion", () => {
    const manager = new WorktreeManager("/absolute/path");
    const workspacePath = manager.getWorkspacePath("/home/user/project", "branch");

    const expected = path.join("/absolute/path", "project", "branch");
    expect(workspacePath).toBe(expected);
  });

  it("should handle bare tilde", () => {
    const manager = new WorktreeManager("~");
    const workspacePath = manager.getWorkspacePath("/home/user/project", "branch");

    const expected = path.join(os.homedir(), "project", "branch");
    expect(workspacePath).toBe(expected);
  });
});

describe("WorktreeManager.deleteWorkspace", () => {
  it("deletes non-agent branches when removing worktrees (force)", async () => {
    const rootDir = await fsPromises.realpath(
      await fsPromises.mkdtemp(path.join(os.tmpdir(), "worktree-manager-delete-"))
    );

    try {
      const projectPath = path.join(rootDir, "repo");
      await fsPromises.mkdir(projectPath, { recursive: true });
      initGitRepo(projectPath);

      const srcBaseDir = path.join(rootDir, "src");
      await fsPromises.mkdir(srcBaseDir, { recursive: true });

      const manager = new WorktreeManager(srcBaseDir);
      const initLogger = createNullInitLogger();

      const branchName = "feature_aaaaaaaaaa";
      const createResult = await manager.createWorkspace({
        projectPath,
        branchName,
        trunkBranch: "main",
        initLogger,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;
      if (!createResult.workspacePath) {
        throw new Error("Expected workspacePath from createWorkspace");
      }
      const workspacePath = createResult.workspacePath;

      // Make the branch unmerged (so -d would fail); force delete should still delete it.
      execSync("bash -lc 'echo \"change\" >> README.md'", {
        cwd: workspacePath,
        stdio: "ignore",
      });
      execSync("git add README.md", { cwd: workspacePath, stdio: "ignore" });
      execSync('git commit -m "change"', { cwd: workspacePath, stdio: "ignore" });

      const deleteResult = await manager.deleteWorkspace(projectPath, branchName, true);
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

  it("deletes merged branches when removing worktrees (safe delete)", async () => {
    const rootDir = await fsPromises.realpath(
      await fsPromises.mkdtemp(path.join(os.tmpdir(), "worktree-manager-delete-"))
    );

    try {
      const projectPath = path.join(rootDir, "repo");
      await fsPromises.mkdir(projectPath, { recursive: true });
      initGitRepo(projectPath);

      const srcBaseDir = path.join(rootDir, "src");
      await fsPromises.mkdir(srcBaseDir, { recursive: true });

      const manager = new WorktreeManager(srcBaseDir);
      const initLogger = createNullInitLogger();

      const branchName = "feature_merge_aaaaaaaaaa";
      const createResult = await manager.createWorkspace({
        projectPath,
        branchName,
        trunkBranch: "main",
        initLogger,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;
      if (!createResult.workspacePath) {
        throw new Error("Expected workspacePath from createWorkspace");
      }
      const workspacePath = createResult.workspacePath;

      // Commit on the workspace branch.
      execSync("bash -lc 'echo \"merged-change\" >> README.md'", {
        cwd: workspacePath,
        stdio: "ignore",
      });
      execSync("git add README.md", { cwd: workspacePath, stdio: "ignore" });
      execSync('git commit -m "merged-change"', {
        cwd: workspacePath,
        stdio: "ignore",
      });

      // Merge into main so `git branch -d` succeeds.
      execSync(`git merge "${branchName}"`, { cwd: projectPath, stdio: "ignore" });

      const deleteResult = await manager.deleteWorkspace(projectPath, branchName, false);
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

  it("does not delete protected branches", async () => {
    const rootDir = await fsPromises.realpath(
      await fsPromises.mkdtemp(path.join(os.tmpdir(), "worktree-manager-delete-"))
    );

    try {
      const projectPath = path.join(rootDir, "repo");
      await fsPromises.mkdir(projectPath, { recursive: true });
      initGitRepo(projectPath);

      // Move the main worktree off main so we can add a separate worktree on main.
      execSync("git checkout -b other", { cwd: projectPath, stdio: "ignore" });

      const srcBaseDir = path.join(rootDir, "src");
      await fsPromises.mkdir(srcBaseDir, { recursive: true });

      const manager = new WorktreeManager(srcBaseDir);
      const initLogger = createNullInitLogger();

      const branchName = "main";
      const createResult = await manager.createWorkspace({
        projectPath,
        branchName,
        trunkBranch: "main",
        initLogger,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;
      if (!createResult.workspacePath) {
        throw new Error("Expected workspacePath from createWorkspace");
      }
      const workspacePath = createResult.workspacePath;

      const deleteResult = await manager.deleteWorkspace(projectPath, branchName, true);
      expect(deleteResult.success).toBe(true);

      // The worktree directory should be removed.
      let worktreeExists = true;
      try {
        await fsPromises.access(workspacePath);
      } catch {
        worktreeExists = false;
      }
      expect(worktreeExists).toBe(false);

      // But protected branches (like main) should never be deleted.
      const after = execSync(`git branch --list "${branchName}"`, {
        cwd: projectPath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      expect(after).toBe("main");
    } finally {
      await fsPromises.rm(rootDir, { recursive: true, force: true });
    }
  }, 20_000);
});
