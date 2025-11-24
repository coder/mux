import { describe, expect, it } from "bun:test";
import * as os from "os";
import * as path from "path";
import { LocalRuntime } from "./LocalRuntime";
import * as fsPromises from "fs/promises";
import { execFileSync } from "child_process";
import type { InitLogger } from "./Runtime";

describe("LocalRuntime constructor", () => {
  it("should expand tilde in srcBaseDir", () => {
    const runtime = new LocalRuntime("~/workspace");
    const workspacePath = runtime.getWorkspacePath("/home/user/project", "branch");

    // The workspace path should use the expanded home directory
    const expected = path.join(os.homedir(), "workspace", "project", "branch");
    expect(workspacePath).toBe(expected);
  });

  it("should handle absolute paths without expansion", () => {
    const runtime = new LocalRuntime("/absolute/path");
    const workspacePath = runtime.getWorkspacePath("/home/user/project", "branch");

    const expected = path.join("/absolute/path", "project", "branch");
    expect(workspacePath).toBe(expected);
  });

  it("should handle bare tilde", () => {
    const runtime = new LocalRuntime("~");
    const workspacePath = runtime.getWorkspacePath("/home/user/project", "branch");

    const expected = path.join(os.homedir(), "project", "branch");
    expect(workspacePath).toBe(expected);
  });
});

describe("LocalRuntime.resolvePath", () => {
  it("should expand tilde to home directory", async () => {
    const runtime = new LocalRuntime("/tmp");
    const resolved = await runtime.resolvePath("~");
    expect(resolved).toBe(os.homedir());
  });

  it("should expand tilde with path", async () => {
    const runtime = new LocalRuntime("/tmp");
    // Use a path that likely exists (or use /tmp if ~ doesn't have subdirs)
    const resolved = await runtime.resolvePath("~/..");
    const expected = path.dirname(os.homedir());
    expect(resolved).toBe(expected);
  });

  it("should resolve absolute paths", async () => {
    const runtime = new LocalRuntime("/tmp");
    const resolved = await runtime.resolvePath("/tmp");
    expect(resolved).toBe("/tmp");
  });

  it("should resolve non-existent paths without checking existence", async () => {
    const runtime = new LocalRuntime("/tmp");
    const resolved = await runtime.resolvePath("/this/path/does/not/exist/12345");
    // Should resolve to absolute path without checking if it exists
    expect(resolved).toBe("/this/path/does/not/exist/12345");
  });

  it("should resolve relative paths from cwd", async () => {
    const runtime = new LocalRuntime("/tmp");
    const resolved = await runtime.resolvePath(".");
    // Should resolve to absolute path
    expect(path.isAbsolute(resolved)).toBe(true);
  });
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test User",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test User",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function runGit(args: string[], cwd?: string) {
  execFileSync("git", args, { cwd, env: GIT_ENV });
}

function gitOutput(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV }).toString().trim();
}

function createTestInitLogger(): InitLogger {
  const logs: string[] = [];
  return {
    logStep: (m: string) => {
      logs.push(`[step] ${m}`);
    },
    logStdout: (line: string) => {
      if (line) logs.push(`[out] ${line}`);
    },
    logStderr: (line: string) => {
      if (line) logs.push(`[err] ${line}`);
    },
    logComplete: (code: number) => {
      logs.push(`[done] ${code}`);
    },
  };
}

describe("LocalRuntime auto rebase", () => {
  it("rebases onto origin when enabled", async () => {
    const tmpRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "local-runtime-"));
    const originDir = path.join(tmpRoot, "origin.git");
    const projectDir = path.join(tmpRoot, "project");
    const upstreamDir = path.join(tmpRoot, "upstream");
    const workspacesDir = path.join(tmpRoot, "workspaces");
    const trunkBranch = "main";

    try {
      runGit(["init", "--bare", originDir]);

      await fsPromises.mkdir(projectDir, { recursive: true });
      runGit(["init", "-b", trunkBranch], projectDir);
      runGit(["remote", "add", "origin", originDir], projectDir);

      await fsPromises.writeFile(path.join(projectDir, "README.md"), "first\n");
      runGit(["add", "README.md"], projectDir);
      runGit(["commit", "-m", "initial"], projectDir);
      runGit(["push", "-u", "origin", trunkBranch], projectDir);

      runGit(["clone", "-b", trunkBranch, originDir, upstreamDir]);
      await fsPromises.appendFile(path.join(upstreamDir, "README.md"), "second\n");
      runGit(["commit", "-am", "upstream change"], upstreamDir);
      runGit(["push", "origin", trunkBranch], upstreamDir);

      const runtime = new LocalRuntime(workspacesDir);
      const initLogger = createTestInitLogger();
      const branchName = "auto-rebase-test";

      const createResult = await runtime.createWorkspace({
        projectPath: projectDir,
        branchName,
        trunkBranch,
        directoryName: branchName,
        initLogger,
      });

      expect(createResult.success).toBe(true);
      expect(createResult.workspacePath).toBeTruthy();
      const workspacePath = createResult.workspacePath!;

      await runtime.initWorkspace({
        projectPath: projectDir,
        branchName,
        trunkBranch,
        workspacePath,
        initLogger,
        autoRebaseTrunk: true,
      });

      const workspaceHead = gitOutput(["rev-parse", "HEAD"], workspacePath);
      const originHead = gitOutput(["rev-parse", `origin/${trunkBranch}`], projectDir);
      expect(workspaceHead).toBe(originHead);
    } finally {
      await fsPromises.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
