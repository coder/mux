import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RuntimeStatusEvent } from "./Runtime";
import { ContainerManager } from "@/node/multiProject/containerManager";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { WorktreeRuntime } from "./WorktreeRuntime";
import { MultiProjectRuntime } from "./multiProjectRuntime";

async function initGitRepo(projectPath: string): Promise<void> {
  await fs.mkdir(projectPath, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: projectPath, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: projectPath,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "test"], { cwd: projectPath, stdio: "ignore" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: projectPath, stdio: "ignore" });

  await fs.writeFile(path.join(projectPath, "README.md"), "hello\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: projectPath, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: projectPath, stdio: "ignore" });
}

async function createWorkspaceWorktree(
  projectPath: string,
  srcBaseDir: string,
  workspaceName: string
): Promise<string> {
  const workspacePath = path.join(srcBaseDir, path.basename(projectPath), workspaceName);
  await fs.mkdir(path.dirname(workspacePath), { recursive: true });
  execFileSync("git", ["worktree", "add", "-b", workspaceName, workspacePath, "main"], {
    cwd: projectPath,
    stdio: "ignore",
  });
  return workspacePath;
}

describe("MultiProjectRuntime", () => {
  let rootDir: string;
  let srcBaseDir: string;
  let projectAPath: string;
  let projectBPath: string;
  let workspaceName: string;
  let projectAWorkspacePath: string;
  let projectBWorkspacePath: string;
  let containerManager: ContainerManager;
  let runtime: MultiProjectRuntime;

  beforeEach(async () => {
    rootDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "multi-project-runtime-")));
    srcBaseDir = path.join(rootDir, "src");
    await fs.mkdir(srcBaseDir, { recursive: true });

    workspaceName = "shared-workspace";
    projectAPath = path.join(rootDir, "project-a");
    projectBPath = path.join(rootDir, "project-b");

    await initGitRepo(projectAPath);
    await initGitRepo(projectBPath);

    projectAWorkspacePath = await createWorkspaceWorktree(projectAPath, srcBaseDir, workspaceName);
    projectBWorkspacePath = await createWorkspaceWorktree(projectBPath, srcBaseDir, workspaceName);

    containerManager = new ContainerManager(srcBaseDir);
    runtime = new MultiProjectRuntime(
      containerManager,
      [
        {
          projectPath: projectAPath,
          projectName: "project-a",
          runtime: new WorktreeRuntime(srcBaseDir, {
            projectPath: projectAPath,
            workspaceName,
          }),
        },
        {
          projectPath: projectBPath,
          projectName: "project-b",
          runtime: new WorktreeRuntime(srcBaseDir, {
            projectPath: projectBPath,
            workspaceName,
          }),
        },
      ],
      workspaceName
    );
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("ensureReady succeeds when all project runtimes are ready", async () => {
    const events: RuntimeStatusEvent[] = [];

    const result = await runtime.ensureReady({
      statusSink: (event) => events.push(event),
    });

    expect(result).toEqual({ ready: true });
    expect(events.filter((event) => event.phase === "checking")).toHaveLength(2);
    expect(events.filter((event) => event.phase === "ready")).toHaveLength(2);
  });

  it("getWorkspacePath returns the shared container path", () => {
    const workspacePath = runtime.getWorkspacePath(projectAPath, workspaceName);

    expect(workspacePath).toBe(containerManager.getContainerPath(workspaceName));
    expect(workspacePath).toContain(path.join("_workspaces", workspaceName));
  });

  it("exec runs in container directory when cwd is not set", async () => {
    const containerPath = await containerManager.createContainer(workspaceName, [
      {
        projectName: "project-a",
        workspacePath: projectAWorkspacePath,
      },
      {
        projectName: "project-b",
        workspacePath: projectBWorkspacePath,
      },
    ]);

    const result = await execBuffered(runtime, "pwd", {
      cwd: "",
      timeout: 5,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(containerPath);
  });
});
