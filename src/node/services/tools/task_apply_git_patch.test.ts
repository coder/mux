import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execSync } from "node:child_process";

import type { ToolExecutionOptions } from "ai";

import type { SubagentGitProjectPatchArtifact } from "@/common/utils/tools/toolDefinitions";
import {
  applyTaskGitPatchArtifact,
  createTaskApplyGitPatchTool,
} from "@/node/services/tools/task_apply_git_patch";
import {
  getSubagentGitPatchArtifactsFilePath,
  getSubagentGitPatchMboxPath,
  getSubagentGitPatchWorktreePatchPath,
  readLocalPatchApplyCompletion,
  readLocalPatchPartialApply,
  readSubagentGitPatchArtifact,
  setLocalPatchPartialApply,
  upsertSubagentGitPatchArtifact,
} from "@/node/services/subagentGitPatchArtifacts";
import * as subagentGitPatchArtifactsModule from "@/node/services/subagentGitPatchArtifacts";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { getTestDeps } from "@/node/services/tools/testHelpers";

const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

function initGitRepo(repoPath: string): void {
  execSync("git init -b main", { cwd: repoPath, stdio: "ignore" });
  execSync('git config user.email "test@example.com"', { cwd: repoPath, stdio: "ignore" });
  execSync('git config user.name "test"', { cwd: repoPath, stdio: "ignore" });
  execSync("git config commit.gpgsign false", { cwd: repoPath, stdio: "ignore" });
}

async function commitFile(
  repoPath: string,
  fileName: string,
  content: string,
  message: string
): Promise<void> {
  await fsPromises.writeFile(path.join(repoPath, fileName), content, "utf-8");
  execSync(`git add -- ${fileName}`, { cwd: repoPath, stdio: "ignore" });
  execSync(`git commit -m ${JSON.stringify(message)}`, { cwd: repoPath, stdio: "ignore" });
}

async function buildReadyProjectArtifact(params: {
  sessionDir: string;
  childTaskId: string;
  storageKey: string;
  projectPath: string;
  projectName: string;
  childRepo: string;
  baseSha: string;
  headSha: string;
  formatPatchArgs?: string;
}) {
  const patchPath = getSubagentGitPatchMboxPath(
    params.sessionDir,
    params.childTaskId,
    params.storageKey
  );
  const patch = execSync(
    `git format-patch --stdout --binary ${params.formatPatchArgs ?? ""} ${params.baseSha}..${
      params.headSha
    }`,
    {
      cwd: params.childRepo,
      encoding: "buffer",
    }
  );

  await fsPromises.mkdir(path.dirname(patchPath), { recursive: true });
  await fsPromises.writeFile(patchPath, patch);

  return {
    projectPath: params.projectPath,
    projectName: params.projectName,
    storageKey: params.storageKey,
    status: "ready" as const,
    baseCommitSha: params.baseSha,
    headCommitSha: params.headSha,
    commitCount: 1,
    mboxPath: patchPath,
  };
}

async function writePatchArtifact(params: {
  sessionDir: string;
  workspaceId: string;
  childTaskId: string;
  projectArtifacts: SubagentGitProjectPatchArtifact[];
}) {
  await upsertSubagentGitPatchArtifact({
    workspaceId: params.workspaceId,
    workspaceSessionDir: params.sessionDir,
    childTaskId: params.childTaskId,
    updater: () => ({
      childTaskId: params.childTaskId,
      parentWorkspaceId: params.workspaceId,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      status: "pending",
      projectArtifacts: params.projectArtifacts,
      readyProjectCount: 0,
      failedProjectCount: 0,
      skippedProjectCount: 0,
      totalCommitCount: 0,
    }),
  });
}

async function writeWorkspaceConfig(params: {
  muxRoot: string;
  workspaceId: string;
  workspaceName: string;
  primaryProjectPath: string;
  projects: Array<{ projectPath: string; projectName: string }>;
  parentWorkspaceId?: string;
}) {
  await fsPromises.writeFile(
    path.join(params.muxRoot, "config.json"),
    JSON.stringify(
      {
        projects: [
          [
            params.primaryProjectPath,
            {
              workspaces: [
                {
                  path: params.primaryProjectPath,
                  id: params.workspaceId,
                  name: params.workspaceName,
                  parentWorkspaceId: params.parentWorkspaceId,
                  runtimeConfig: { type: "local" },
                  projects: params.projects,
                },
              ],
            },
          ],
        ],
      },
      null,
      2
    ),
    "utf-8"
  );
}

describe("task_apply_git_patch tool", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-task-apply-git-patch-"));
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  it("applies all ready project patches in primary-first order", async () => {
    const childRepoA = path.join(rootDir, "child-a");
    const childRepoB = path.join(rootDir, "child-b");
    const targetRepoA = path.join(rootDir, "target-a");
    const targetRepoB = path.join(rootDir, "target-b");
    for (const repo of [childRepoA, childRepoB, targetRepoA, targetRepoB]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }

    await commitFile(childRepoA, "README.md", "hello a", "base a");
    await commitFile(childRepoB, "README.md", "hello b", "base b");
    await commitFile(targetRepoA, "README.md", "hello a", "base a");
    await commitFile(targetRepoB, "README.md", "hello b", "base b");

    const baseShaA = execSync("git rev-parse HEAD", { cwd: childRepoA, encoding: "utf-8" }).trim();
    const baseShaB = execSync("git rev-parse HEAD", { cwd: childRepoB, encoding: "utf-8" }).trim();

    await commitFile(childRepoA, "README.md", "hello a\nchild a", "child a change");
    await commitFile(childRepoB, "README.md", "hello b\nchild b", "child b change");
    const headShaA = execSync("git rev-parse HEAD", { cwd: childRepoA, encoding: "utf-8" }).trim();
    const headShaB = execSync("git rev-parse HEAD", { cwd: childRepoB, encoding: "utf-8" }).trim();

    const muxRoot = path.join(rootDir, "mux");
    const currentWorkspaceId = "current-workspace";
    const sessionDir = path.join(muxRoot, "sessions", currentWorkspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await writeWorkspaceConfig({
      muxRoot,
      workspaceId: currentWorkspaceId,
      workspaceName: "current",
      primaryProjectPath: targetRepoA,
      projects: [
        { projectPath: targetRepoA, projectName: "project-a" },
        { projectPath: targetRepoB, projectName: "project-b" },
      ],
    });

    const childTaskId = "child-task-1";
    await writePatchArtifact({
      sessionDir,
      workspaceId: currentWorkspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "project-a",
          projectPath: targetRepoA,
          projectName: "project-a",
          childRepo: childRepoA,
          baseSha: baseShaA,
          headSha: headShaA,
        }),
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "project-b",
          projectPath: targetRepoB,
          projectName: "project-b",
          childRepo: childRepoB,
          baseSha: baseShaB,
          headSha: headShaB,
        }),
      ],
    });

    const tool = createTaskApplyGitPatchTool({
      ...getTestDeps(),
      workspaceId: currentWorkspaceId,
      cwd: targetRepoA,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: "/tmp",
      workspaceSessionDir: sessionDir,
    });

    const result = (await tool.execute!({ task_id: childTaskId }, mockToolCallOptions)) as {
      success: boolean;
      projectResults: Array<{
        projectPath: string;
        status: string;
        appliedCommits?: Array<{ subject: string }>;
      }>;
    };

    expect(result.success).toBe(true);
    expect(result.projectResults.map((projectResult) => projectResult.projectPath)).toEqual([
      targetRepoA,
      targetRepoB,
    ]);
    expect(result.projectResults.map((projectResult) => projectResult.status)).toEqual([
      "applied",
      "applied",
    ]);
    expect(execSync("git log -1 --pretty=%s", { cwd: targetRepoA, encoding: "utf-8" }).trim()).toBe(
      "child a change"
    );
    expect(execSync("git log -1 --pretty=%s", { cwd: targetRepoB, encoding: "utf-8" }).trim()).toBe(
      "child b change"
    );

    const artifact = await readSubagentGitPatchArtifact(sessionDir, childTaskId);
    expect(artifact?.projectArtifacts.every((projectArtifact) => projectArtifact.appliedAtMs)).toBe(
      true
    );
  }, 20_000);

  it("cleans staged patch files between dry-run and real apply when temp dir is inside the repo", async () => {
    const childRepo = path.join(rootDir, "child");
    const targetRepo = path.join(rootDir, "target");
    for (const repo of [childRepo, targetRepo]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }

    await commitFile(childRepo, "README.md", "hello", "base");
    await commitFile(targetRepo, "README.md", "hello", "base");
    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await commitFile(childRepo, "README.md", "hello\nchild", "child change");
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const muxRoot = path.join(rootDir, "mux");
    const currentWorkspaceId = "current-workspace";
    const sessionDir = path.join(muxRoot, "sessions", currentWorkspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await writeWorkspaceConfig({
      muxRoot,
      workspaceId: currentWorkspaceId,
      workspaceName: "current",
      primaryProjectPath: targetRepo,
      projects: [{ projectPath: targetRepo, projectName: "project" }],
    });

    const childTaskId = "child-task-cleanup";
    await writePatchArtifact({
      sessionDir,
      workspaceId: currentWorkspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "project",
          projectPath: targetRepo,
          projectName: "project",
          childRepo,
          baseSha,
          headSha,
        }),
      ],
    });

    const tool = createTaskApplyGitPatchTool({
      ...getTestDeps(),
      workspaceId: currentWorkspaceId,
      cwd: targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: path.join(targetRepo, ".mux", "tmp"),
      workspaceSessionDir: sessionDir,
    });

    const dryRun = (await tool.execute!(
      { task_id: childTaskId, dry_run: true },
      mockToolCallOptions
    )) as { success: boolean };
    expect(dryRun.success).toBe(true);
    expect(execSync("git status --porcelain", { cwd: targetRepo, encoding: "utf-8" }).trim()).toBe(
      ""
    );

    const stalePatchPath = path.join(
      targetRepo,
      ".mux",
      "tmp",
      `mux-task-${childTaskId}-project-series.mbox`
    );
    await fsPromises.mkdir(path.dirname(stalePatchPath), { recursive: true });
    await fsPromises.writeFile(stalePatchPath, "stale patch copy", "utf-8");
    expect(execSync("git status --porcelain", { cwd: targetRepo, encoding: "utf-8" })).toContain(
      ".mux/"
    );

    const realApply = (await tool.execute!({ task_id: childTaskId }, mockToolCallOptions)) as {
      success: boolean;
      projectResults: Array<{ status: string }>;
    };

    expect(realApply.success).toBe(true);
    expect(realApply.projectResults[0]).toMatchObject({ status: "applied" });
    expect(execSync("git log -1 --pretty=%s", { cwd: targetRepo, encoding: "utf-8" }).trim()).toBe(
      "child change"
    );
    expect(execSync("git status --porcelain", { cwd: targetRepo, encoding: "utf-8" }).trim()).toBe(
      ""
    );
  }, 20_000);

  it("lets git am apply when dirty files are unrelated to the patch", async () => {
    const childRepo = path.join(rootDir, "child-unrelated-dirty");
    const targetRepo = path.join(rootDir, "target-unrelated-dirty");
    for (const repo of [childRepo, targetRepo]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }

    await commitFile(childRepo, "README.md", "hello", "base");
    await commitFile(targetRepo, "README.md", "hello", "base");
    await commitFile(targetRepo, "notes.txt", "local base", "local notes");
    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await fsPromises.writeFile(path.join(childRepo, "README.md"), "hello\nchild", "utf-8");
    execSync("git add README.md", { cwd: childRepo, stdio: "ignore" });
    execSync(
      'git -c core.hooksPath=/dev/null commit --cleanup=verbatim -m "child change" -m "rename from notes.txt"',
      {
        cwd: childRepo,
        stdio: "ignore",
      }
    );
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const sessionDir = path.join(rootDir, "session-unrelated-dirty");
    await fsPromises.mkdir(sessionDir, { recursive: true });
    const childTaskId = "child-task-unrelated-dirty";
    await writePatchArtifact({
      sessionDir,
      workspaceId: getTestDeps().workspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "target",
          projectPath: targetRepo,
          projectName: "target",
          childRepo,
          baseSha,
          headSha,
        }),
      ],
    });

    await fsPromises.writeFile(
      path.join(targetRepo, "notes.txt"),
      "local base\nworktree edit",
      "utf-8"
    );
    await fsPromises.writeFile(path.join(targetRepo, "temp.log"), "scratch", "utf-8");
    const headBeforeDryRun = execSync("git rev-parse HEAD", {
      cwd: targetRepo,
      encoding: "utf-8",
    }).trim();

    const config = {
      ...getTestDeps(),
      cwd: targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: path.join(rootDir, "runtime-tmp-unrelated-dirty"),
      workspaceSessionDir: sessionDir,
    };

    const dryRun = await applyTaskGitPatchArtifact(
      config,
      { task_id: childTaskId, dry_run: true, three_way: true },
      {}
    );
    expect(dryRun.success).toBe(true);
    expect(execSync("git rev-parse HEAD", { cwd: targetRepo, encoding: "utf-8" }).trim()).toBe(
      headBeforeDryRun
    );

    const realApply = await applyTaskGitPatchArtifact(
      config,
      { task_id: childTaskId, three_way: true },
      {}
    );

    expect(realApply.success).toBe(true);
    expect(execSync("git log -1 --pretty=%s", { cwd: targetRepo, encoding: "utf-8" }).trim()).toBe(
      "child change"
    );
    expect(await fsPromises.readFile(path.join(targetRepo, "README.md"), "utf-8")).toBe(
      "hello\nchild"
    );
    expect(await fsPromises.readFile(path.join(targetRepo, "notes.txt"), "utf-8")).toBe(
      "local base\nworktree edit"
    );
    expect(await fsPromises.readFile(path.join(targetRepo, "temp.log"), "utf-8")).toBe("scratch");
    const status = execSync("git status --porcelain", { cwd: targetRepo, encoding: "utf-8" });
    expect(status).toContain(" M notes.txt");
    expect(status).toContain("?? temp.log");
  }, 20_000);

  it("rejects staged unrelated changes before git am", async () => {
    const childRepo = path.join(rootDir, "child-staged-unrelated");
    const targetRepo = path.join(rootDir, "target-staged-unrelated");
    for (const repo of [childRepo, targetRepo]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }

    await commitFile(childRepo, "README.md", "hello", "base");
    await commitFile(targetRepo, "README.md", "hello", "base");
    await commitFile(targetRepo, "notes.txt", "local base", "local notes");
    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await commitFile(childRepo, "README.md", "hello\nchild", "child change");
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const sessionDir = path.join(rootDir, "session-staged-unrelated");
    await fsPromises.mkdir(sessionDir, { recursive: true });
    const childTaskId = "child-task-staged-unrelated";
    await writePatchArtifact({
      sessionDir,
      workspaceId: getTestDeps().workspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "target",
          projectPath: targetRepo,
          projectName: "target",
          childRepo,
          baseSha,
          headSha,
        }),
      ],
    });

    await fsPromises.writeFile(path.join(targetRepo, "notes.txt"), "local base\nstaged", "utf-8");
    execSync("git add notes.txt", { cwd: targetRepo, stdio: "ignore" });
    const headBeforeApply = execSync("git rev-parse HEAD", {
      cwd: targetRepo,
      encoding: "utf-8",
    }).trim();

    const result = await applyTaskGitPatchArtifact(
      {
        ...getTestDeps(),
        cwd: targetRepo,
        runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
        runtimeTempDir: path.join(rootDir, "runtime-tmp-staged-unrelated"),
        workspaceSessionDir: sessionDir,
      },
      { task_id: childTaskId, dry_run: true, three_way: true },
      {}
    );

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected staged change failure");
    }
    expect(result.error).toContain("staged changes");
    expect(result.conflictPaths).toEqual(["notes.txt"]);
    expect(execSync("git rev-parse HEAD", { cwd: targetRepo, encoding: "utf-8" }).trim()).toBe(
      headBeforeApply
    );
  }, 20_000);

  it("rejects intent-to-add entries before git am", async () => {
    const childRepo = path.join(rootDir, "child-intent-to-add");
    const targetRepo = path.join(rootDir, "target-intent-to-add");
    for (const repo of [childRepo, targetRepo]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }

    await commitFile(childRepo, "README.md", "hello", "base");
    await commitFile(targetRepo, "README.md", "hello", "base");
    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await commitFile(childRepo, "README.md", "hello\nchild", "child change");
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const sessionDir = path.join(rootDir, "session-intent-to-add");
    await fsPromises.mkdir(sessionDir, { recursive: true });
    const childTaskId = "child-task-intent-to-add";
    await writePatchArtifact({
      sessionDir,
      workspaceId: getTestDeps().workspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "target",
          projectPath: targetRepo,
          projectName: "target",
          childRepo,
          baseSha,
          headSha,
        }),
      ],
    });

    await fsPromises.writeFile(path.join(targetRepo, "notes.txt"), "intent", "utf-8");
    execSync("git add -N notes.txt", { cwd: targetRepo, stdio: "ignore" });

    const result = await applyTaskGitPatchArtifact(
      {
        ...getTestDeps(),
        cwd: targetRepo,
        runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
        runtimeTempDir: path.join(rootDir, "runtime-tmp-intent-to-add"),
        workspaceSessionDir: sessionDir,
      },
      { task_id: childTaskId, dry_run: true, three_way: true },
      {}
    );

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected intent-to-add failure");
    }
    expect(result.error).toContain("staged changes");
    expect(result.conflictPaths).toEqual(["notes.txt"]);
  }, 20_000);

  it("rejects overlapping dirty paths before a multi-commit patch can partially apply", async () => {
    const childRepo = path.join(rootDir, "child-overlapping-dirty");
    const targetRepo = path.join(rootDir, "target-overlapping-dirty");
    for (const repo of [childRepo, targetRepo]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
      await fsPromises.writeFile(path.join(repo, "README.md"), "hello", "utf-8");
      await fsPromises.writeFile(path.join(repo, "f.txt"), "base", "utf-8");
      execSync("git add README.md f.txt", { cwd: repo, stdio: "ignore" });
      execSync('git commit -m "base"', { cwd: repo, stdio: "ignore" });
    }

    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await commitFile(childRepo, "README.md", "hello\nchild", "child readme change");
    await commitFile(childRepo, "f.txt", "base\nchild", "child f change");
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const sessionDir = path.join(rootDir, "session-overlapping-dirty");
    await fsPromises.mkdir(sessionDir, { recursive: true });
    const childTaskId = "child-task-overlapping-dirty";
    await writePatchArtifact({
      sessionDir,
      workspaceId: getTestDeps().workspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "target",
          projectPath: targetRepo,
          projectName: "target",
          childRepo,
          baseSha,
          headSha,
        }),
      ],
    });

    await fsPromises.writeFile(path.join(targetRepo, "f.txt"), "base\nlocal", "utf-8");
    const headBeforeApply = execSync("git rev-parse HEAD", {
      cwd: targetRepo,
      encoding: "utf-8",
    }).trim();

    const config = {
      ...getTestDeps(),
      cwd: targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: path.join(rootDir, "runtime-tmp-overlapping-dirty"),
      workspaceSessionDir: sessionDir,
    };

    const dryRun = await applyTaskGitPatchArtifact(
      config,
      { task_id: childTaskId, dry_run: true, three_way: true },
      {}
    );
    expect(dryRun.success).toBe(false);
    if (dryRun.success) {
      throw new Error("expected overlapping dirty path dry-run failure");
    }
    expect(dryRun.error).toContain("overlap patch paths");
    expect(dryRun.conflictPaths).toEqual(["f.txt"]);
    expect(execSync("git rev-parse HEAD", { cwd: targetRepo, encoding: "utf-8" }).trim()).toBe(
      headBeforeApply
    );

    const result = await applyTaskGitPatchArtifact(
      config,
      { task_id: childTaskId, three_way: true },
      {}
    );

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected overlapping dirty path failure");
    }
    expect(result.error).toContain("overlap patch paths");
    expect(result.conflictPaths).toEqual(["f.txt"]);
    expect(execSync("git rev-parse HEAD", { cwd: targetRepo, encoding: "utf-8" }).trim()).toBe(
      headBeforeApply
    );
    expect(await fsPromises.readFile(path.join(targetRepo, "README.md"), "utf-8")).toBe("hello");
    expect(await fsPromises.readFile(path.join(targetRepo, "f.txt"), "utf-8")).toBe("base\nlocal");
  }, 20_000);

  it("treats dirty rename sources as overlapping patch paths", async () => {
    const childRepo = path.join(rootDir, "child-rename-source-dirty");
    const targetRepo = path.join(rootDir, "target-rename-source-dirty");
    for (const repo of [childRepo, targetRepo]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
      await fsPromises.writeFile(path.join(repo, "README.md"), "hello", "utf-8");
      await fsPromises.mkdir(path.join(repo, "é b"), { recursive: true });
      await fsPromises.writeFile(path.join(repo, "é b", "old.txt"), "base", "utf-8");
      execSync("git add README.md 'é b/old.txt'", { cwd: repo, stdio: "ignore" });
      execSync('git commit -m "base"', { cwd: repo, stdio: "ignore" });
    }

    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await commitFile(childRepo, "README.md", "hello\nchild", "child readme change");
    execSync("git mv 'é b/old.txt' 'é b/new.txt'", { cwd: childRepo, stdio: "ignore" });
    execSync('git commit -m "rename old"', { cwd: childRepo, stdio: "ignore" });
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const sessionDir = path.join(rootDir, "session-rename-source-dirty");
    await fsPromises.mkdir(sessionDir, { recursive: true });
    const childTaskId = "child-task-rename-source-dirty";
    await writePatchArtifact({
      sessionDir,
      workspaceId: getTestDeps().workspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "target",
          projectPath: targetRepo,
          projectName: "target",
          childRepo,
          baseSha,
          headSha,
        }),
      ],
    });

    await fsPromises.writeFile(path.join(targetRepo, "é b", "old.txt"), "base\nlocal", "utf-8");
    const headBeforeApply = execSync("git rev-parse HEAD", {
      cwd: targetRepo,
      encoding: "utf-8",
    }).trim();

    const result = await applyTaskGitPatchArtifact(
      {
        ...getTestDeps(),
        cwd: targetRepo,
        runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
        runtimeTempDir: path.join(rootDir, "runtime-tmp-rename-source-dirty"),
        workspaceSessionDir: sessionDir,
      },
      { task_id: childTaskId, dry_run: true, three_way: true },
      {}
    );

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected rename source overlap failure");
    }
    expect(result.conflictPaths).toEqual(["é b/old.txt"]);
    expect(execSync("git rev-parse HEAD", { cwd: targetRepo, encoding: "utf-8" }).trim()).toBe(
      headBeforeApply
    );
  }, 20_000);

  it("treats dirty ancestor paths as overlapping patch paths", async () => {
    const childRepo = path.join(rootDir, "child-ancestor-dirty");
    const targetRepo = path.join(rootDir, "target-ancestor-dirty");
    for (const repo of [childRepo, targetRepo]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
      await commitFile(repo, "README.md", "hello", "base");
    }

    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await commitFile(childRepo, "README.md", "hello\nchild", "child readme change");
    await fsPromises.mkdir(path.join(childRepo, "dir"), { recursive: true });
    await fsPromises.writeFile(path.join(childRepo, "dir", "file.txt"), "child", "utf-8");
    execSync("git add dir/file.txt", { cwd: childRepo, stdio: "ignore" });
    execSync('git commit -m "add nested file"', { cwd: childRepo, stdio: "ignore" });
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const sessionDir = path.join(rootDir, "session-ancestor-dirty");
    await fsPromises.mkdir(sessionDir, { recursive: true });
    const childTaskId = "child-task-ancestor-dirty";
    await writePatchArtifact({
      sessionDir,
      workspaceId: getTestDeps().workspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "target",
          projectPath: targetRepo,
          projectName: "target",
          childRepo,
          baseSha,
          headSha,
        }),
      ],
    });

    await fsPromises.writeFile(
      path.join(targetRepo, "dir"),
      "local file blocks directory",
      "utf-8"
    );
    const headBeforeApply = execSync("git rev-parse HEAD", {
      cwd: targetRepo,
      encoding: "utf-8",
    }).trim();

    const result = await applyTaskGitPatchArtifact(
      {
        ...getTestDeps(),
        cwd: targetRepo,
        runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
        runtimeTempDir: path.join(rootDir, "runtime-tmp-ancestor-dirty"),
        workspaceSessionDir: sessionDir,
      },
      { task_id: childTaskId, dry_run: true, three_way: true },
      {}
    );

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected ancestor path overlap failure");
    }
    expect(result.conflictPaths).toEqual(["dir"]);
    expect(execSync("git rev-parse HEAD", { cwd: targetRepo, encoding: "utf-8" }).trim()).toBe(
      headBeforeApply
    );
  }, 20_000);

  it("treats dirty deleted copy sources as overlapping patch paths", async () => {
    const childRepo = path.join(rootDir, "child-copy-source-dirty");
    const targetRepo = path.join(rootDir, "target-copy-source-dirty");
    for (const repo of [childRepo, targetRepo]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
      await commitFile(repo, "src.txt", "source", "base");
    }

    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await fsPromises.copyFile(path.join(childRepo, "src.txt"), path.join(childRepo, "dst.txt"));
    execSync("git add dst.txt", { cwd: childRepo, stdio: "ignore" });
    execSync('git commit -m "copy source"', { cwd: childRepo, stdio: "ignore" });
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const sessionDir = path.join(rootDir, "session-copy-source-dirty");
    await fsPromises.mkdir(sessionDir, { recursive: true });
    const childTaskId = "child-task-copy-source-dirty";
    await writePatchArtifact({
      sessionDir,
      workspaceId: getTestDeps().workspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "target",
          projectPath: targetRepo,
          projectName: "target",
          childRepo,
          baseSha,
          headSha,
          formatPatchArgs: "-C --find-copies-harder",
        }),
      ],
    });

    const config = {
      ...getTestDeps(),
      cwd: targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: path.join(rootDir, "runtime-tmp-copy-source-dirty"),
      workspaceSessionDir: sessionDir,
    };

    await fsPromises.rm(path.join(targetRepo, "src.txt"));

    const result = await applyTaskGitPatchArtifact(
      config,
      { task_id: childTaskId, dry_run: true, three_way: true },
      {}
    );

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected dirty copy source failure");
    }
    expect(result.conflictPaths).toEqual(["src.txt"]);

    execSync("git checkout -- src.txt", { cwd: targetRepo, stdio: "ignore" });
    await fsPromises.writeFile(path.join(targetRepo, "src.txt"), "source\nlocal", "utf-8");
    const withoutThreeWay = await applyTaskGitPatchArtifact(
      config,
      { task_id: childTaskId, dry_run: true, three_way: false },
      {}
    );
    expect(withoutThreeWay.success).toBe(false);
    if (withoutThreeWay.success) {
      throw new Error("expected dirty copy source failure without three-way");
    }
    expect(withoutThreeWay.conflictPaths).toEqual(["src.txt"]);
  }, 20_000);

  it("cleans repo-local patch files when the runtime copy fails", async () => {
    const childRepo = path.join(rootDir, "child-copy-fails");
    const targetRepo = path.join(rootDir, "target-copy-fails");
    for (const repo of [childRepo, targetRepo]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }

    await commitFile(childRepo, "README.md", "hello", "base");
    await commitFile(targetRepo, "README.md", "hello", "base");
    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await commitFile(childRepo, "README.md", "hello\nchild", "child change");
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const muxRoot = path.join(rootDir, "mux-copy-fails");
    const currentWorkspaceId = "current-workspace-copy-fails";
    const sessionDir = path.join(muxRoot, "sessions", currentWorkspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await writeWorkspaceConfig({
      muxRoot,
      workspaceId: currentWorkspaceId,
      workspaceName: "current",
      primaryProjectPath: targetRepo,
      projects: [{ projectPath: targetRepo, projectName: "project" }],
    });

    const childTaskId = "child-task-copy-fails";
    await writePatchArtifact({
      sessionDir,
      workspaceId: currentWorkspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "project",
          projectPath: targetRepo,
          projectName: "project",
          childRepo,
          baseSha,
          headSha,
        }),
      ],
    });

    const runtimeTempDir = path.join(targetRepo, ".mux", "tmp");
    const leakedPatchPath = path.join(
      runtimeTempDir,
      `mux-task-${childTaskId}-project-series.mbox`
    );
    const baseRuntime = createRuntime({ type: "local", srcBaseDir: "/tmp" });
    const failingRuntime = Object.create(baseRuntime) as typeof baseRuntime;
    failingRuntime.writeFile = (remotePath: string) =>
      new WritableStream<Uint8Array>({
        async write(chunk) {
          await fsPromises.mkdir(path.dirname(remotePath), { recursive: true });
          await fsPromises.writeFile(remotePath, chunk);
          throw new Error("simulated copy failure");
        },
      });
    const tool = createTaskApplyGitPatchTool({
      ...getTestDeps(),
      workspaceId: currentWorkspaceId,
      cwd: targetRepo,
      runtime: failingRuntime,
      runtimeTempDir,
      workspaceSessionDir: sessionDir,
    });

    let copyFailure: unknown;
    try {
      await tool.execute!({ task_id: childTaskId }, mockToolCallOptions);
    } catch (error) {
      copyFailure = error;
    }
    expect(copyFailure).toBeInstanceOf(Error);
    expect(copyFailure instanceof Error ? copyFailure.message : "").toContain(
      "simulated copy failure"
    );
    const leakedPatchExists = await fsPromises.stat(leakedPatchPath).then(
      () => true,
      () => false
    );
    expect(leakedPatchExists).toBe(false);
    expect(execSync("git status --porcelain", { cwd: targetRepo, encoding: "utf-8" }).trim()).toBe(
      ""
    );
  }, 20_000);

  it("does not derive runtime paths from unsafe task IDs", async () => {
    const targetRepo = path.join(rootDir, "target-unsafe-task-id");
    await fsPromises.mkdir(targetRepo, { recursive: true });
    initGitRepo(targetRepo);
    await commitFile(targetRepo, "README.md", "hello", "base");

    const muxRoot = path.join(rootDir, "mux-unsafe-task-id");
    const currentWorkspaceId = "current-workspace-unsafe-task-id";
    const sessionDir = path.join(muxRoot, "sessions", currentWorkspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await writeWorkspaceConfig({
      muxRoot,
      workspaceId: currentWorkspaceId,
      workspaceName: "current",
      primaryProjectPath: targetRepo,
      projects: [{ projectPath: targetRepo, projectName: "project" }],
    });

    const runtimeTempDir = path.join(rootDir, "runtime-unsafe-task-id", "tmp");
    const escapedPath = path.join(rootDir, "runtime-unsafe-task-id", "victim-project-series.mbox");
    await fsPromises.mkdir(path.dirname(escapedPath), { recursive: true });
    await fsPromises.writeFile(escapedPath, "do not delete", "utf-8");
    const tool = createTaskApplyGitPatchTool({
      ...getTestDeps(),
      workspaceId: currentWorkspaceId,
      cwd: targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir,
      workspaceSessionDir: sessionDir,
    });

    const result = (await tool.execute!(
      { task_id: "child/../../victim" },
      mockToolCallOptions
    )) as { success: boolean; error?: string; note?: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe("Invalid task_id.");
    expect(await fsPromises.readFile(escapedPath, "utf-8")).toBe("do not delete");
  }, 20_000);

  it("skips corrupt artifact storage keys before runtime cleanup", async () => {
    const targetRepo = path.join(rootDir, "target-unsafe-storage-key");
    await fsPromises.mkdir(targetRepo, { recursive: true });
    initGitRepo(targetRepo);
    await commitFile(targetRepo, "README.md", "hello", "base");

    const muxRoot = path.join(rootDir, "mux-unsafe-storage-key");
    const currentWorkspaceId = "current-workspace-unsafe-storage-key";
    const sessionDir = path.join(muxRoot, "sessions", currentWorkspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await writeWorkspaceConfig({
      muxRoot,
      workspaceId: currentWorkspaceId,
      workspaceName: "current",
      primaryProjectPath: targetRepo,
      projects: [{ projectPath: targetRepo, projectName: "project" }],
    });

    const childTaskId = "child-task-unsafe-storage-key";
    await fsPromises.writeFile(
      getSubagentGitPatchArtifactsFilePath(sessionDir),
      JSON.stringify({
        version: 2,
        artifactsByChildTaskId: {
          [childTaskId]: {
            childTaskId,
            parentWorkspaceId: currentWorkspaceId,
            createdAtMs: Date.now(),
            updatedAtMs: Date.now(),
            status: "ready",
            readyProjectCount: 1,
            failedProjectCount: 0,
            skippedProjectCount: 0,
            totalCommitCount: 1,
            projectArtifacts: [
              {
                projectPath: targetRepo,
                projectName: "project",
                storageKey: "a/../../victim",
                status: "ready",
                baseCommitSha: "base",
                headCommitSha: "head",
                commitCount: 1,
                mboxPath: path.join(sessionDir, "missing.mbox"),
              },
            ],
          },
        },
      }),
      "utf-8"
    );
    const runtimeTempDir = path.join(rootDir, "runtime-unsafe-storage-key", "tmp");
    const escapedPath = path.join(rootDir, "runtime-unsafe-storage-key", "victim-series.mbox");
    await fsPromises.mkdir(path.dirname(escapedPath), { recursive: true });
    await fsPromises.writeFile(escapedPath, "do not delete", "utf-8");
    const tool = createTaskApplyGitPatchTool({
      ...getTestDeps(),
      workspaceId: currentWorkspaceId,
      cwd: targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir,
      workspaceSessionDir: sessionDir,
    });

    const result = (await tool.execute!({ task_id: childTaskId }, mockToolCallOptions)) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toBe("No git patch artifact found for this taskId.");
    expect(await fsPromises.readFile(escapedPath, "utf-8")).toBe("do not delete");
  }, 20_000);

  it("refuses to apply when expected_head_sha does not match", async () => {
    const childRepo = path.join(rootDir, "child-expected-head");
    const targetRepo = path.join(rootDir, "target-expected-head");
    for (const repo of [childRepo, targetRepo]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }

    await commitFile(childRepo, "README.md", "hello", "base");
    await commitFile(targetRepo, "README.md", "hello", "base");
    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await commitFile(childRepo, "README.md", "hello\nchild", "child change");
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const muxRoot = path.join(rootDir, "mux-expected-head");
    const currentWorkspaceId = "current-workspace-expected-head";
    const sessionDir = path.join(muxRoot, "sessions", currentWorkspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await writeWorkspaceConfig({
      muxRoot,
      workspaceId: currentWorkspaceId,
      workspaceName: "current",
      primaryProjectPath: targetRepo,
      projects: [{ projectPath: targetRepo, projectName: "project" }],
    });

    const childTaskId = "child-task-expected-head";
    await writePatchArtifact({
      sessionDir,
      workspaceId: currentWorkspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "project",
          projectPath: targetRepo,
          projectName: "project",
          childRepo,
          baseSha,
          headSha,
        }),
      ],
    });
    const targetHeadBefore = execSync("git rev-parse HEAD", {
      cwd: targetRepo,
      encoding: "utf-8",
    }).trim();
    const tool = createTaskApplyGitPatchTool({
      ...getTestDeps(),
      workspaceId: currentWorkspaceId,
      cwd: targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: path.join(rootDir, "runtime-expected-head"),
      workspaceSessionDir: sessionDir,
    });

    const result = (await tool.execute!(
      { task_id: childTaskId, expected_head_sha: headSha },
      mockToolCallOptions
    )) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("does not match expected HEAD");
    expect(execSync("git rev-parse HEAD", { cwd: targetRepo, encoding: "utf-8" }).trim()).toBe(
      targetHeadBefore
    );
  }, 20_000);

  it("applies only the requested project_path", async () => {
    const childRepoA = path.join(rootDir, "child-a");
    const childRepoB = path.join(rootDir, "child-b");
    const targetRepoA = path.join(rootDir, "target-a");
    const targetRepoB = path.join(rootDir, "target-b");
    for (const repo of [childRepoA, childRepoB, targetRepoA, targetRepoB]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }

    await commitFile(childRepoA, "README.md", "hello a", "base a");
    await commitFile(childRepoB, "README.md", "hello b", "base b");
    await commitFile(targetRepoA, "README.md", "hello a", "base a");
    await commitFile(targetRepoB, "README.md", "hello b", "base b");

    const baseShaA = execSync("git rev-parse HEAD", { cwd: childRepoA, encoding: "utf-8" }).trim();
    const baseShaB = execSync("git rev-parse HEAD", { cwd: childRepoB, encoding: "utf-8" }).trim();
    await commitFile(childRepoA, "README.md", "hello a\nchild a", "child a change");
    await commitFile(childRepoB, "README.md", "hello b\nchild b", "child b change");
    const headShaA = execSync("git rev-parse HEAD", { cwd: childRepoA, encoding: "utf-8" }).trim();
    const headShaB = execSync("git rev-parse HEAD", { cwd: childRepoB, encoding: "utf-8" }).trim();

    const muxRoot = path.join(rootDir, "mux");
    const currentWorkspaceId = "current-workspace";
    const sessionDir = path.join(muxRoot, "sessions", currentWorkspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await writeWorkspaceConfig({
      muxRoot,
      workspaceId: currentWorkspaceId,
      workspaceName: "current",
      primaryProjectPath: targetRepoA,
      projects: [
        { projectPath: targetRepoA, projectName: "project-a" },
        { projectPath: targetRepoB, projectName: "project-b" },
      ],
    });

    const childTaskId = "child-task-1";
    await writePatchArtifact({
      sessionDir,
      workspaceId: currentWorkspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "project-a",
          projectPath: targetRepoA,
          projectName: "project-a",
          childRepo: childRepoA,
          baseSha: baseShaA,
          headSha: headShaA,
        }),
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "project-b",
          projectPath: targetRepoB,
          projectName: "project-b",
          childRepo: childRepoB,
          baseSha: baseShaB,
          headSha: headShaB,
        }),
      ],
    });

    const tool = createTaskApplyGitPatchTool({
      ...getTestDeps(),
      workspaceId: currentWorkspaceId,
      cwd: targetRepoA,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: "/tmp",
      workspaceSessionDir: sessionDir,
    });

    const result = (await tool.execute!(
      { task_id: childTaskId, project_path: targetRepoB },
      mockToolCallOptions
    )) as {
      success: boolean;
      projectResults: Array<{ projectPath: string; status: string }>;
      appliedCommits?: Array<{ subject: string }>;
    };

    expect(result.success).toBe(true);
    expect(result.projectResults).toHaveLength(1);
    expect(result.projectResults[0]).toMatchObject({ projectPath: targetRepoB, status: "applied" });
    expect(result.appliedCommits?.map((commit) => commit.subject)).toEqual(["child b change"]);
    expect(execSync("git log -1 --pretty=%s", { cwd: targetRepoA, encoding: "utf-8" }).trim()).toBe(
      "base a"
    );
    expect(execSync("git log -1 --pretty=%s", { cwd: targetRepoB, encoding: "utf-8" }).trim()).toBe(
      "child b change"
    );
  }, 20_000);

  it("stops on the first failing repo and only marks earlier project artifacts applied", async () => {
    const childRepoA = path.join(rootDir, "child-a");
    const childRepoB = path.join(rootDir, "child-b");
    const targetRepoA = path.join(rootDir, "target-a");
    const targetRepoB = path.join(rootDir, "target-b");
    for (const repo of [childRepoA, childRepoB, targetRepoA, targetRepoB]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }

    await commitFile(childRepoA, "README.md", "hello a", "base a");
    await commitFile(childRepoB, "README.md", "hello b", "base b");
    await commitFile(targetRepoA, "README.md", "hello a", "base a");
    await commitFile(targetRepoB, "README.md", "hello b", "base b");

    const baseShaA = execSync("git rev-parse HEAD", { cwd: childRepoA, encoding: "utf-8" }).trim();
    const baseShaB = execSync("git rev-parse HEAD", { cwd: childRepoB, encoding: "utf-8" }).trim();
    await commitFile(childRepoA, "README.md", "hello a\nchild a", "child a change");
    await commitFile(childRepoB, "README.md", "hello b\nchild b", "child b change");
    const headShaA = execSync("git rev-parse HEAD", { cwd: childRepoA, encoding: "utf-8" }).trim();
    const headShaB = execSync("git rev-parse HEAD", { cwd: childRepoB, encoding: "utf-8" }).trim();

    await commitFile(targetRepoB, "README.md", "hello b\nconflict", "target b change");

    const muxRoot = path.join(rootDir, "mux");
    const currentWorkspaceId = "current-workspace";
    const sessionDir = path.join(muxRoot, "sessions", currentWorkspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await writeWorkspaceConfig({
      muxRoot,
      workspaceId: currentWorkspaceId,
      workspaceName: "current",
      primaryProjectPath: targetRepoA,
      projects: [
        { projectPath: targetRepoA, projectName: "project-a" },
        { projectPath: targetRepoB, projectName: "project-b" },
      ],
    });

    const childTaskId = "child-task-1";
    await writePatchArtifact({
      sessionDir,
      workspaceId: currentWorkspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "project-a",
          projectPath: targetRepoA,
          projectName: "project-a",
          childRepo: childRepoA,
          baseSha: baseShaA,
          headSha: headShaA,
        }),
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "project-b",
          projectPath: targetRepoB,
          projectName: "project-b",
          childRepo: childRepoB,
          baseSha: baseShaB,
          headSha: headShaB,
        }),
      ],
    });

    const tool = createTaskApplyGitPatchTool({
      ...getTestDeps(),
      workspaceId: currentWorkspaceId,
      cwd: targetRepoA,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: "/tmp",
      workspaceSessionDir: sessionDir,
    });

    const result = (await tool.execute!({ task_id: childTaskId }, mockToolCallOptions)) as {
      success: boolean;
      projectResults: Array<{ projectPath: string; status: string; conflictPaths?: string[] }>;
    };

    expect(result.success).toBe(false);
    expect(result.projectResults[0]).toMatchObject({ projectPath: targetRepoA, status: "applied" });
    expect(result.projectResults[1]).toMatchObject({ projectPath: targetRepoB, status: "failed" });
    expect(result.projectResults[1]?.conflictPaths ?? []).toContain("README.md");
    expect(execSync("git log -1 --pretty=%s", { cwd: targetRepoA, encoding: "utf-8" }).trim()).toBe(
      "child a change"
    );
    expect(execSync("git log -1 --pretty=%s", { cwd: targetRepoB, encoding: "utf-8" }).trim()).toBe(
      "target b change"
    );

    const artifact = await readSubagentGitPatchArtifact(sessionDir, childTaskId);
    expect(
      artifact?.projectArtifacts.find(
        (projectArtifact) => projectArtifact.projectPath === targetRepoA
      )?.appliedAtMs
    ).toBeGreaterThan(0);
    expect(
      artifact?.projectArtifacts.find(
        (projectArtifact) => projectArtifact.projectPath === targetRepoB
      )?.appliedAtMs
    ).toBeUndefined();
  }, 20_000);

  it("rejects mismatched project_path filters for legacy single-project artifacts", async () => {
    const targetRepo = path.join(rootDir, "target");
    await fsPromises.mkdir(targetRepo, { recursive: true });

    const childTaskId = "child-task-legacy-filter";
    const muxRoot = path.join(rootDir, "mux");
    const workspaceId = "workspace-legacy-filter";
    const sessionDir = path.join(muxRoot, "sessions", workspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });

    await writeWorkspaceConfig({
      muxRoot,
      workspaceId,
      workspaceName: "target",
      primaryProjectPath: targetRepo,
      projects: [{ projectPath: targetRepo, projectName: "target" }],
    });

    await fsPromises.writeFile(
      getSubagentGitPatchArtifactsFilePath(sessionDir),
      JSON.stringify(
        {
          version: 1,
          artifactsByChildTaskId: {
            [childTaskId]: {
              childTaskId,
              parentWorkspaceId: workspaceId,
              createdAtMs: Date.now(),
              status: "ready",
              commitCount: 1,
              mboxPath: "/tmp/legacy-series.mbox",
            },
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    const tool = createTaskApplyGitPatchTool({
      ...getTestDeps(),
      workspaceId,
      cwd: targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: "/tmp",
      workspaceSessionDir: sessionDir,
    });

    const mismatchedProjectPath = path.join(rootDir, "other-project");
    const result = (await tool.execute!(
      { task_id: childTaskId, project_path: mismatchedProjectPath },
      mockToolCallOptions
    )) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toBe(`No project patch artifact found for ${mismatchedProjectPath}.`);
  });

  it("preserves legacy single-project result fields when one project result is returned", async () => {
    const childRepo = path.join(rootDir, "child");
    const targetRepo = path.join(rootDir, "target");
    const sessionDir = path.join(rootDir, "session");
    for (const repo of [childRepo, targetRepo, sessionDir]) {
      await fsPromises.mkdir(repo, { recursive: true });
    }
    initGitRepo(childRepo);
    initGitRepo(targetRepo);

    await commitFile(childRepo, "README.md", "hello", "base");
    await commitFile(targetRepo, "README.md", "hello", "base");
    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await commitFile(childRepo, "README.md", "hello\nworld", "child change");
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const childTaskId = "child-task-1";
    const workspaceId = getTestDeps().workspaceId;
    await writePatchArtifact({
      sessionDir,
      workspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "target",
          projectPath: targetRepo,
          projectName: "target",
          childRepo,
          baseSha,
          headSha,
        }),
      ],
    });

    const tool = createTaskApplyGitPatchTool({
      ...getTestDeps(),
      cwd: targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: "/tmp",
      workspaceSessionDir: sessionDir,
    });

    const result = (await tool.execute!({ task_id: childTaskId }, mockToolCallOptions)) as {
      success: boolean;
      projectResults: Array<{ projectPath: string; status: string }>;
      appliedCommits?: Array<{ subject: string }>;
      headCommitSha?: string;
    };

    expect(result.success).toBe(true);
    expect(result.projectResults).toHaveLength(1);
    expect(result.appliedCommits?.map((commit) => commit.subject)).toEqual(["child change"]);
    expect(typeof result.headCommitSha).toBe("string");
  }, 20_000);

  it("waits for pending patch generation to become ready before applying", async () => {
    const childRepo = path.join(rootDir, "child");
    const targetRepo = path.join(rootDir, "target");
    const sessionDir = path.join(rootDir, "session");
    for (const repo of [childRepo, targetRepo, sessionDir]) {
      await fsPromises.mkdir(repo, { recursive: true });
    }
    initGitRepo(childRepo);
    initGitRepo(targetRepo);

    await commitFile(childRepo, "README.md", "hello", "base");
    await commitFile(targetRepo, "README.md", "hello", "base");
    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await commitFile(childRepo, "README.md", "hello\nworld", "child change");
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const childTaskId = "child-task-1";
    const workspaceId = getTestDeps().workspaceId;
    // The task has reported but background `git format-patch` has not finished.
    await writePatchArtifact({
      sessionDir,
      workspaceId,
      childTaskId,
      projectArtifacts: [
        {
          projectPath: targetRepo,
          projectName: "target",
          storageKey: "target",
          status: "pending",
        },
      ],
    });

    const readyProjectArtifact = await buildReadyProjectArtifact({
      sessionDir,
      childTaskId,
      storageKey: "target",
      projectPath: targetRepo,
      projectName: "target",
      childRepo,
      baseSha,
      headSha,
    });

    // Flip the artifact to ready only once the wait loop is observably polling,
    // so the test deterministically exercises the wait path (never vacuous).
    const markReadyCalls: Array<Promise<void>> = [];
    const result = await applyTaskGitPatchArtifact(
      {
        ...getTestDeps(),
        cwd: targetRepo,
        runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
        runtimeTempDir: "/tmp",
        workspaceSessionDir: sessionDir,
      },
      { task_id: childTaskId, three_way: true },
      {
        pendingGenerationWaitMs: 10_000,
        pendingGenerationPollIntervalMs: 25,
        pendingGenerationOnPoll: () => {
          if (markReadyCalls.length === 0) {
            markReadyCalls.push(
              writePatchArtifact({
                sessionDir,
                workspaceId,
                childTaskId,
                projectArtifacts: [readyProjectArtifact],
              })
            );
          }
        },
      }
    );
    expect(markReadyCalls.length).toBeGreaterThan(0);
    await Promise.all(markReadyCalls);

    expect(result.success).toBe(true);
    expect(result.projectResults?.map((projectResult) => projectResult.status)).toEqual([
      "applied",
    ]);
  }, 20_000);

  it("aborts the pending-generation wait promptly without applying", async () => {
    const targetRepo = path.join(rootDir, "target");
    const sessionDir = path.join(rootDir, "session");
    for (const repo of [targetRepo, sessionDir]) {
      await fsPromises.mkdir(repo, { recursive: true });
    }
    initGitRepo(targetRepo);
    await commitFile(targetRepo, "README.md", "hello", "base");
    const headBefore = execSync("git rev-parse HEAD", {
      cwd: targetRepo,
      encoding: "utf-8",
    }).trim();

    const childTaskId = "child-task-1";
    await writePatchArtifact({
      sessionDir,
      workspaceId: getTestDeps().workspaceId,
      childTaskId,
      projectArtifacts: [
        {
          projectPath: targetRepo,
          projectName: "target",
          storageKey: "target",
          status: "pending",
        },
      ],
    });

    const controller = new AbortController();
    const startedAtMs = Date.now();
    const result = await applyTaskGitPatchArtifact(
      {
        ...getTestDeps(),
        cwd: targetRepo,
        runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
        runtimeTempDir: "/tmp",
        workspaceSessionDir: sessionDir,
      },
      { task_id: childTaskId, three_way: true },
      {
        abortSignal: controller.signal,
        pendingGenerationWaitMs: 10_000,
        pendingGenerationPollIntervalMs: 25,
        pendingGenerationOnPoll: () => controller.abort(),
      }
    );

    // The wait must exit on abort instead of sleeping out the 10s budget.
    expect(Date.now() - startedAtMs).toBeLessThan(5_000);
    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected failure result");
    }
    expect(result.error).toContain("Aborted");
    expect(result.conflictPaths).toBeUndefined();
    // No apply may run after cancellation.
    const headAfter = execSync("git rev-parse HEAD", { cwd: targetRepo, encoding: "utf-8" }).trim();
    expect(headAfter).toBe(headBefore);
  }, 20_000);

  it("fails atomically when a sibling project is still pending after the wait times out", async () => {
    const childRepo = path.join(rootDir, "child");
    const targetRepoA = path.join(rootDir, "target-a");
    const targetRepoB = path.join(rootDir, "target-b");
    const sessionDir = path.join(rootDir, "session");
    for (const repo of [childRepo, targetRepoA, targetRepoB, sessionDir]) {
      await fsPromises.mkdir(repo, { recursive: true });
    }
    initGitRepo(childRepo);
    initGitRepo(targetRepoA);
    initGitRepo(targetRepoB);

    await commitFile(childRepo, "README.md", "hello", "base");
    await commitFile(targetRepoA, "README.md", "hello", "base");
    await commitFile(targetRepoB, "README.md", "hello", "base");
    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await commitFile(childRepo, "README.md", "hello\nworld", "child change");
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    const headBeforeA = execSync("git rev-parse HEAD", {
      cwd: targetRepoA,
      encoding: "utf-8",
    }).trim();

    const childTaskId = "child-task-1";
    await writePatchArtifact({
      sessionDir,
      workspaceId: getTestDeps().workspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "target-a",
          projectPath: targetRepoA,
          projectName: "target-a",
          childRepo,
          baseSha,
          headSha,
        }),
        {
          projectPath: targetRepoB,
          projectName: "target-b",
          storageKey: "target-b",
          status: "pending",
        },
      ],
    });

    const result = await applyTaskGitPatchArtifact(
      {
        ...getTestDeps(),
        cwd: targetRepoA,
        runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
        runtimeTempDir: "/tmp",
        workspaceSessionDir: sessionDir,
      },
      { task_id: childTaskId, three_way: true },
      { pendingGenerationWaitMs: 50, pendingGenerationPollIntervalMs: 10 }
    );

    // The ready sibling must not be partially applied while the pending
    // project's commits would silently drop (and workflows would checkpoint
    // the step as applied).
    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected failure result");
    }
    expect(result.error).toContain("not an apply conflict");
    expect(result.conflictPaths).toBeUndefined();
    expect(result.projectResults?.map((projectResult) => projectResult.status)).toEqual([
      "skipped",
      "skipped",
    ]);
    const headAfterA = execSync("git rev-parse HEAD", {
      cwd: targetRepoA,
      encoding: "utf-8",
    }).trim();
    expect(headAfterA).toBe(headBeforeA);
  }, 20_000);

  it("does not wait on a pending sibling project when project_path targets a ready project", async () => {
    const childRepo = path.join(rootDir, "child");
    const targetRepoA = path.join(rootDir, "target-a");
    const targetRepoB = path.join(rootDir, "target-b");
    for (const repo of [childRepo, targetRepoA, targetRepoB]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }

    await commitFile(childRepo, "README.md", "hello", "base");
    await commitFile(targetRepoA, "README.md", "hello", "base");
    await commitFile(targetRepoB, "README.md", "hello", "base");
    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await commitFile(childRepo, "README.md", "hello\nworld", "child change");
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const muxRoot = path.join(rootDir, "mux");
    const currentWorkspaceId = "current-workspace";
    const sessionDir = path.join(muxRoot, "sessions", currentWorkspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await writeWorkspaceConfig({
      muxRoot,
      workspaceId: currentWorkspaceId,
      workspaceName: "current",
      primaryProjectPath: targetRepoA,
      projects: [
        { projectPath: targetRepoA, projectName: "target-a" },
        { projectPath: targetRepoB, projectName: "target-b" },
      ],
    });

    const childTaskId = "child-task-1";
    await writePatchArtifact({
      sessionDir,
      workspaceId: currentWorkspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "target-a",
          projectPath: targetRepoA,
          projectName: "target-a",
          childRepo,
          baseSha,
          headSha,
        }),
        {
          projectPath: targetRepoB,
          projectName: "target-b",
          storageKey: "target-b",
          status: "pending",
        },
      ],
    });

    const startedAtMs = Date.now();
    const result = await applyTaskGitPatchArtifact(
      {
        ...getTestDeps(),
        workspaceId: currentWorkspaceId,
        cwd: targetRepoA,
        runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
        runtimeTempDir: "/tmp",
        workspaceSessionDir: sessionDir,
      },
      { task_id: childTaskId, project_path: targetRepoA, three_way: true },
      { pendingGenerationWaitMs: 30_000, pendingGenerationPollIntervalMs: 25 }
    );

    // The scoped apply must not consume the wait budget on the pending sibling.
    expect(Date.now() - startedAtMs).toBeLessThan(10_000);
    expect(result.success).toBe(true);
    expect(result.projectResults?.map((projectResult) => projectResult.status)).toEqual([
      "applied",
    ]);
  }, 20_000);

  it("reports still-pending generation as a retryable non-conflict failure after the wait times out", async () => {
    const targetRepo = path.join(rootDir, "target");
    const sessionDir = path.join(rootDir, "session");
    for (const repo of [targetRepo, sessionDir]) {
      await fsPromises.mkdir(repo, { recursive: true });
    }
    initGitRepo(targetRepo);
    await commitFile(targetRepo, "README.md", "hello", "base");

    const childTaskId = "child-task-1";
    await writePatchArtifact({
      sessionDir,
      workspaceId: getTestDeps().workspaceId,
      childTaskId,
      projectArtifacts: [
        {
          projectPath: targetRepo,
          projectName: "target",
          storageKey: "target",
          status: "pending",
        },
      ],
    });

    const result = await applyTaskGitPatchArtifact(
      {
        ...getTestDeps(),
        cwd: targetRepo,
        runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
        runtimeTempDir: "/tmp",
        workspaceSessionDir: sessionDir,
      },
      { task_id: childTaskId, dry_run: true, three_way: true },
      { pendingGenerationWaitMs: 50, pendingGenerationPollIntervalMs: 10 }
    );

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected failure result");
    }
    // The timing gap must not be reported as an apply conflict (workflows
    // would otherwise spawn conflict-resolution agents for it).
    expect(result.error).toContain("not an apply conflict");
    expect(result.conflictPaths).toBeUndefined();
    expect(result.projectResults?.map((projectResult) => projectResult.status)).toEqual([
      "skipped",
    ]);
  }, 20_000);

  it("replays patch artifacts from an ancestor session dir without mutating metadata", async () => {
    const childRepo = path.join(rootDir, "child");
    const targetRepo = path.join(rootDir, "target");
    for (const repo of [childRepo, targetRepo]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }

    await commitFile(childRepo, "README.md", "hello", "base");
    await commitFile(targetRepo, "README.md", "hello", "base");
    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await commitFile(childRepo, "README.md", "hello\nworld", "child change");
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const childTaskId = "child-task-1";
    const muxRoot = path.join(rootDir, "mux");
    const ancestorWorkspaceId = "ancestor-workspace";
    const currentWorkspaceId = "current-workspace";
    const ancestorSessionDir = path.join(muxRoot, "sessions", ancestorWorkspaceId);
    const currentSessionDir = path.join(muxRoot, "sessions", currentWorkspaceId);
    await fsPromises.mkdir(ancestorSessionDir, { recursive: true });
    await fsPromises.mkdir(currentSessionDir, { recursive: true });

    await writePatchArtifact({
      sessionDir: ancestorSessionDir,
      workspaceId: ancestorWorkspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir: ancestorSessionDir,
          childTaskId,
          storageKey: "target",
          projectPath: targetRepo,
          projectName: "target",
          childRepo,
          baseSha,
          headSha,
        }),
      ],
    });

    const artifactBeforeReplay = await readSubagentGitPatchArtifact(
      ancestorSessionDir,
      childTaskId
    );
    const appliedAtMs = Date.now();
    await upsertSubagentGitPatchArtifact({
      workspaceId: ancestorWorkspaceId,
      workspaceSessionDir: ancestorSessionDir,
      childTaskId,
      updater: (existing) => ({
        ...(existing ?? artifactBeforeReplay!),
        childTaskId,
        parentWorkspaceId: ancestorWorkspaceId,
        createdAtMs: existing?.createdAtMs ?? Date.now(),
        updatedAtMs: appliedAtMs,
        status: existing?.status ?? "ready",
        projectArtifacts: (
          existing?.projectArtifacts ??
          artifactBeforeReplay?.projectArtifacts ??
          []
        ).map((projectArtifact) => ({
          ...projectArtifact,
          appliedAtMs,
        })),
        readyProjectCount: existing?.readyProjectCount ?? 1,
        failedProjectCount: existing?.failedProjectCount ?? 0,
        skippedProjectCount: existing?.skippedProjectCount ?? 0,
        totalCommitCount: existing?.totalCommitCount ?? 1,
      }),
    });

    await fsPromises.writeFile(
      path.join(muxRoot, "config.json"),
      JSON.stringify(
        {
          projects: [
            [
              targetRepo,
              {
                workspaces: [
                  {
                    path: targetRepo,
                    id: ancestorWorkspaceId,
                    name: "ancestor",
                    runtimeConfig: { type: "local" },
                  },
                  {
                    path: targetRepo,
                    id: currentWorkspaceId,
                    name: "current",
                    runtimeConfig: { type: "local" },
                    parentWorkspaceId: ancestorWorkspaceId,
                  },
                ],
              },
            ],
          ],
        },
        null,
        2
      ),
      "utf-8"
    );

    const tool = createTaskApplyGitPatchTool({
      ...getTestDeps(),
      workspaceId: currentWorkspaceId,
      cwd: targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: "/tmp",
      workspaceSessionDir: currentSessionDir,
    });

    const result = (await tool.execute!({ task_id: childTaskId }, mockToolCallOptions)) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    const artifact = await readSubagentGitPatchArtifact(ancestorSessionDir, childTaskId);
    expect(artifact?.projectArtifacts[0]?.appliedAtMs).toBe(appliedAtMs);
    expect(await readSubagentGitPatchArtifact(currentSessionDir, childTaskId)).toBeNull();
  }, 20_000);
});

describe("task_apply_git_patch uncommitted-changes (worktree) patches", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-task-apply-worktree-patch-"));
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  async function setupSingleRepoHarness(): Promise<{
    childRepo: string;
    targetRepo: string;
    sessionDir: string;
    currentWorkspaceId: string;
    childTaskId: string;
    baseSha: string;
  }> {
    const childRepo = path.join(rootDir, "child");
    const targetRepo = path.join(rootDir, "target");
    for (const repo of [childRepo, targetRepo]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }
    await commitFile(childRepo, "README.md", "hello\n", "base");
    await commitFile(targetRepo, "README.md", "hello\n", "base");
    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const muxRoot = path.join(rootDir, "mux");
    const currentWorkspaceId = "current-workspace";
    const sessionDir = path.join(muxRoot, "sessions", currentWorkspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await writeWorkspaceConfig({
      muxRoot,
      workspaceId: currentWorkspaceId,
      workspaceName: "current",
      primaryProjectPath: targetRepo,
      projects: [{ projectPath: targetRepo, projectName: "project" }],
    });

    return {
      childRepo,
      targetRepo,
      sessionDir,
      currentWorkspaceId,
      childTaskId: "child-task-1",
      baseSha,
    };
  }

  function createApplyTool(harness: Awaited<ReturnType<typeof setupSingleRepoHarness>>) {
    return createTaskApplyGitPatchTool({
      ...getTestDeps(),
      workspaceId: harness.currentWorkspaceId,
      cwd: harness.targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: "/tmp",
      workspaceSessionDir: harness.sessionDir,
    });
  }

  async function writeWorktreePatchFile(params: {
    sessionDir: string;
    childTaskId: string;
    storageKey: string;
    childRepo: string;
  }): Promise<{ worktreePatchPath: string; worktreePatchBytes: number }> {
    const worktreePatchPath = getSubagentGitPatchWorktreePatchPath(
      params.sessionDir,
      params.childTaskId,
      params.storageKey
    );
    const diff = execSync("git add -A -- . && git diff --cached --binary HEAD --", {
      cwd: params.childRepo,
      encoding: "buffer",
    });
    execSync("git reset", { cwd: params.childRepo, stdio: "ignore" });
    await fsPromises.mkdir(path.dirname(worktreePatchPath), { recursive: true });
    await fsPromises.writeFile(worktreePatchPath, diff);
    return { worktreePatchPath, worktreePatchBytes: diff.length };
  }

  it("applies a worktree-only artifact as uncommitted changes", async () => {
    const harness = await setupSingleRepoHarness();

    await fsPromises.writeFile(path.join(harness.childRepo, "README.md"), "modified\n", "utf-8");
    await fsPromises.writeFile(path.join(harness.childRepo, "new.txt"), "untracked\n", "utf-8");
    const worktreeFields = await writeWorktreePatchFile({
      sessionDir: harness.sessionDir,
      childTaskId: harness.childTaskId,
      storageKey: "project",
      childRepo: harness.childRepo,
    });

    await writePatchArtifact({
      sessionDir: harness.sessionDir,
      workspaceId: harness.currentWorkspaceId,
      childTaskId: harness.childTaskId,
      projectArtifacts: [
        {
          projectPath: harness.targetRepo,
          projectName: "project",
          storageKey: "project",
          status: "ready",
          commitCount: 0,
          baseCommitSha: harness.baseSha,
          headCommitSha: harness.baseSha,
          hadUncommittedChanges: true,
          ...worktreeFields,
        },
      ],
    });

    const tool = createApplyTool(harness);

    const result = (await tool.execute!({ task_id: harness.childTaskId }, mockToolCallOptions)) as {
      success: boolean;
      projectResults: Array<{ status: string; note?: string }>;
    };

    expect(result.success).toBe(true);
    expect(result.projectResults[0]?.status).toBe("applied");

    expect(
      execSync("git log -1 --pretty=%s", { cwd: harness.targetRepo, encoding: "utf-8" }).trim()
    ).toBe("base");
    expect(await fsPromises.readFile(path.join(harness.targetRepo, "README.md"), "utf-8")).toBe(
      "modified\n"
    );
    expect(await fsPromises.readFile(path.join(harness.targetRepo, "new.txt"), "utf-8")).toBe(
      "untracked\n"
    );
    expect(
      execSync("git status --porcelain", { cwd: harness.targetRepo, encoding: "utf-8" }).trim()
        .length
    ).toBeGreaterThan(0);

    const artifact = await readSubagentGitPatchArtifact(harness.sessionDir, harness.childTaskId);
    expect(artifact?.projectArtifacts[0]?.appliedAtMs).toBeDefined();
  }, 20_000);

  it("leaves applied uncommitted changes unstaged and preserves disjoint staged entries", async () => {
    const harness = await setupSingleRepoHarness();

    await fsPromises.writeFile(path.join(harness.childRepo, "README.md"), "modified\n", "utf-8");
    await fsPromises.writeFile(path.join(harness.childRepo, "new.txt"), "untracked\n", "utf-8");
    const worktreeFields = await writeWorktreePatchFile({
      sessionDir: harness.sessionDir,
      childTaskId: harness.childTaskId,
      storageKey: "project",
      childRepo: harness.childRepo,
    });

    await writePatchArtifact({
      sessionDir: harness.sessionDir,
      workspaceId: harness.currentWorkspaceId,
      childTaskId: harness.childTaskId,
      projectArtifacts: [
        {
          projectPath: harness.targetRepo,
          projectName: "project",
          storageKey: "project",
          status: "ready",
          commitCount: 0,
          baseCommitSha: harness.baseSha,
          headCommitSha: harness.baseSha,
          hadUncommittedChanges: true,
          ...worktreeFields,
        },
      ],
    });

    // A disjoint staged entry must survive the post-apply unstaging.
    await fsPromises.writeFile(path.join(harness.targetRepo, "other.txt"), "staged\n", "utf-8");
    execSync("git add other.txt", { cwd: harness.targetRepo });

    const tool = createApplyTool(harness);
    const result = (await tool.execute!({ task_id: harness.childTaskId }, mockToolCallOptions)) as {
      success: boolean;
    };
    expect(result.success).toBe(true);

    // `git apply --3way` implies --index; the applied changes must not stay
    // staged or the next commit-bearing apply fails its clean-index
    // preflight.
    const stagedPaths = execSync("git diff --cached --name-only", {
      cwd: harness.targetRepo,
      encoding: "utf-8",
    })
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    expect(stagedPaths).toEqual(["other.txt"]);
    const status = execSync("git status --porcelain", {
      cwd: harness.targetRepo,
      encoding: "utf-8",
    });
    expect(status).toContain(" M README.md");
    expect(status).toContain("?? new.txt");
  }, 20_000);

  it("unstages entries left by a failed earlier attempt before completing via the reverse check", async () => {
    const harness = await setupSingleRepoHarness();

    await fsPromises.writeFile(
      path.join(harness.childRepo, "README.md"),
      "child update\n",
      "utf-8"
    );
    await fsPromises.writeFile(path.join(harness.childRepo, "new.txt"), "untracked\n", "utf-8");
    const worktreeFields = await writeWorktreePatchFile({
      sessionDir: harness.sessionDir,
      childTaskId: harness.childTaskId,
      storageKey: "project",
      childRepo: harness.childRepo,
    });

    await writePatchArtifact({
      sessionDir: harness.sessionDir,
      workspaceId: harness.currentWorkspaceId,
      childTaskId: harness.childTaskId,
      projectArtifacts: [
        {
          projectPath: harness.targetRepo,
          projectName: "project",
          storageKey: "project",
          status: "ready",
          commitCount: 0,
          hadUncommittedChanges: true,
          appliedPartial: true,
          appliedPartialStage: "commits-applied",
          ...worktreeFields,
        },
      ],
    });

    // Aftermath of an attempt whose apply succeeded but whose post-apply
    // unstage failed: the patch content is in the worktree AND staged
    // (`git apply --3way` implies --index).
    await fsPromises.writeFile(
      path.join(harness.targetRepo, "README.md"),
      "child update\n",
      "utf-8"
    );
    await fsPromises.writeFile(path.join(harness.targetRepo, "new.txt"), "untracked\n", "utf-8");
    execSync("git add README.md new.txt", { cwd: harness.targetRepo });
    // A disjoint staged entry must survive the repair.
    await fsPromises.writeFile(path.join(harness.targetRepo, "other.txt"), "staged\n", "utf-8");
    execSync("git add other.txt", { cwd: harness.targetRepo });

    const tool = createApplyTool(harness);
    const result = (await tool.execute!({ task_id: harness.childTaskId }, mockToolCallOptions)) as {
      success: boolean;
      projectResults: Array<{ status: string; note?: string }>;
    };
    expect(result.success).toBe(true);
    expect(result.projectResults[0]?.note).toContain("already present in the worktree");

    // Completion must repair the index before clearing the marker, or the
    // next commit-bearing apply fails its clean-index preflight.
    const stagedPaths = execSync("git diff --cached --name-only", {
      cwd: harness.targetRepo,
      encoding: "utf-8",
    })
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    expect(stagedPaths).toEqual(["other.txt"]);
    const status = execSync("git status --porcelain", {
      cwd: harness.targetRepo,
      encoding: "utf-8",
    });
    expect(status).toContain(" M README.md");
    expect(status).toContain("?? new.txt");
    const artifactAfterRetry = await readSubagentGitPatchArtifact(
      harness.sessionDir,
      harness.childTaskId
    );
    expect(artifactAfterRetry?.projectArtifacts[0]?.appliedPartial).toBeUndefined();
  }, 20_000);

  it("fails a replay-safe retry when the applied uncommitted changes were discarded", async () => {
    const harness = await setupSingleRepoHarness();

    await fsPromises.writeFile(
      path.join(harness.childRepo, "README.md"),
      "child update\n",
      "utf-8"
    );
    await fsPromises.writeFile(path.join(harness.childRepo, "new.txt"), "untracked\n", "utf-8");
    const worktreeFields = await writeWorktreePatchFile({
      sessionDir: harness.sessionDir,
      childTaskId: harness.childTaskId,
      storageKey: "project",
      childRepo: harness.childRepo,
    });

    await writePatchArtifact({
      sessionDir: harness.sessionDir,
      workspaceId: harness.currentWorkspaceId,
      childTaskId: harness.childTaskId,
      projectArtifacts: [
        {
          projectPath: harness.targetRepo,
          projectName: "project",
          storageKey: "project",
          status: "ready",
          commitCount: 0,
          hadUncommittedChanges: true,
          ...worktreeFields,
        },
      ],
    });

    const deps = {
      ...getTestDeps(),
      workspaceId: harness.currentWorkspaceId,
      cwd: harness.targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: "/tmp",
      workspaceSessionDir: harness.sessionDir,
    };
    const first = await applyTaskGitPatchArtifact(
      deps,
      { task_id: harness.childTaskId, three_way: true },
      {}
    );
    expect(first.success).toBe(true);

    // A crash-before-checkpoint retry with the work intact skips as applied.
    const intactRetry = await applyTaskGitPatchArtifact(
      deps,
      { task_id: harness.childTaskId, three_way: true },
      { allowAlreadyApplied: true }
    );
    expect(intactRetry.success).toBe(true);
    expect(intactRetry.projectResults?.[0]?.note).toContain("already applied");

    // Committing the applied work afterwards is a legitimate evolution of
    // the target, not a discard: the patch paths changed since the recorded
    // post-apply HEAD.
    execSync("git add README.md new.txt && git commit -m 'landed child work'", {
      cwd: harness.targetRepo,
      stdio: "ignore",
    });
    const committedRetry = await applyTaskGitPatchArtifact(
      deps,
      { task_id: harness.childTaskId, three_way: true },
      { allowAlreadyApplied: true }
    );
    expect(committedRetry.success).toBe(true);
    expect(committedRetry.projectResults?.[0]?.note).toContain("already applied");

    // Once the applied changes are discarded (patch paths pristine at the
    // recorded post-apply state), the completion record alone must not let
    // a workflow checkpoint past the missing work.
    execSync(`git reset --hard ${harness.baseSha}`, { cwd: harness.targetRepo, stdio: "ignore" });
    const staleRetry = await applyTaskGitPatchArtifact(
      deps,
      { task_id: harness.childTaskId, three_way: true },
      { allowAlreadyApplied: true }
    );
    expect(staleRetry.success).toBe(false);
    expect(staleRetry.projectResults?.[0]?.error).toContain("no longer present in the worktree");
  }, 20_000);

  it("applies a canonical worktree patch when worktreePatchPath metadata was sanitized away", async () => {
    const harness = await setupSingleRepoHarness();

    await commitFile(harness.childRepo, "feature.txt", "feature\n", "child commit");
    const headSha = execSync("git rev-parse HEAD", {
      cwd: harness.childRepo,
      encoding: "utf-8",
    }).trim();
    await fsPromises.writeFile(path.join(harness.childRepo, "extra.txt"), "extra\n", "utf-8");
    const worktreeFields = await writeWorktreePatchFile({
      sessionDir: harness.sessionDir,
      childTaskId: harness.childTaskId,
      storageKey: "project",
      childRepo: harness.childRepo,
    });

    // A corrupt persisted worktreePatchPath is dropped by the sanitizer, but
    // the captured patch still sits at the canonical location; applying must
    // not silently omit it while marking the artifact complete.
    await writePatchArtifact({
      sessionDir: harness.sessionDir,
      workspaceId: harness.currentWorkspaceId,
      childTaskId: harness.childTaskId,
      projectArtifacts: [
        {
          ...(await buildReadyProjectArtifact({
            sessionDir: harness.sessionDir,
            childTaskId: harness.childTaskId,
            storageKey: "project",
            projectPath: harness.targetRepo,
            projectName: "project",
            childRepo: harness.childRepo,
            baseSha: harness.baseSha,
            headSha,
          })),
          hadUncommittedChanges: true,
          worktreePatchBytes: worktreeFields.worktreePatchBytes,
        },
      ],
    });

    const tool = createApplyTool(harness);
    const result = (await tool.execute!({ task_id: harness.childTaskId }, mockToolCallOptions)) as {
      success: boolean;
      projectResults: Array<{ status: string }>;
    };

    expect(result.success).toBe(true);
    expect(result.projectResults[0]?.status).toBe("applied");
    expect(
      execSync("git log -1 --pretty=%s", { cwd: harness.targetRepo, encoding: "utf-8" }).trim()
    ).toBe("child commit");
    expect(await fsPromises.readFile(path.join(harness.targetRepo, "extra.txt"), "utf-8")).toBe(
      "extra\n"
    );
  }, 20_000);

  it("applies commits first and then the uncommitted-changes patch", async () => {
    const harness = await setupSingleRepoHarness();

    await commitFile(harness.childRepo, "feature.txt", "feature\n", "child commit");
    const headSha = execSync("git rev-parse HEAD", {
      cwd: harness.childRepo,
      encoding: "utf-8",
    }).trim();
    await fsPromises.writeFile(
      path.join(harness.childRepo, "feature.txt"),
      "feature wip\n",
      "utf-8"
    );
    const worktreeFields = await writeWorktreePatchFile({
      sessionDir: harness.sessionDir,
      childTaskId: harness.childTaskId,
      storageKey: "project",
      childRepo: harness.childRepo,
    });

    await writePatchArtifact({
      sessionDir: harness.sessionDir,
      workspaceId: harness.currentWorkspaceId,
      childTaskId: harness.childTaskId,
      projectArtifacts: [
        {
          ...(await buildReadyProjectArtifact({
            sessionDir: harness.sessionDir,
            childTaskId: harness.childTaskId,
            storageKey: "project",
            projectPath: harness.targetRepo,
            projectName: "project",
            childRepo: harness.childRepo,
            baseSha: harness.baseSha,
            headSha,
          })),
          hadUncommittedChanges: true,
          ...worktreeFields,
        },
      ],
    });

    const tool = createApplyTool(harness);

    const result = (await tool.execute!({ task_id: harness.childTaskId }, mockToolCallOptions)) as {
      success: boolean;
      projectResults: Array<{ status: string; note?: string }>;
    };

    expect(result.success).toBe(true);
    expect(result.projectResults[0]?.status).toBe("applied");

    expect(
      execSync("git log -1 --pretty=%s", { cwd: harness.targetRepo, encoding: "utf-8" }).trim()
    ).toBe("child commit");
    expect(await fsPromises.readFile(path.join(harness.targetRepo, "feature.txt"), "utf-8")).toBe(
      "feature wip\n"
    );
  }, 20_000);

  it("surfaces a worktree patch conflict clearly and leaves the repo recoverable", async () => {
    const harness = await setupSingleRepoHarness();

    await fsPromises.writeFile(
      path.join(harness.childRepo, "README.md"),
      "child version\n",
      "utf-8"
    );
    const worktreeFields = await writeWorktreePatchFile({
      sessionDir: harness.sessionDir,
      childTaskId: harness.childTaskId,
      storageKey: "project",
      childRepo: harness.childRepo,
    });

    await commitFile(harness.targetRepo, "README.md", "target version\n", "conflicting change");

    await writePatchArtifact({
      sessionDir: harness.sessionDir,
      workspaceId: harness.currentWorkspaceId,
      childTaskId: harness.childTaskId,
      projectArtifacts: [
        {
          projectPath: harness.targetRepo,
          projectName: "project",
          storageKey: "project",
          status: "ready",
          commitCount: 0,
          hadUncommittedChanges: true,
          ...worktreeFields,
        },
      ],
    });

    const tool = createApplyTool(harness);

    const result = (await tool.execute!({ task_id: harness.childTaskId }, mockToolCallOptions)) as {
      success: boolean;
      projectResults: Array<{ status: string; error?: string }>;
    };

    expect(result.success).toBe(false);
    expect(result.projectResults[0]?.status).toBe("failed");
    expect(result.projectResults[0]?.error).toBeDefined();

    expect(
      execSync("git log -1 --pretty=%s", { cwd: harness.targetRepo, encoding: "utf-8" }).trim()
    ).toBe("conflicting change");
    // git apply --3way can leave part of a multi-file patch applied, so the
    // failure records a partial marker: retries route to the reverse-check
    // completion path instead of re-treating the artifact as fresh (which
    // the dirty-overlap preflight would permanently reject).
    const artifact = await readSubagentGitPatchArtifact(harness.sessionDir, harness.childTaskId);
    expect(artifact?.projectArtifacts[0]?.appliedPartial).toBe(true);

    // Manual recovery: resolve the conflicted file to the child's content.
    await fsPromises.writeFile(
      path.join(harness.targetRepo, "README.md"),
      "child version\n",
      "utf-8"
    );
    const retryResult = (await tool.execute!(
      { task_id: harness.childTaskId },
      mockToolCallOptions
    )) as {
      success: boolean;
      projectResults: Array<{ status: string; note?: string }>;
    };
    expect(retryResult.success).toBe(true);
    expect(retryResult.projectResults[0]?.note).toContain("already present in the worktree");
    const artifactAfterRetry = await readSubagentGitPatchArtifact(
      harness.sessionDir,
      harness.childTaskId
    );
    expect(artifactAfterRetry?.projectArtifacts[0]?.appliedPartial).toBeUndefined();
    // The failed --3way attempt left unmerged index entries; completion must
    // repair them before clearing the marker.
    expect(
      execSync("git diff --cached --name-only", {
        cwd: harness.targetRepo,
        encoding: "utf-8",
      }).trim()
    ).toBe("");
  }, 20_000);

  it("records the artifact as applied when commits land but the worktree patch fails", async () => {
    const harness = await setupSingleRepoHarness();

    await commitFile(harness.childRepo, "feature.txt", "feature\n", "child commit");
    const headSha = execSync("git rev-parse HEAD", {
      cwd: harness.childRepo,
      encoding: "utf-8",
    }).trim();
    await fsPromises.writeFile(
      path.join(harness.childRepo, "README.md"),
      "child version\n",
      "utf-8"
    );
    const worktreeFields = await writeWorktreePatchFile({
      sessionDir: harness.sessionDir,
      childTaskId: harness.childTaskId,
      storageKey: "project",
      childRepo: harness.childRepo,
    });

    // Conflicting COMMIT keeps the target tree clean, so the dirty preflight
    // passes, git am succeeds, and only the worktree patch fails.
    await commitFile(harness.targetRepo, "README.md", "target version\n", "conflicting change");

    await writePatchArtifact({
      sessionDir: harness.sessionDir,
      workspaceId: harness.currentWorkspaceId,
      childTaskId: harness.childTaskId,
      projectArtifacts: [
        {
          ...(await buildReadyProjectArtifact({
            sessionDir: harness.sessionDir,
            childTaskId: harness.childTaskId,
            storageKey: "project",
            projectPath: harness.targetRepo,
            projectName: "project",
            childRepo: harness.childRepo,
            baseSha: harness.baseSha,
            headSha,
          })),
          hadUncommittedChanges: true,
          ...worktreeFields,
        },
      ],
    });

    const tool = createApplyTool(harness);

    const result = (await tool.execute!({ task_id: harness.childTaskId }, mockToolCallOptions)) as {
      success: boolean;
      projectResults: Array<{ status: string; error?: string; note?: string }>;
    };

    expect(result.success).toBe(false);
    expect(result.projectResults[0]?.status).toBe("failed");
    // The commit series landed on the target.
    expect(
      execSync("git log -1 --pretty=%s", { cwd: harness.targetRepo, encoding: "utf-8" }).trim()
    ).toBe("child commit");
    // HEAD advanced permanently, so a retry must see the artifact as applied,
    // but the partial marker keeps it from reading as a completed application.
    const artifact = await readSubagentGitPatchArtifact(harness.sessionDir, harness.childTaskId);
    expect(artifact?.projectArtifacts[0]?.appliedAtMs).toBeDefined();
    expect(artifact?.projectArtifacts[0]?.appliedPartial).toBe(true);

    // A replay-safe workflow retry (allowAlreadyApplied) attempts to
    // complete just the pending uncommitted-changes patch; the conflicting
    // target content makes that completion fail without re-running git am,
    // so the workflow still cannot checkpoint past the missing changes.
    const retryResult = await applyTaskGitPatchArtifact(
      {
        ...getTestDeps(),
        workspaceId: harness.currentWorkspaceId,
        cwd: harness.targetRepo,
        runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
        runtimeTempDir: "/tmp",
        workspaceSessionDir: harness.sessionDir,
      },
      { task_id: harness.childTaskId, three_way: true },
      { allowAlreadyApplied: true }
    );
    expect(retryResult.success).toBe(false);
    // The failed first attempt left conflict markers, so the completion is
    // blocked on the overlap preflight until they are resolved.
    expect(retryResult.note).toContain("Completing the earlier partial application was blocked");
    // The commit series was not replayed and the marker survives the
    // failed completion.
    expect(
      execSync('git log --pretty=%s --grep "child commit"', {
        cwd: harness.targetRepo,
        encoding: "utf-8",
      })
        .trim()
        .split("\n")
    ).toHaveLength(1);
    const artifactAfterRetry = await readSubagentGitPatchArtifact(
      harness.sessionDir,
      harness.childTaskId
    );
    expect(artifactAfterRetry?.projectArtifacts[0]?.appliedPartial).toBe(true);
  }, 20_000);

  it("persists partial state when the worktree application rejects instead of failing", async () => {
    const harness = await setupSingleRepoHarness();

    await commitFile(harness.childRepo, "feature.txt", "feature\n", "child commit");
    const headSha = execSync("git rev-parse HEAD", {
      cwd: harness.childRepo,
      encoding: "utf-8",
    }).trim();
    await fsPromises.writeFile(path.join(harness.childRepo, "extra.txt"), "extra\n", "utf-8");
    const worktreeFields = await writeWorktreePatchFile({
      sessionDir: harness.sessionDir,
      childTaskId: harness.childTaskId,
      storageKey: "project",
      childRepo: harness.childRepo,
    });

    await writePatchArtifact({
      sessionDir: harness.sessionDir,
      workspaceId: harness.currentWorkspaceId,
      childTaskId: harness.childTaskId,
      projectArtifacts: [
        {
          ...(await buildReadyProjectArtifact({
            sessionDir: harness.sessionDir,
            childTaskId: harness.childTaskId,
            storageKey: "project",
            projectPath: harness.targetRepo,
            projectName: "project",
            childRepo: harness.childRepo,
            baseSha: harness.baseSha,
            headSha,
          })),
          hadUncommittedChanges: true,
          ...worktreeFields,
        },
      ],
    });

    // Simulate an SSH/runtime failure that REJECTS the worktree apply after
    // git am already advanced HEAD.
    const realRuntime = createRuntime({ type: "local", srcBaseDir: "/tmp" });
    const failingRuntime: typeof realRuntime = Object.create(realRuntime, {
      exec: {
        value: (command: string, options: Parameters<typeof realRuntime.exec>[1]) => {
          if (command.includes("git apply --3way --binary")) {
            return Promise.reject(new Error("simulated runtime exec failure"));
          }
          return realRuntime.exec(command, options);
        },
      },
    }) as typeof realRuntime;

    const deps = {
      ...getTestDeps(),
      workspaceId: harness.currentWorkspaceId,
      cwd: harness.targetRepo,
      runtimeTempDir: "/tmp",
      workspaceSessionDir: harness.sessionDir,
    };
    let thrownMessage = "";
    try {
      await applyTaskGitPatchArtifact(
        { ...deps, runtime: failingRuntime },
        { task_id: harness.childTaskId, three_way: true },
        {}
      );
    } catch (error) {
      thrownMessage = error instanceof Error ? error.message : String(error);
    }
    expect(thrownMessage).toContain("simulated runtime exec failure");

    // The commit series landed before the rejection.
    expect(
      execSync("git log -1 --pretty=%s", { cwd: harness.targetRepo, encoding: "utf-8" }).trim()
    ).toBe("child commit");
    // The rejection persisted partial state; the retry completes just the
    // pending uncommitted-changes patch instead of re-running git am on the
    // already-applied commit series.
    const artifact = await readSubagentGitPatchArtifact(harness.sessionDir, harness.childTaskId);
    expect(artifact?.projectArtifacts[0]?.appliedPartial).toBe(true);
    const retryResult = await applyTaskGitPatchArtifact(
      { ...deps, runtime: realRuntime },
      { task_id: harness.childTaskId, three_way: true },
      { allowAlreadyApplied: true }
    );
    expect(retryResult.success).toBe(true);
    expect(retryResult.note).toContain("Completed the earlier partial application");
    // The child's uncommitted change landed as uncommitted content, the
    // commit series was not replayed, and the marker cleared.
    expect(await fsPromises.readFile(path.join(harness.targetRepo, "extra.txt"), "utf-8")).toBe(
      "extra\n"
    );
    expect(
      execSync('git log --pretty=%s --grep "child commit"', {
        cwd: harness.targetRepo,
        encoding: "utf-8",
      })
        .trim()
        .split("\n")
    ).toHaveLength(1);
    const artifactAfterRetry = await readSubagentGitPatchArtifact(
      harness.sessionDir,
      harness.childTaskId
    );
    expect(artifactAfterRetry?.projectArtifacts[0]?.appliedPartial).toBeUndefined();
    expect(artifactAfterRetry?.projectArtifacts[0]?.appliedAtMs).toBeDefined();
  }, 20_000);

  it("rolls back the commit series when the partial marker cannot be persisted", async () => {
    const harness = await setupSingleRepoHarness();

    await commitFile(harness.childRepo, "feature.txt", "feature\n", "child commit");
    const headSha = execSync("git rev-parse HEAD", {
      cwd: harness.childRepo,
      encoding: "utf-8",
    }).trim();
    await fsPromises.writeFile(path.join(harness.childRepo, "extra.txt"), "extra\n", "utf-8");
    const worktreeFields = await writeWorktreePatchFile({
      sessionDir: harness.sessionDir,
      childTaskId: harness.childTaskId,
      storageKey: "project",
      childRepo: harness.childRepo,
    });

    await writePatchArtifact({
      sessionDir: harness.sessionDir,
      workspaceId: harness.currentWorkspaceId,
      childTaskId: harness.childTaskId,
      projectArtifacts: [
        {
          ...(await buildReadyProjectArtifact({
            sessionDir: harness.sessionDir,
            childTaskId: harness.childTaskId,
            storageKey: "project",
            projectPath: harness.targetRepo,
            projectName: "project",
            childRepo: harness.childRepo,
            baseSha: harness.baseSha,
            headSha,
          })),
          hadUncommittedChanges: true,
          ...worktreeFields,
        },
      ],
    });

    // Unrelated dirty work in the target: the rollback must preserve it.
    await fsPromises.writeFile(
      path.join(harness.targetRepo, "target-local.txt"),
      "local\n",
      "utf-8"
    );

    const tool = createApplyTool(harness);

    // Fail only the post-am upgrade write (commits-applied): the in-progress
    // am-started marker before git am must succeed so the failure window is
    // specifically "commits landed, upgrade marker unwritable".
    const realMarkApplied = subagentGitPatchArtifactsModule.markSubagentGitPatchArtifactApplied;
    const markAppliedSpy = spyOn(
      subagentGitPatchArtifactsModule,
      "markSubagentGitPatchArtifactApplied"
    ).mockImplementation((markParams) => {
      if (markParams.partialStage === "commits-applied") {
        return Promise.reject(new Error("simulated marker persistence failure"));
      }
      return realMarkApplied(markParams);
    });
    let result: {
      success: boolean;
      projectResults: Array<{ status: string; error?: string; note?: string }>;
    };
    try {
      result = (await tool.execute!(
        { task_id: harness.childTaskId },
        mockToolCallOptions
      )) as typeof result;
    } finally {
      markAppliedSpy.mockRestore();
    }

    expect(result.success).toBe(false);
    expect(result.projectResults[0]?.error).toContain(
      "Failed to persist the partial-application marker"
    );
    expect(result.projectResults[0]?.note).toContain("rolled back");
    // The commit series was rolled back; unrelated dirty work survived.
    expect(
      execSync("git log -1 --pretty=%s", { cwd: harness.targetRepo, encoding: "utf-8" }).trim()
    ).toBe("base");
    expect(
      await fsPromises.readFile(path.join(harness.targetRepo, "target-local.txt"), "utf-8")
    ).toBe("local\n");
    // The pre-am in-progress marker remains (its fence matches the rolled
    // back HEAD, so the retry below reconciles and proceeds fresh), and
    // nothing reads as applied.
    const artifact = await readSubagentGitPatchArtifact(harness.sessionDir, harness.childTaskId);
    expect(artifact?.projectArtifacts[0]?.appliedPartialStage).toBe("am-started");
    expect(artifact?.projectArtifacts[0]?.appliedAtMs).toBeUndefined();

    // Cleanly retryable once persistence works again.
    const retryResult = (await tool.execute!(
      { task_id: harness.childTaskId },
      mockToolCallOptions
    )) as { success: boolean };
    expect(retryResult.success).toBe(true);
    expect(
      execSync('git log --pretty=%s --grep "child commit"', {
        cwd: harness.targetRepo,
        encoding: "utf-8",
      })
        .trim()
        .split("\n")
    ).toHaveLength(1);
    expect(await fsPromises.readFile(path.join(harness.targetRepo, "extra.txt"), "utf-8")).toBe(
      "extra\n"
    );
  }, 20_000);

  it("fails a worktree-only apply cleanly when the partial marker cannot be persisted", async () => {
    const harness = await setupSingleRepoHarness();

    // Worktree-only artifact: no commits, dirty child.
    await fsPromises.writeFile(path.join(harness.childRepo, "wt.txt"), "dirty\n", "utf-8");
    const worktreeFields = await writeWorktreePatchFile({
      sessionDir: harness.sessionDir,
      childTaskId: harness.childTaskId,
      storageKey: "project",
      childRepo: harness.childRepo,
    });

    await writePatchArtifact({
      sessionDir: harness.sessionDir,
      workspaceId: harness.currentWorkspaceId,
      childTaskId: harness.childTaskId,
      projectArtifacts: [
        {
          projectPath: harness.targetRepo,
          projectName: "project",
          storageKey: "project",
          status: "ready",
          commitCount: 0,
          hadUncommittedChanges: true,
          ...worktreeFields,
        },
      ],
    });

    const tool = createApplyTool(harness);

    // The marker is persisted BEFORE the irreversible apply, so a marker
    // write failure must fail cleanly with nothing applied (writing it only
    // after a failure could itself fail and leave no record of a partially
    // applied patch).
    await fsPromises.chmod(harness.sessionDir, 0o555);
    let result: {
      success: boolean;
      projectResults: Array<{ status: string; error?: string; note?: string }>;
    };
    try {
      result = (await tool.execute!(
        { task_id: harness.childTaskId },
        mockToolCallOptions
      )) as typeof result;
    } finally {
      await fsPromises.chmod(harness.sessionDir, 0o755);
    }

    expect(result.success).toBe(false);
    expect(result.projectResults[0]?.error).toContain(
      "Failed to persist the partial-application marker"
    );
    expect(result.projectResults[0]?.note).toContain("Nothing was applied");
    // The apply never ran: the target holds none of the patch content.
    expect(
      await fsPromises
        .access(path.join(harness.targetRepo, "wt.txt"))
        .then(() => true)
        .catch(() => false)
    ).toBe(false);

    // Cleanly retryable once persistence works again.
    const retryResult = (await tool.execute!(
      { task_id: harness.childTaskId },
      mockToolCallOptions
    )) as { success: boolean };
    expect(retryResult.success).toBe(true);
    expect(await fsPromises.readFile(path.join(harness.targetRepo, "wt.txt"), "utf-8")).toBe(
      "dirty\n"
    );
    const artifactAfterRetry = await readSubagentGitPatchArtifact(
      harness.sessionDir,
      harness.childTaskId
    );
    expect(artifactAfterRetry?.projectArtifacts[0]?.appliedPartial).toBeUndefined();
    expect(artifactAfterRetry?.projectArtifacts[0]?.appliedAtMs).toBeDefined();
  }, 20_000);

  it("fails the apply when the completion record cannot be persisted", async () => {
    const harness = await setupSingleRepoHarness();

    await commitFile(harness.childRepo, "feature.txt", "feature\n", "child commit");
    const headSha = execSync("git rev-parse HEAD", {
      cwd: harness.childRepo,
      encoding: "utf-8",
    }).trim();
    await fsPromises.writeFile(path.join(harness.childRepo, "extra.txt"), "extra\n", "utf-8");
    const worktreeFields = await writeWorktreePatchFile({
      sessionDir: harness.sessionDir,
      childTaskId: harness.childTaskId,
      storageKey: "project",
      childRepo: harness.childRepo,
    });

    await writePatchArtifact({
      sessionDir: harness.sessionDir,
      workspaceId: harness.currentWorkspaceId,
      childTaskId: harness.childTaskId,
      projectArtifacts: [
        {
          ...(await buildReadyProjectArtifact({
            sessionDir: harness.sessionDir,
            childTaskId: harness.childTaskId,
            storageKey: "project",
            projectPath: harness.targetRepo,
            projectName: "project",
            childRepo: harness.childRepo,
            baseSha: harness.baseSha,
            headSha,
          })),
          hadUncommittedChanges: true,
          ...worktreeFields,
        },
      ],
    });

    const tool = createApplyTool(harness);

    // Fail only the final completion write (the partial stamps carry
    // partial: true): the failure window is "everything applied, completion
    // record unwritable". Success here would leave durable state saying
    // commits-applied while the caller checkpoints past the apply.
    const realMarkApplied = subagentGitPatchArtifactsModule.markSubagentGitPatchArtifactApplied;
    const markAppliedSpy = spyOn(
      subagentGitPatchArtifactsModule,
      "markSubagentGitPatchArtifactApplied"
    ).mockImplementation((markParams) => {
      if (markParams.partial !== true) {
        return Promise.reject(new Error("simulated completion persistence failure"));
      }
      return realMarkApplied(markParams);
    });
    let result: {
      success: boolean;
      projectResults: Array<{ status: string; error?: string; note?: string }>;
    };
    try {
      result = (await tool.execute!(
        { task_id: harness.childTaskId },
        mockToolCallOptions
      )) as typeof result;
    } finally {
      markAppliedSpy.mockRestore();
    }

    expect(result.success).toBe(false);
    expect(result.projectResults[0]?.error).toContain("recording the completion failed");
    expect(result.projectResults[0]?.note).toContain("Do NOT re-apply");
    // The work stayed applied; only the durable record is stale.
    expect(
      execSync("git log -1 --pretty=%s", { cwd: harness.targetRepo, encoding: "utf-8" }).trim()
    ).toBe("child commit");
    expect(await fsPromises.readFile(path.join(harness.targetRepo, "extra.txt"), "utf-8")).toBe(
      "extra\n"
    );
    // The surviving partial marker keeps the state from reading as fully
    // applied (the commits-applied stamp carries appliedAtMs by design).
    const artifact = await readSubagentGitPatchArtifact(harness.sessionDir, harness.childTaskId);
    expect(artifact?.projectArtifacts[0]?.appliedPartial).toBe(true);
    expect(artifact?.projectArtifacts[0]?.appliedPartialStage).toBe("commits-applied");

    // The guidance holds: once persistence works again, the retry
    // reconciles the surviving marker and completes without replaying the
    // commit series.
    const retryResult = (await tool.execute!(
      { task_id: harness.childTaskId },
      mockToolCallOptions
    )) as { success: boolean };
    expect(retryResult.success).toBe(true);
    expect(
      execSync('git log --pretty=%s --grep "child commit"', {
        cwd: harness.targetRepo,
        encoding: "utf-8",
      })
        .trim()
        .split("\n")
    ).toHaveLength(1);
    const artifactAfterRetry = await readSubagentGitPatchArtifact(
      harness.sessionDir,
      harness.childTaskId
    );
    expect(artifactAfterRetry?.projectArtifacts[0]?.appliedAtMs).toBeDefined();
    expect(artifactAfterRetry?.projectArtifacts[0]?.appliedPartial).toBeUndefined();
  }, 20_000);

  it("fails a worktree-only apply when the completion record cannot be persisted", async () => {
    const harness = await setupSingleRepoHarness();

    await fsPromises.writeFile(path.join(harness.childRepo, "wt.txt"), "dirty\n", "utf-8");
    const worktreeFields = await writeWorktreePatchFile({
      sessionDir: harness.sessionDir,
      childTaskId: harness.childTaskId,
      storageKey: "project",
      childRepo: harness.childRepo,
    });

    await writePatchArtifact({
      sessionDir: harness.sessionDir,
      workspaceId: harness.currentWorkspaceId,
      childTaskId: harness.childTaskId,
      projectArtifacts: [
        {
          projectPath: harness.targetRepo,
          projectName: "project",
          storageKey: "project",
          status: "ready",
          commitCount: 0,
          hadUncommittedChanges: true,
          ...worktreeFields,
        },
      ],
    });

    const tool = createApplyTool(harness);

    const realMarkApplied = subagentGitPatchArtifactsModule.markSubagentGitPatchArtifactApplied;
    const markAppliedSpy = spyOn(
      subagentGitPatchArtifactsModule,
      "markSubagentGitPatchArtifactApplied"
    ).mockImplementation((markParams) => {
      if (markParams.partial !== true) {
        return Promise.reject(new Error("simulated completion persistence failure"));
      }
      return realMarkApplied(markParams);
    });
    let result: {
      success: boolean;
      projectResults: Array<{ status: string; error?: string; note?: string }>;
    };
    try {
      result = (await tool.execute!(
        { task_id: harness.childTaskId },
        mockToolCallOptions
      )) as typeof result;
    } finally {
      markAppliedSpy.mockRestore();
    }

    expect(result.success).toBe(false);
    expect(result.projectResults[0]?.error).toContain("recording the completion failed");
    expect(result.projectResults[0]?.note).toContain("Do NOT re-apply");
    // The changes stayed applied; the pre-apply partial marker survives so
    // the retry can tell the finished apply from an unrecovered partial.
    expect(await fsPromises.readFile(path.join(harness.targetRepo, "wt.txt"), "utf-8")).toBe(
      "dirty\n"
    );
    const artifact = await readSubagentGitPatchArtifact(harness.sessionDir, harness.childTaskId);
    expect(artifact?.projectArtifacts[0]?.appliedPartial).toBe(true);

    // The retry detects the already-present changes and completes the record.
    const retryResult = (await tool.execute!(
      { task_id: harness.childTaskId },
      mockToolCallOptions
    )) as { success: boolean; projectResults: Array<{ note?: string }> };
    expect(retryResult.success).toBe(true);
    expect(retryResult.projectResults[0]?.note).toContain("already present in the worktree");
    const artifactAfterRetry = await readSubagentGitPatchArtifact(
      harness.sessionDir,
      harness.childTaskId
    );
    expect(artifactAfterRetry?.projectArtifacts[0]?.appliedAtMs).toBeDefined();
    expect(artifactAfterRetry?.projectArtifacts[0]?.appliedPartial).toBeUndefined();
  }, 20_000);

  it("records a durable in-progress marker before git am runs", async () => {
    const harness = await setupSingleRepoHarness();

    await commitFile(harness.childRepo, "feature.txt", "feature\n", "child commit");
    const headSha = execSync("git rev-parse HEAD", {
      cwd: harness.childRepo,
      encoding: "utf-8",
    }).trim();

    await writePatchArtifact({
      sessionDir: harness.sessionDir,
      workspaceId: harness.currentWorkspaceId,
      childTaskId: harness.childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir: harness.sessionDir,
          childTaskId: harness.childTaskId,
          storageKey: "project",
          projectPath: harness.targetRepo,
          projectName: "project",
          childRepo: harness.childRepo,
          baseSha: harness.baseSha,
          headSha,
        }),
      ],
    });

    // Simulate a crash at the git am boundary: the runtime rejects the am
    // command itself, so nothing after it (including any marker write) runs.
    const realRuntime = createRuntime({ type: "local", srcBaseDir: "/tmp" });
    const failingRuntime: typeof realRuntime = Object.create(realRuntime, {
      exec: {
        value: (command: string, options: Parameters<typeof realRuntime.exec>[1]) => {
          if (command.includes("git am ")) {
            return Promise.reject(new Error("simulated crash at git am"));
          }
          return realRuntime.exec(command, options);
        },
      },
    }) as typeof realRuntime;

    const deps = {
      ...getTestDeps(),
      workspaceId: harness.currentWorkspaceId,
      cwd: harness.targetRepo,
      runtimeTempDir: "/tmp",
      workspaceSessionDir: harness.sessionDir,
    };
    let thrownMessage = "";
    try {
      await applyTaskGitPatchArtifact(
        { ...deps, runtime: failingRuntime },
        { task_id: harness.childTaskId, three_way: true },
        {}
      );
    } catch (error) {
      thrownMessage = error instanceof Error ? error.message : String(error);
    }
    expect(thrownMessage).toContain("simulated crash at git am");

    // The in-progress marker was persisted BEFORE git am, so even a hard
    // crash there leaves a durable record; it does not read as applied.
    const artifact = await readSubagentGitPatchArtifact(harness.sessionDir, harness.childTaskId);
    expect(artifact?.projectArtifacts[0]?.appliedPartialStage).toBe("am-started");
    expect(artifact?.projectArtifacts[0]?.appliedAtMs).toBeUndefined();

    // HEAD never moved, so the retry reconciles and applies fresh.
    const retryResult = await applyTaskGitPatchArtifact(
      { ...deps, runtime: realRuntime },
      { task_id: harness.childTaskId, three_way: true },
      {}
    );
    expect(retryResult.success).toBe(true);
    expect(
      execSync('git log --pretty=%s --grep "child commit"', {
        cwd: harness.targetRepo,
        encoding: "utf-8",
      })
        .trim()
        .split("\n")
    ).toHaveLength(1);
    const artifactAfterRetry = await readSubagentGitPatchArtifact(
      harness.sessionDir,
      harness.childTaskId
    );
    expect(artifactAfterRetry?.projectArtifacts[0]?.appliedPartial).toBeUndefined();
    expect(artifactAfterRetry?.projectArtifacts[0]?.appliedPartialStage).toBeUndefined();
    expect(artifactAfterRetry?.projectArtifacts[0]?.appliedAtMs).toBeDefined();
  }, 20_000);

  it("fails closed when an interrupted apply may have advanced HEAD", async () => {
    const harness = await setupSingleRepoHarness();

    await commitFile(harness.childRepo, "feature.txt", "feature\n", "child commit");
    const headSha = execSync("git rev-parse HEAD", {
      cwd: harness.childRepo,
      encoding: "utf-8",
    }).trim();
    const preAmHead = execSync("git rev-parse HEAD", {
      cwd: harness.targetRepo,
      encoding: "utf-8",
    }).trim();

    const projectArtifact = await buildReadyProjectArtifact({
      sessionDir: harness.sessionDir,
      childTaskId: harness.childTaskId,
      storageKey: "project",
      projectPath: harness.targetRepo,
      projectName: "project",
      childRepo: harness.childRepo,
      baseSha: harness.baseSha,
      headSha,
    });
    // Simulate the post-crash state: the interrupted attempt's git am landed
    // the series, but only the pre-am in-progress marker survives.
    await writePatchArtifact({
      sessionDir: harness.sessionDir,
      workspaceId: harness.currentWorkspaceId,
      childTaskId: harness.childTaskId,
      projectArtifacts: [
        {
          ...projectArtifact,
          appliedPartial: true,
          appliedPartialStage: "am-started",
          appliedPartialHeadSha: preAmHead,
        },
      ],
    });
    const mboxPath = getSubagentGitPatchMboxPath(
      harness.sessionDir,
      harness.childTaskId,
      "project"
    );
    execSync(`git am ${JSON.stringify(mboxPath)}`, { cwd: harness.targetRepo, stdio: "ignore" });

    const tool = createApplyTool(harness);
    const result = (await tool.execute!({ task_id: harness.childTaskId }, mockToolCallOptions)) as {
      success: boolean;
      projectResults: Array<{ status: string; error?: string }>;
    };
    // HEAD advanced past the recorded fence: replaying the mbox could
    // duplicate the series, so the retry must fail closed.
    expect(result.success).toBe(false);
    expect(result.projectResults[0]?.error).toContain("interrupted");
    expect(
      execSync('git log --pretty=%s --grep "child commit"', {
        cwd: harness.targetRepo,
        encoding: "utf-8",
      })
        .trim()
        .split("\n")
    ).toHaveLength(1);

    // The user verifies the series landed and acknowledges.
    const ackResult = (await tool.execute!(
      { task_id: harness.childTaskId, acknowledge_partial_recovery: true },
      mockToolCallOptions
    )) as { success: boolean };
    expect(ackResult.success).toBe(true);
    const artifact = await readSubagentGitPatchArtifact(harness.sessionDir, harness.childTaskId);
    expect(artifact?.projectArtifacts[0]?.appliedPartial).toBeUndefined();
    expect(artifact?.projectArtifacts[0]?.appliedPartialStage).toBeUndefined();
  }, 20_000);

  it("fails closed when a recorded partial stage is unreadable", async () => {
    const harness = await setupSingleRepoHarness();

    await commitFile(harness.childRepo, "feature.txt", "feature\n", "child commit");
    const headSha = execSync("git rev-parse HEAD", {
      cwd: harness.childRepo,
      encoding: "utf-8",
    }).trim();

    const projectArtifact = await buildReadyProjectArtifact({
      sessionDir: harness.sessionDir,
      childTaskId: harness.childTaskId,
      storageKey: "project",
      projectPath: harness.targetRepo,
      projectName: "project",
      childRepo: harness.childRepo,
      baseSha: harness.baseSha,
      headSha,
    });
    await writePatchArtifact({
      sessionDir: harness.sessionDir,
      workspaceId: harness.currentWorkspaceId,
      childTaskId: harness.childTaskId,
      projectArtifacts: [
        {
          ...projectArtifact,
          appliedPartial: true,
          appliedPartialStage: "am-started",
        },
      ],
    });
    // Corrupt the recorded stage on disk: the sanitizer must degrade it to
    // "unknown" (fail closed) rather than dropping it, which would read as
    // legacy commits-applied and skip git am for a series that never ran.
    const artifactsFilePath = path.join(harness.sessionDir, "subagent-patches.json");
    const rawArtifacts = await fsPromises.readFile(artifactsFilePath, "utf-8");
    await fsPromises.writeFile(
      artifactsFilePath,
      rawArtifacts.replace('"am-started"', '"mid-flight"'),
      "utf-8"
    );

    const tool = createApplyTool(harness);
    const result = (await tool.execute!({ task_id: harness.childTaskId }, mockToolCallOptions)) as {
      success: boolean;
      projectResults: Array<{ status: string; error?: string }>;
    };
    expect(result.success).toBe(false);
    expect(result.projectResults[0]?.error).toContain("stage is unreadable");
    // Nothing may be applied or cleared while the marker's meaning is unknown.
    expect(
      execSync('git log --pretty=%s --grep "child commit"', {
        cwd: harness.targetRepo,
        encoding: "utf-8",
      }).trim()
    ).toBe("");

    const ackResult = (await tool.execute!(
      { task_id: harness.childTaskId, acknowledge_partial_recovery: true },
      mockToolCallOptions
    )) as { success: boolean };
    expect(ackResult.success).toBe(true);
    const artifact = await readSubagentGitPatchArtifact(harness.sessionDir, harness.childTaskId);
    expect(artifact?.projectArtifacts[0]?.appliedPartial).toBeUndefined();
    expect(artifact?.projectArtifacts[0]?.appliedPartialStage).toBeUndefined();
  }, 20_000);

  it("enforces expected_head_sha when completing a commit-free partial application", async () => {
    const harness = await setupSingleRepoHarness();

    // Worktree-only artifact: no commits, dirty child.
    await fsPromises.writeFile(path.join(harness.childRepo, "wt.txt"), "dirty\n", "utf-8");
    const worktreeFields = await writeWorktreePatchFile({
      sessionDir: harness.sessionDir,
      childTaskId: harness.childTaskId,
      storageKey: "project",
      childRepo: harness.childRepo,
    });

    await writePatchArtifact({
      sessionDir: harness.sessionDir,
      workspaceId: harness.currentWorkspaceId,
      childTaskId: harness.childTaskId,
      projectArtifacts: [
        {
          projectPath: harness.targetRepo,
          projectName: "project",
          storageKey: "project",
          status: "ready",
          commitCount: 0,
          hadUncommittedChanges: true,
          ...worktreeFields,
        },
      ],
    });
    const originalHead = execSync("git rev-parse HEAD", {
      cwd: harness.targetRepo,
      encoding: "utf-8",
    }).trim();

    // First apply fails after the marker was recorded (corrupt patch file).
    const realPatchBytes = await fsPromises.readFile(worktreeFields.worktreePatchPath);
    await fsPromises.writeFile(worktreeFields.worktreePatchPath, "not a patch\n", "utf-8");
    const tool = createApplyTool(harness);
    const firstResult = (await tool.execute!(
      { task_id: harness.childTaskId },
      mockToolCallOptions
    )) as { success: boolean };
    expect(firstResult.success).toBe(false);
    await fsPromises.writeFile(worktreeFields.worktreePatchPath, realPatchBytes);

    // HEAD advances before the retry; the caller still pins the original.
    await commitFile(harness.targetRepo, "unrelated.txt", "unrelated\n", "target moved on");

    // The earlier attempt never moved HEAD (no commit series), so the exact
    // expected_head_sha check must still reject the advanced target.
    const retryResult = (await tool.execute!(
      { task_id: harness.childTaskId, expected_head_sha: originalHead },
      mockToolCallOptions
    )) as {
      success: boolean;
      projectResults: Array<{ status: string; error?: string }>;
    };
    expect(retryResult.success).toBe(false);
    expect(retryResult.projectResults[0]?.error).toContain("HEAD");
    expect(
      await fsPromises
        .access(path.join(harness.targetRepo, "wt.txt"))
        .then(() => true)
        .catch(() => false)
    ).toBe(false);

    // Without the pin the fence (an ancestor) still allows completion.
    const completeResult = (await tool.execute!(
      { task_id: harness.childTaskId },
      mockToolCallOptions
    )) as { success: boolean };
    expect(completeResult.success).toBe(true);
    expect(await fsPromises.readFile(path.join(harness.targetRepo, "wt.txt"), "utf-8")).toBe(
      "dirty\n"
    );
  }, 20_000);

  it("honors a partial marker without a timestamp instead of re-running git am", async () => {
    const harness = await setupSingleRepoHarness();

    await commitFile(harness.childRepo, "feature.txt", "feature\n", "child commit");
    const headSha = execSync("git rev-parse HEAD", {
      cwd: harness.childRepo,
      encoding: "utf-8",
    }).trim();
    await fsPromises.writeFile(path.join(harness.childRepo, "extra.txt"), "extra\n", "utf-8");
    const worktreeFields = await writeWorktreePatchFile({
      sessionDir: harness.sessionDir,
      childTaskId: harness.childTaskId,
      storageKey: "project",
      childRepo: harness.childRepo,
    });

    await writePatchArtifact({
      sessionDir: harness.sessionDir,
      workspaceId: harness.currentWorkspaceId,
      childTaskId: harness.childTaskId,
      projectArtifacts: [
        {
          ...(await buildReadyProjectArtifact({
            sessionDir: harness.sessionDir,
            childTaskId: harness.childTaskId,
            storageKey: "project",
            projectPath: harness.targetRepo,
            projectName: "project",
            childRepo: harness.childRepo,
            baseSha: harness.baseSha,
            headSha,
          })),
          hadUncommittedChanges: true,
          ...worktreeFields,
        },
      ],
    });

    const realRuntime = createRuntime({ type: "local", srcBaseDir: "/tmp" });
    const failingRuntime: typeof realRuntime = Object.create(realRuntime, {
      exec: {
        value: (command: string, options: Parameters<typeof realRuntime.exec>[1]) => {
          if (command.includes("git apply --3way --binary")) {
            return Promise.reject(new Error("simulated runtime exec failure"));
          }
          return realRuntime.exec(command, options);
        },
      },
    }) as typeof realRuntime;

    const deps = {
      ...getTestDeps(),
      workspaceId: harness.currentWorkspaceId,
      cwd: harness.targetRepo,
      runtimeTempDir: "/tmp",
      workspaceSessionDir: harness.sessionDir,
    };
    await applyTaskGitPatchArtifact(
      { ...deps, runtime: failingRuntime },
      { task_id: harness.childTaskId, three_way: true },
      {}
    ).catch(() => undefined);
    const artifact = await readSubagentGitPatchArtifact(harness.sessionDir, harness.childTaskId);
    expect(artifact?.projectArtifacts[0]?.appliedPartial).toBe(true);

    // Both applied fields are optional in the persisted schema, so a marker
    // can legally exist without its timestamp; the boolean alone must still
    // route the retry to worktree-only completion.
    const artifactsFilePath = getSubagentGitPatchArtifactsFilePath(harness.sessionDir);
    const rawFile = JSON.parse(await fsPromises.readFile(artifactsFilePath, "utf-8")) as {
      artifactsByChildTaskId: Record<string, { projectArtifacts: Array<Record<string, unknown>> }>;
    };
    delete rawFile.artifactsByChildTaskId[harness.childTaskId]?.projectArtifacts[0]?.appliedAtMs;
    await fsPromises.writeFile(artifactsFilePath, JSON.stringify(rawFile), "utf-8");

    const retryResult = await applyTaskGitPatchArtifact(
      { ...deps, runtime: realRuntime },
      { task_id: harness.childTaskId, three_way: true },
      { allowAlreadyApplied: true }
    );
    expect(retryResult.success).toBe(true);
    expect(retryResult.note).toContain("Completed the earlier partial application");
    // The already-applied commit series was not replayed.
    expect(
      execSync('git log --pretty=%s --grep "child commit"', {
        cwd: harness.targetRepo,
        encoding: "utf-8",
      })
        .trim()
        .split("\n")
    ).toHaveLength(1);
    expect(await fsPromises.readFile(path.join(harness.targetRepo, "extra.txt"), "utf-8")).toBe(
      "extra\n"
    );
    const artifactAfterRetry = await readSubagentGitPatchArtifact(
      harness.sessionDir,
      harness.childTaskId
    );
    expect(artifactAfterRetry?.projectArtifacts[0]?.appliedPartial).toBeUndefined();
  }, 20_000);

  it("refuses to complete a partial application after the target was reset past the recorded HEAD", async () => {
    const harness = await setupSingleRepoHarness();

    await commitFile(harness.childRepo, "feature.txt", "feature\n", "child commit");
    const headSha = execSync("git rev-parse HEAD", {
      cwd: harness.childRepo,
      encoding: "utf-8",
    }).trim();
    // A benign (non-conflicting) worktree change: after a reset it would
    // apply cleanly, which is exactly the false-success scenario the fence
    // must prevent.
    await fsPromises.writeFile(path.join(harness.childRepo, "extra.txt"), "extra\n", "utf-8");
    const worktreeFields = await writeWorktreePatchFile({
      sessionDir: harness.sessionDir,
      childTaskId: harness.childTaskId,
      storageKey: "project",
      childRepo: harness.childRepo,
    });
    await writePatchArtifact({
      sessionDir: harness.sessionDir,
      workspaceId: harness.currentWorkspaceId,
      childTaskId: harness.childTaskId,
      projectArtifacts: [
        {
          ...(await buildReadyProjectArtifact({
            sessionDir: harness.sessionDir,
            childTaskId: harness.childTaskId,
            storageKey: "project",
            projectPath: harness.targetRepo,
            projectName: "project",
            childRepo: harness.childRepo,
            baseSha: harness.baseSha,
            headSha,
          })),
          hadUncommittedChanges: true,
          ...worktreeFields,
        },
      ],
    });
    const preApplyHead = execSync("git rev-parse HEAD", {
      cwd: harness.targetRepo,
      encoding: "utf-8",
    }).trim();

    // The commit series lands, then a simulated runtime failure rejects the
    // worktree apply, leaving a partial marker with the post-am HEAD.
    const realRuntime = createRuntime({ type: "local", srcBaseDir: "/tmp" });
    const failingRuntime: typeof realRuntime = Object.create(realRuntime, {
      exec: {
        value: (command: string, options: Parameters<typeof realRuntime.exec>[1]) => {
          if (command.includes("git apply --3way --binary")) {
            return Promise.reject(new Error("simulated runtime exec failure"));
          }
          return realRuntime.exec(command, options);
        },
      },
    }) as typeof realRuntime;
    const deps = {
      ...getTestDeps(),
      workspaceId: harness.currentWorkspaceId,
      cwd: harness.targetRepo,
      runtimeTempDir: "/tmp",
      workspaceSessionDir: harness.sessionDir,
    };
    let thrownMessage = "";
    try {
      await applyTaskGitPatchArtifact(
        { ...deps, runtime: failingRuntime },
        { task_id: harness.childTaskId, three_way: true },
        {}
      );
    } catch (error) {
      thrownMessage = error instanceof Error ? error.message : String(error);
    }
    expect(thrownMessage).toContain("simulated runtime exec failure");

    // Reset wipes the applied commit series while the marker persists.
    execSync(`git reset --hard ${preApplyHead}`, { cwd: harness.targetRepo, stdio: "ignore" });

    // Without the ancestry fence the retry would apply just extra.txt,
    // clear the marker, and report success while "child commit" is missing.
    const retryResult = await applyTaskGitPatchArtifact(
      { ...deps, runtime: realRuntime },
      { task_id: harness.childTaskId, three_way: true },
      { allowAlreadyApplied: true }
    );
    expect(retryResult.success).toBe(false);
    if (!retryResult.success) {
      expect(retryResult.error).toContain("no longer contains the HEAD");
    }
    const artifact = await readSubagentGitPatchArtifact(harness.sessionDir, harness.childTaskId);
    expect(artifact?.projectArtifacts[0]?.appliedPartial).toBe(true);
    expect(
      execSync("git log --pretty=%s", { cwd: harness.targetRepo, encoding: "utf-8" })
    ).not.toContain("child commit");
  }, 20_000);

  it("clears partial state via acknowledge_partial_recovery after a merged manual resolution", async () => {
    const harness = await setupSingleRepoHarness();

    await commitFile(harness.childRepo, "feature.txt", "feature\n", "child commit");
    const headSha = execSync("git rev-parse HEAD", {
      cwd: harness.childRepo,
      encoding: "utf-8",
    }).trim();
    await fsPromises.writeFile(
      path.join(harness.childRepo, "README.md"),
      "child version\n",
      "utf-8"
    );
    const worktreeFields = await writeWorktreePatchFile({
      sessionDir: harness.sessionDir,
      childTaskId: harness.childTaskId,
      storageKey: "project",
      childRepo: harness.childRepo,
    });
    await commitFile(harness.targetRepo, "README.md", "target version\n", "conflicting change");
    await writePatchArtifact({
      sessionDir: harness.sessionDir,
      workspaceId: harness.currentWorkspaceId,
      childTaskId: harness.childTaskId,
      projectArtifacts: [
        {
          ...(await buildReadyProjectArtifact({
            sessionDir: harness.sessionDir,
            childTaskId: harness.childTaskId,
            storageKey: "project",
            projectPath: harness.targetRepo,
            projectName: "project",
            childRepo: harness.childRepo,
            baseSha: harness.baseSha,
            headSha,
          })),
          hadUncommittedChanges: true,
          ...worktreeFields,
        },
      ],
    });

    const tool = createApplyTool(harness);
    const firstResult = (await tool.execute!(
      { task_id: harness.childTaskId },
      mockToolCallOptions
    )) as { success: boolean };
    expect(firstResult.success).toBe(false);

    // A merged resolution (neither parent nor child content) is not
    // patch-reversible, so the automatic completion cannot recognize it.
    await fsPromises.writeFile(
      path.join(harness.targetRepo, "README.md"),
      "merged: target + child\n",
      "utf-8"
    );
    const blockedRetry = (await tool.execute!(
      { task_id: harness.childTaskId },
      mockToolCallOptions
    )) as { success: boolean };
    expect(blockedRetry.success).toBe(false);

    // The explicit acknowledgement clears the marker without applying.
    const ackResult = (await tool.execute!(
      { task_id: harness.childTaskId, acknowledge_partial_recovery: true },
      mockToolCallOptions
    )) as { success: boolean; projectResults: Array<{ status: string; note?: string }> };
    expect(ackResult.success).toBe(true);
    expect(ackResult.projectResults[0]?.note).toContain("Acknowledged manual recovery");
    // The merged resolution was left untouched and the commit series intact.
    expect(await fsPromises.readFile(path.join(harness.targetRepo, "README.md"), "utf-8")).toBe(
      "merged: target + child\n"
    );
    const artifact = await readSubagentGitPatchArtifact(harness.sessionDir, harness.childTaskId);
    expect(artifact?.projectArtifacts[0]?.appliedPartial).toBeUndefined();
    expect(artifact?.projectArtifacts[0]?.appliedAtMs).toBeDefined();

    // Acknowledging with no partial marker recorded must fail loudly.
    const badAck = (await tool.execute!(
      { task_id: harness.childTaskId, acknowledge_partial_recovery: true, force: true },
      mockToolCallOptions
    )) as { success: boolean; error?: string };
    expect(badAck.success).toBe(false);
    expect(badAck.error).toContain("nothing to acknowledge");
  }, 20_000);

  it("acknowledges a later partial project past an already-applied sibling", async () => {
    const childRepoA = path.join(rootDir, "child-a");
    const childRepoB = path.join(rootDir, "child-b");
    const targetRepoA = path.join(rootDir, "target-a");
    const targetRepoB = path.join(rootDir, "target-b");
    for (const repo of [childRepoA, childRepoB, targetRepoA, targetRepoB]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }
    await commitFile(childRepoA, "README.md", "hello a", "base a");
    await commitFile(childRepoB, "README.md", "hello b", "base b");
    await commitFile(targetRepoA, "README.md", "hello a", "base a");
    await commitFile(targetRepoB, "README.md", "hello b", "base b");
    const baseShaA = execSync("git rev-parse HEAD", { cwd: childRepoA, encoding: "utf-8" }).trim();
    const baseShaB = execSync("git rev-parse HEAD", { cwd: childRepoB, encoding: "utf-8" }).trim();
    await commitFile(childRepoA, "README.md", "hello a\nchild a", "child a change");
    await commitFile(childRepoB, "README.md", "hello b\nchild b", "child b change");
    const headShaA = execSync("git rev-parse HEAD", { cwd: childRepoA, encoding: "utf-8" }).trim();
    const headShaB = execSync("git rev-parse HEAD", { cwd: childRepoB, encoding: "utf-8" }).trim();

    const muxRoot = path.join(rootDir, "mux");
    const currentWorkspaceId = "current-workspace";
    const sessionDir = path.join(muxRoot, "sessions", currentWorkspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await writeWorkspaceConfig({
      muxRoot,
      workspaceId: currentWorkspaceId,
      workspaceName: "current",
      primaryProjectPath: targetRepoA,
      projects: [
        { projectPath: targetRepoA, projectName: "project-a" },
        { projectPath: targetRepoB, projectName: "project-b" },
      ],
    });

    // Project A applied fully (no partial marker); project B's worktree
    // patch failed, leaving a recorded partial.
    const childTaskId = "child-task-ack";
    await writePatchArtifact({
      sessionDir,
      workspaceId: currentWorkspaceId,
      childTaskId,
      projectArtifacts: [
        {
          ...(await buildReadyProjectArtifact({
            sessionDir,
            childTaskId,
            storageKey: "project-a",
            projectPath: targetRepoA,
            projectName: "project-a",
            childRepo: childRepoA,
            baseSha: baseShaA,
            headSha: headShaA,
          })),
          appliedAtMs: Date.now(),
        },
        {
          ...(await buildReadyProjectArtifact({
            sessionDir,
            childTaskId,
            storageKey: "project-b",
            projectPath: targetRepoB,
            projectName: "project-b",
            childRepo: childRepoB,
            baseSha: baseShaB,
            headSha: headShaB,
          })),
          appliedPartial: true,
        },
      ],
    });

    const tool = createTaskApplyGitPatchTool({
      ...getTestDeps(),
      workspaceId: currentWorkspaceId,
      cwd: targetRepoA,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: "/tmp",
      workspaceSessionDir: sessionDir,
    });

    // The all-project acknowledgement must skip the applied sibling and
    // reach project B instead of failing on "nothing to acknowledge".
    const result = (await tool.execute!(
      { task_id: childTaskId, acknowledge_partial_recovery: true },
      mockToolCallOptions
    )) as { success: boolean; projectResults: Array<{ status: string }> };
    expect(result.success).toBe(true);
    expect(result.projectResults.map((projectResult) => projectResult.status)).toEqual([
      "skipped",
      "applied",
    ]);

    const artifact = await readSubagentGitPatchArtifact(sessionDir, childTaskId);
    expect(artifact?.projectArtifacts[1]?.appliedPartial).toBeUndefined();
    expect(artifact?.projectArtifacts[1]?.appliedAtMs).toBeDefined();
  }, 20_000);

  it("applies an untouched project during an acknowledgment sweep", async () => {
    const childRepoA = path.join(rootDir, "sweep-child-a");
    const childRepoB = path.join(rootDir, "sweep-child-b");
    const targetRepoA = path.join(rootDir, "sweep-target-a");
    const targetRepoB = path.join(rootDir, "sweep-target-b");
    for (const repo of [childRepoA, childRepoB, targetRepoA, targetRepoB]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }
    await commitFile(childRepoA, "README.md", "hello a", "base a");
    await commitFile(childRepoB, "README.md", "hello b", "base b");
    await commitFile(targetRepoA, "README.md", "hello a", "base a");
    await commitFile(targetRepoB, "README.md", "hello b", "base b");
    const baseShaA = execSync("git rev-parse HEAD", { cwd: childRepoA, encoding: "utf-8" }).trim();
    const baseShaB = execSync("git rev-parse HEAD", { cwd: childRepoB, encoding: "utf-8" }).trim();
    await commitFile(childRepoA, "README.md", "hello a\nchild a", "child a change");
    await commitFile(childRepoB, "README.md", "hello b\nchild b", "child b change");
    const headShaA = execSync("git rev-parse HEAD", { cwd: childRepoA, encoding: "utf-8" }).trim();
    const headShaB = execSync("git rev-parse HEAD", { cwd: childRepoB, encoding: "utf-8" }).trim();

    const muxRoot = path.join(rootDir, "sweep-mux");
    const currentWorkspaceId = "current-workspace";
    const sessionDir = path.join(muxRoot, "sessions", currentWorkspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await writeWorkspaceConfig({
      muxRoot,
      workspaceId: currentWorkspaceId,
      workspaceName: "current",
      primaryProjectPath: targetRepoA,
      projects: [
        { projectPath: targetRepoA, projectName: "project-a" },
        { projectPath: targetRepoB, projectName: "project-b" },
      ],
    });

    // Project A's earlier attempt left a recorded partial, which stopped the
    // loop before project B was ever attempted.
    const childTaskId = "child-task-sweep";
    await writePatchArtifact({
      sessionDir,
      workspaceId: currentWorkspaceId,
      childTaskId,
      projectArtifacts: [
        {
          ...(await buildReadyProjectArtifact({
            sessionDir,
            childTaskId,
            storageKey: "project-a",
            projectPath: targetRepoA,
            projectName: "project-a",
            childRepo: childRepoA,
            baseSha: baseShaA,
            headSha: headShaA,
          })),
          appliedPartial: true,
        },
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "project-b",
          projectPath: targetRepoB,
          projectName: "project-b",
          childRepo: childRepoB,
          baseSha: baseShaB,
          headSha: headShaB,
        }),
      ],
    });

    const tool = createTaskApplyGitPatchTool({
      ...getTestDeps(),
      workspaceId: currentWorkspaceId,
      cwd: targetRepoA,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: "/tmp",
      workspaceSessionDir: sessionDir,
    });

    // The sweep must acknowledge A and still APPLY the untouched B: skipping
    // B would report success while its entire artifact remains unapplied.
    const result = (await tool.execute!(
      { task_id: childTaskId, acknowledge_partial_recovery: true },
      mockToolCallOptions
    )) as { success: boolean; projectResults: Array<{ status: string; note?: string }> };
    expect(result.success).toBe(true);
    expect(result.projectResults.map((projectResult) => projectResult.status)).toEqual([
      "applied",
      "applied",
    ]);
    expect(result.projectResults[0]?.note).toContain("Acknowledged manual recovery");
    expect(
      execSync('git log --pretty=%s --grep "child b change"', {
        cwd: targetRepoB,
        encoding: "utf-8",
      }).trim()
    ).toBe("child b change");

    const artifact = await readSubagentGitPatchArtifact(sessionDir, childTaskId);
    expect(artifact?.projectArtifacts[0]?.appliedPartial).toBeUndefined();
    expect(artifact?.projectArtifacts[1]?.appliedAtMs).toBeDefined();
  }, 20_000);

  it("acknowledges manual recovery during a partial-completion dry run", async () => {
    const harness = await setupSingleRepoHarness();

    await commitFile(harness.childRepo, "feature.txt", "feature\n", "child commit");
    const headSha = execSync("git rev-parse HEAD", {
      cwd: harness.childRepo,
      encoding: "utf-8",
    }).trim();
    await fsPromises.writeFile(
      path.join(harness.childRepo, "README.md"),
      "child version\n",
      "utf-8"
    );
    const worktreeFields = await writeWorktreePatchFile({
      sessionDir: harness.sessionDir,
      childTaskId: harness.childTaskId,
      storageKey: "project",
      childRepo: harness.childRepo,
    });
    await commitFile(harness.targetRepo, "README.md", "target version\n", "conflicting change");
    await writePatchArtifact({
      sessionDir: harness.sessionDir,
      workspaceId: harness.currentWorkspaceId,
      childTaskId: harness.childTaskId,
      projectArtifacts: [
        {
          ...(await buildReadyProjectArtifact({
            sessionDir: harness.sessionDir,
            childTaskId: harness.childTaskId,
            storageKey: "project",
            projectPath: harness.targetRepo,
            projectName: "project",
            childRepo: harness.childRepo,
            baseSha: harness.baseSha,
            headSha,
          })),
          hadUncommittedChanges: true,
          ...worktreeFields,
        },
      ],
    });

    const tool = createApplyTool(harness);
    const firstResult = (await tool.execute!(
      { task_id: harness.childTaskId },
      mockToolCallOptions
    )) as { success: boolean };
    expect(firstResult.success).toBe(false);

    // Manual recovery without committing: the target now holds the child's
    // content as uncommitted changes.
    await fsPromises.writeFile(
      path.join(harness.targetRepo, "README.md"),
      "child version\n",
      "utf-8"
    );

    // A workflow retry dry-runs first; the reverse check must acknowledge
    // the recovery instead of rejecting the recovered paths as overlap, and
    // a dry run must not clear the marker.
    const dryRunResult = (await tool.execute!(
      { task_id: harness.childTaskId, dry_run: true, three_way: true },
      mockToolCallOptions
    )) as { success: boolean; projectResults: Array<{ status: string; note?: string }> };
    expect(dryRunResult.success).toBe(true);
    expect(dryRunResult.projectResults[0]?.note).toContain("already present in the worktree");
    const artifactAfterDryRun = await readSubagentGitPatchArtifact(
      harness.sessionDir,
      harness.childTaskId
    );
    expect(artifactAfterDryRun?.projectArtifacts[0]?.appliedPartial).toBe(true);

    // The real run then clears the marker.
    const realResult = (await tool.execute!(
      { task_id: harness.childTaskId, three_way: true },
      mockToolCallOptions
    )) as { success: boolean };
    expect(realResult.success).toBe(true);
    const artifactAfterReal = await readSubagentGitPatchArtifact(
      harness.sessionDir,
      harness.childTaskId
    );
    expect(artifactAfterReal?.projectArtifacts[0]?.appliedPartial).toBeUndefined();
  }, 20_000);

  it("completes a fenced partial retry even though git am advanced HEAD past the fence", async () => {
    const harness = await setupSingleRepoHarness();

    await commitFile(harness.childRepo, "feature.txt", "feature\n", "child commit");
    const headSha = execSync("git rev-parse HEAD", {
      cwd: harness.childRepo,
      encoding: "utf-8",
    }).trim();
    await fsPromises.writeFile(
      path.join(harness.childRepo, "README.md"),
      "child version\n",
      "utf-8"
    );
    const worktreeFields = await writeWorktreePatchFile({
      sessionDir: harness.sessionDir,
      childTaskId: harness.childTaskId,
      storageKey: "project",
      childRepo: harness.childRepo,
    });
    await commitFile(harness.targetRepo, "README.md", "target version\n", "conflicting change");
    await writePatchArtifact({
      sessionDir: harness.sessionDir,
      workspaceId: harness.currentWorkspaceId,
      childTaskId: harness.childTaskId,
      projectArtifacts: [
        {
          ...(await buildReadyProjectArtifact({
            sessionDir: harness.sessionDir,
            childTaskId: harness.childTaskId,
            storageKey: "project",
            projectPath: harness.targetRepo,
            projectName: "project",
            childRepo: harness.childRepo,
            baseSha: harness.baseSha,
            headSha,
          })),
          hadUncommittedChanges: true,
          ...worktreeFields,
        },
      ],
    });

    // Fence supplied by replay-safe workflow integrations: the pre-apply HEAD.
    const preApplyHead = execSync("git rev-parse HEAD", {
      cwd: harness.targetRepo,
      encoding: "utf-8",
    }).trim();

    const tool = createApplyTool(harness);
    const firstResult = (await tool.execute!(
      { task_id: harness.childTaskId, three_way: true, expected_head_sha: preApplyHead },
      mockToolCallOptions
    )) as { success: boolean };
    expect(firstResult.success).toBe(false);

    await fsPromises.writeFile(
      path.join(harness.targetRepo, "README.md"),
      "child version\n",
      "utf-8"
    );

    // git am advanced HEAD past the fence; the durable partial marker proves
    // the commit series landed, so the retry must not fail on the stale fence.
    const retryResult = (await tool.execute!(
      { task_id: harness.childTaskId, three_way: true, expected_head_sha: preApplyHead },
      mockToolCallOptions
    )) as { success: boolean; projectResults: Array<{ status: string; note?: string }> };
    expect(retryResult.success).toBe(true);
    expect(retryResult.projectResults[0]?.note).toContain("already present in the worktree");
  }, 20_000);

  it("records target-local partial state when a replayed ancestor artifact partially applies", async () => {
    const childRepo = path.join(rootDir, "child-replay-partial");
    const targetRepo = path.join(rootDir, "target-replay-partial");
    for (const repo of [childRepo, targetRepo]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }
    await commitFile(childRepo, "README.md", "hello", "base");
    await commitFile(targetRepo, "README.md", "hello", "base");
    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await commitFile(childRepo, "feature.txt", "feature\n", "child commit");
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await fsPromises.writeFile(path.join(childRepo, "README.md"), "child version\n", "utf-8");

    const childTaskId = "child-task-replay-partial";
    const muxRoot = path.join(rootDir, "mux-replay-partial");
    const ancestorWorkspaceId = "ancestor-replay-partial";
    const currentWorkspaceId = "current-replay-partial";
    const ancestorSessionDir = path.join(muxRoot, "sessions", ancestorWorkspaceId);
    const currentSessionDir = path.join(muxRoot, "sessions", currentWorkspaceId);
    await fsPromises.mkdir(ancestorSessionDir, { recursive: true });
    await fsPromises.mkdir(currentSessionDir, { recursive: true });

    const worktreeFields = await writeWorktreePatchFile({
      sessionDir: ancestorSessionDir,
      childTaskId,
      storageKey: "target",
      childRepo,
    });
    await writePatchArtifact({
      sessionDir: ancestorSessionDir,
      workspaceId: ancestorWorkspaceId,
      childTaskId,
      projectArtifacts: [
        {
          ...(await buildReadyProjectArtifact({
            sessionDir: ancestorSessionDir,
            childTaskId,
            storageKey: "target",
            projectPath: targetRepo,
            projectName: "target",
            childRepo,
            baseSha,
            headSha,
          })),
          hadUncommittedChanges: true,
          ...worktreeFields,
        },
      ],
    });
    await fsPromises.writeFile(
      path.join(muxRoot, "config.json"),
      JSON.stringify({
        projects: [
          [
            targetRepo,
            {
              workspaces: [
                {
                  path: targetRepo,
                  id: ancestorWorkspaceId,
                  name: "ancestor",
                  runtimeConfig: { type: "local" },
                },
                {
                  path: targetRepo,
                  id: currentWorkspaceId,
                  name: "current",
                  runtimeConfig: { type: "local" },
                  parentWorkspaceId: ancestorWorkspaceId,
                },
              ],
            },
          ],
        ],
      }),
      "utf-8"
    );

    // Conflicting COMMIT keeps the target tree clean, so the dirty preflight
    // passes, git am succeeds, and only the worktree patch fails.
    await commitFile(targetRepo, "README.md", "target version\n", "conflicting change");

    const deps = {
      ...getTestDeps(),
      workspaceId: currentWorkspaceId,
      cwd: targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: "/tmp",
      workspaceSessionDir: currentSessionDir,
    };
    const result = await applyTaskGitPatchArtifact(
      deps,
      { task_id: childTaskId, three_way: true },
      {}
    );
    expect(result.success).toBe(false);
    // The commit series landed on the target.
    expect(execSync("git log -1 --pretty=%s", { cwd: targetRepo, encoding: "utf-8" }).trim()).toBe(
      "child commit"
    );
    // The shared ancestor artifact stays untouched for other replay targets.
    const artifact = await readSubagentGitPatchArtifact(ancestorSessionDir, childTaskId);
    expect(artifact?.projectArtifacts[0]?.appliedAtMs).toBeUndefined();

    // The target-local marker routes the retry to a worktree-only
    // completion (never re-running git am); the conflicting README makes
    // that completion fail here.
    const retryResult = await applyTaskGitPatchArtifact(
      deps,
      { task_id: childTaskId, three_way: true },
      { allowAlreadyApplied: true }
    );
    expect(retryResult.success).toBe(false);
    expect(retryResult.note).toContain("Completing the earlier partial application was blocked");
    expect(
      execSync('git log --pretty=%s --grep "child commit"', {
        cwd: targetRepo,
        encoding: "utf-8",
      })
        .trim()
        .split("\n")
    ).toHaveLength(1);
    // No leftover git am recovery state from the retry.
    expect(
      await fsPromises
        .access(path.join(targetRepo, ".git", "rebase-apply"))
        .then(() => true)
        .catch(() => false)
    ).toBe(false);

    // Manual recovery: the user puts the child's uncommitted content in
    // place. The next retry detects it as already present and clears the
    // target-local marker without touching the shared ancestor artifact.
    await fsPromises.writeFile(path.join(targetRepo, "README.md"), "child version\n", "utf-8");
    const recoveredResult = await applyTaskGitPatchArtifact(
      deps,
      { task_id: childTaskId, three_way: true },
      { allowAlreadyApplied: true }
    );
    expect(recoveredResult.success).toBe(true);
    expect(recoveredResult.note).toContain("already present in the worktree");
    expect(
      await readLocalPatchPartialApply({
        workspaceSessionDir: currentSessionDir,
        childTaskId,
        projectPath: targetRepo,
      })
    ).toBeNull();
    const ancestorArtifact = await readSubagentGitPatchArtifact(ancestorSessionDir, childTaskId);
    expect(ancestorArtifact?.projectArtifacts[0]?.appliedAtMs).toBeUndefined();
  }, 20_000);

  it("clears the pre-apply marker and records completion after a fresh worktree-only replay", async () => {
    const childRepo = path.join(rootDir, "child-replay-wt");
    const targetRepo = path.join(rootDir, "target-replay-wt");
    for (const repo of [childRepo, targetRepo]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }
    await commitFile(childRepo, "README.md", "hello", "base");
    await commitFile(targetRepo, "README.md", "hello", "base");
    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await fsPromises.writeFile(path.join(childRepo, "README.md"), "child version\n", "utf-8");

    const childTaskId = "child-task-replay-wt";
    const muxRoot = path.join(rootDir, "mux-replay-wt");
    const ancestorWorkspaceId = "ancestor-replay-wt";
    const currentWorkspaceId = "current-replay-wt";
    const ancestorSessionDir = path.join(muxRoot, "sessions", ancestorWorkspaceId);
    const currentSessionDir = path.join(muxRoot, "sessions", currentWorkspaceId);
    await fsPromises.mkdir(ancestorSessionDir, { recursive: true });
    await fsPromises.mkdir(currentSessionDir, { recursive: true });

    const worktreeFields = await writeWorktreePatchFile({
      sessionDir: ancestorSessionDir,
      childTaskId,
      storageKey: "target",
      childRepo,
    });
    await writePatchArtifact({
      sessionDir: ancestorSessionDir,
      workspaceId: ancestorWorkspaceId,
      childTaskId,
      projectArtifacts: [
        {
          projectPath: targetRepo,
          projectName: "target",
          storageKey: "target",
          status: "ready",
          commitCount: 0,
          baseCommitSha: baseSha,
          headCommitSha: baseSha,
          hadUncommittedChanges: true,
          ...worktreeFields,
        },
      ],
    });
    await fsPromises.writeFile(
      path.join(muxRoot, "config.json"),
      JSON.stringify({
        projects: [
          [
            targetRepo,
            {
              workspaces: [
                {
                  path: targetRepo,
                  id: ancestorWorkspaceId,
                  name: "ancestor",
                  runtimeConfig: { type: "local" },
                },
                {
                  path: targetRepo,
                  id: currentWorkspaceId,
                  name: "current",
                  runtimeConfig: { type: "local" },
                  parentWorkspaceId: ancestorWorkspaceId,
                },
              ],
            },
          ],
        ],
      }),
      "utf-8"
    );

    const deps = {
      ...getTestDeps(),
      workspaceId: currentWorkspaceId,
      cwd: targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: "/tmp",
      workspaceSessionDir: currentSessionDir,
    };
    const result = await applyTaskGitPatchArtifact(
      deps,
      { task_id: childTaskId, three_way: true },
      {}
    );
    expect(result.success).toBe(true);
    expect(await fsPromises.readFile(path.join(targetRepo, "README.md"), "utf-8")).toBe(
      "child version\n"
    );

    // Success must not leave the pre-apply marker behind: a later retry
    // would treat the finished apply as an unrecovered partial.
    expect(
      await readLocalPatchPartialApply({
        workspaceSessionDir: currentSessionDir,
        childTaskId,
        projectPath: targetRepo,
      })
    ).toBeNull();
    const completion = await readLocalPatchApplyCompletion({
      workspaceSessionDir: currentSessionDir,
      childTaskId,
      projectPath: targetRepo,
    });
    expect(completion?.appliedAtMs).toBeGreaterThan(0);

    // The applied file may be edited afterwards; a workflow retry must read
    // the completion record and report already-applied instead of routing
    // to partial recovery against the edited content.
    await fsPromises.writeFile(path.join(targetRepo, "README.md"), "user edited\n", "utf-8");
    const retryResult = await applyTaskGitPatchArtifact(
      deps,
      { task_id: childTaskId, three_way: true },
      { allowAlreadyApplied: true }
    );
    expect(retryResult.success).toBe(true);
    expect(retryResult.note).toContain("already applied");
    expect(await fsPromises.readFile(path.join(targetRepo, "README.md"), "utf-8")).toBe(
      "user edited\n"
    );
  }, 20_000);

  it("skips a replay-completed sibling during an acknowledgment sweep", async () => {
    const childRepoA = path.join(rootDir, "replay-sweep-child-a");
    const childRepoB = path.join(rootDir, "replay-sweep-child-b");
    const targetRepoA = path.join(rootDir, "replay-sweep-target-a");
    const targetRepoB = path.join(rootDir, "replay-sweep-target-b");
    for (const repo of [childRepoA, childRepoB, targetRepoA, targetRepoB]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }
    await commitFile(childRepoA, "README.md", "hello a", "base a");
    await commitFile(childRepoB, "README.md", "hello b", "base b");
    await commitFile(targetRepoA, "README.md", "hello a", "base a");
    await commitFile(targetRepoB, "README.md", "hello b", "base b");
    const baseShaA = execSync("git rev-parse HEAD", { cwd: childRepoA, encoding: "utf-8" }).trim();
    const baseShaB = execSync("git rev-parse HEAD", { cwd: childRepoB, encoding: "utf-8" }).trim();
    await commitFile(childRepoA, "feature-a.txt", "feature a\n", "child a change");
    await commitFile(childRepoB, "feature-b.txt", "feature b\n", "child b change");
    const headShaA = execSync("git rev-parse HEAD", { cwd: childRepoA, encoding: "utf-8" }).trim();
    const headShaB = execSync("git rev-parse HEAD", { cwd: childRepoB, encoding: "utf-8" }).trim();
    // Only child B ends dirty; its conflicting target commit later fails the
    // worktree patch after B's commit series lands.
    await fsPromises.writeFile(path.join(childRepoB, "README.md"), "child version\n", "utf-8");

    const childTaskId = "child-task-replay-sweep";
    const muxRoot = path.join(rootDir, "mux-replay-sweep");
    const ancestorWorkspaceId = "ancestor-replay-sweep";
    const currentWorkspaceId = "current-replay-sweep";
    const ancestorSessionDir = path.join(muxRoot, "sessions", ancestorWorkspaceId);
    const currentSessionDir = path.join(muxRoot, "sessions", currentWorkspaceId);
    await fsPromises.mkdir(ancestorSessionDir, { recursive: true });
    await fsPromises.mkdir(currentSessionDir, { recursive: true });

    const worktreeFieldsB = await writeWorktreePatchFile({
      sessionDir: ancestorSessionDir,
      childTaskId,
      storageKey: "target-b",
      childRepo: childRepoB,
    });
    await writePatchArtifact({
      sessionDir: ancestorSessionDir,
      workspaceId: ancestorWorkspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir: ancestorSessionDir,
          childTaskId,
          storageKey: "target-a",
          projectPath: targetRepoA,
          projectName: "target-a",
          childRepo: childRepoA,
          baseSha: baseShaA,
          headSha: headShaA,
        }),
        {
          ...(await buildReadyProjectArtifact({
            sessionDir: ancestorSessionDir,
            childTaskId,
            storageKey: "target-b",
            projectPath: targetRepoB,
            projectName: "target-b",
            childRepo: childRepoB,
            baseSha: baseShaB,
            headSha: headShaB,
          })),
          hadUncommittedChanges: true,
          ...worktreeFieldsB,
        },
      ],
    });
    const workspaceProjects = [
      { projectPath: targetRepoA, projectName: "target-a" },
      { projectPath: targetRepoB, projectName: "target-b" },
    ];
    await fsPromises.writeFile(
      path.join(muxRoot, "config.json"),
      JSON.stringify({
        projects: [
          [
            targetRepoA,
            {
              workspaces: [
                {
                  path: targetRepoA,
                  id: ancestorWorkspaceId,
                  name: "ancestor",
                  runtimeConfig: { type: "local" },
                  projects: workspaceProjects,
                },
                {
                  path: targetRepoA,
                  id: currentWorkspaceId,
                  name: "current",
                  runtimeConfig: { type: "local" },
                  parentWorkspaceId: ancestorWorkspaceId,
                  projects: workspaceProjects,
                },
              ],
            },
          ],
        ],
      }),
      "utf-8"
    );

    // Conflicting COMMIT in target B keeps its tree clean (dirty preflight
    // passes), so B's git am succeeds and only its worktree patch fails.
    await commitFile(targetRepoB, "README.md", "target version\n", "conflicting change");

    const deps = {
      ...getTestDeps(),
      workspaceId: currentWorkspaceId,
      cwd: targetRepoA,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: "/tmp",
      workspaceSessionDir: currentSessionDir,
    };
    // First replay pass: A applies fully, B ends partial (commits landed,
    // worktree patch failed).
    const firstResult = await applyTaskGitPatchArtifact(
      deps,
      { task_id: childTaskId, three_way: true },
      {}
    );
    expect(firstResult.success).toBe(false);
    expect(execSync("git log -1 --pretty=%s", { cwd: targetRepoA, encoding: "utf-8" }).trim()).toBe(
      "child a change"
    );

    // The sweep must recognize A as applied via its target-local completion
    // record (the shared ancestor artifact never records replay applies) and
    // acknowledge only B; re-attempting A would fail or duplicate its series.
    const ackResult = await applyTaskGitPatchArtifact(
      deps,
      { task_id: childTaskId, three_way: true, acknowledge_partial_recovery: true },
      {}
    );
    expect(ackResult.success).toBe(true);
    expect(ackResult.projectResults?.map((projectResult) => projectResult.status)).toEqual([
      "skipped",
      "applied",
    ]);
    expect(
      execSync('git log --pretty=%s --grep "child a change"', {
        cwd: targetRepoA,
        encoding: "utf-8",
      })
        .trim()
        .split("\n")
    ).toHaveLength(1);
    expect(
      await readLocalPatchPartialApply({
        workspaceSessionDir: currentSessionDir,
        childTaskId,
        projectPath: targetRepoB,
      })
    ).toBeNull();
    // The shared ancestor artifact stays untouched for other replay targets.
    const ancestorArtifact = await readSubagentGitPatchArtifact(ancestorSessionDir, childTaskId);
    expect(ancestorArtifact?.projectArtifacts[0]?.appliedAtMs).toBeUndefined();
    expect(ancestorArtifact?.projectArtifacts[1]?.appliedAtMs).toBeUndefined();
  }, 20_000);

  it("honors replay completion records on ordinary retries and fails closed when unreadable", async () => {
    const childRepo = path.join(rootDir, "child-replay-retry");
    const targetRepo = path.join(rootDir, "target-replay-retry");
    for (const repo of [childRepo, targetRepo]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }
    await commitFile(childRepo, "README.md", "hello", "base");
    await commitFile(targetRepo, "README.md", "hello", "base");
    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await commitFile(childRepo, "feature.txt", "feature\n", "child commit");
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const childTaskId = "child-task-replay-retry";
    const muxRoot = path.join(rootDir, "mux-replay-retry");
    const ancestorWorkspaceId = "ancestor-replay-retry";
    const currentWorkspaceId = "current-replay-retry";
    const ancestorSessionDir = path.join(muxRoot, "sessions", ancestorWorkspaceId);
    const currentSessionDir = path.join(muxRoot, "sessions", currentWorkspaceId);
    await fsPromises.mkdir(ancestorSessionDir, { recursive: true });
    await fsPromises.mkdir(currentSessionDir, { recursive: true });

    await writePatchArtifact({
      sessionDir: ancestorSessionDir,
      workspaceId: ancestorWorkspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir: ancestorSessionDir,
          childTaskId,
          storageKey: "target",
          projectPath: targetRepo,
          projectName: "target",
          childRepo,
          baseSha,
          headSha,
        }),
      ],
    });
    await fsPromises.writeFile(
      path.join(muxRoot, "config.json"),
      JSON.stringify({
        projects: [
          [
            targetRepo,
            {
              workspaces: [
                {
                  path: targetRepo,
                  id: ancestorWorkspaceId,
                  name: "ancestor",
                  runtimeConfig: { type: "local" },
                },
                {
                  path: targetRepo,
                  id: currentWorkspaceId,
                  name: "current",
                  runtimeConfig: { type: "local" },
                  parentWorkspaceId: ancestorWorkspaceId,
                },
              ],
            },
          ],
        ],
      }),
      "utf-8"
    );

    const deps = {
      ...getTestDeps(),
      workspaceId: currentWorkspaceId,
      cwd: targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: "/tmp",
      workspaceSessionDir: currentSessionDir,
    };
    const appliedCount = () =>
      execSync('git log --pretty=%s --grep "child commit"', {
        cwd: targetRepo,
        encoding: "utf-8",
      })
        .trim()
        .split("\n")
        .filter((line) => line.length > 0).length;

    const firstResult = await applyTaskGitPatchArtifact(
      deps,
      { task_id: childTaskId, three_way: true },
      {}
    );
    expect(firstResult.success).toBe(true);
    expect(appliedCount()).toBe(1);

    // A crash-before-checkpoint workflow retry must see the target-local
    // completion instead of replaying the mbox.
    const workflowRetry = await applyTaskGitPatchArtifact(
      deps,
      { task_id: childTaskId, three_way: true },
      { allowAlreadyApplied: true }
    );
    expect(workflowRetry.success).toBe(true);
    expect(workflowRetry.projectResults?.[0]?.note).toContain("already applied");
    expect(appliedCount()).toBe(1);

    const plainRetry = await applyTaskGitPatchArtifact(
      deps,
      { task_id: childTaskId, three_way: true },
      {}
    );
    expect(plainRetry.success).toBe(false);
    expect(plainRetry.projectResults?.[0]?.error).toContain("already applied");
    expect(appliedCount()).toBe(1);

    // Corrupt the completion record: it must degrade to unknown and fail
    // closed instead of proving (or disproving) the earlier application.
    const localStatePath = path.join(currentSessionDir, "subagent-patches-local-apply.json");
    const localState = JSON.parse(await fsPromises.readFile(localStatePath, "utf-8")) as {
      completionsByChildTaskId: Record<string, Record<string, unknown>>;
    };
    localState.completionsByChildTaskId[childTaskId] = { [targetRepo]: {} };
    await fsPromises.writeFile(localStatePath, JSON.stringify(localState), "utf-8");

    const corruptedRetry = await applyTaskGitPatchArtifact(
      deps,
      { task_id: childTaskId, three_way: true },
      { allowAlreadyApplied: true }
    );
    expect(corruptedRetry.success).toBe(false);
    expect(corruptedRetry.projectResults?.[0]?.error).toContain("unreadable");
    expect(appliedCount()).toBe(1);

    // The user verifies the work landed and acknowledges, restoring a valid
    // completion record.
    const ackResult = await applyTaskGitPatchArtifact(
      deps,
      { task_id: childTaskId, three_way: true, acknowledge_partial_recovery: true },
      {}
    );
    expect(ackResult.success).toBe(true);
    const afterAckRetry = await applyTaskGitPatchArtifact(
      deps,
      { task_id: childTaskId, three_way: true },
      { allowAlreadyApplied: true }
    );
    expect(afterAckRetry.success).toBe(true);
    expect(afterAckRetry.projectResults?.[0]?.note).toContain("already applied");
    expect(appliedCount()).toBe(1);
  }, 20_000);

  it("fails a replay-safe retry when the target was reset after the recorded completion", async () => {
    const childRepo = path.join(rootDir, "child-replay-reset");
    const targetRepo = path.join(rootDir, "target-replay-reset");
    for (const repo of [childRepo, targetRepo]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }
    await commitFile(childRepo, "README.md", "hello", "base");
    await commitFile(targetRepo, "README.md", "hello", "base");
    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    const targetBaseSha = execSync("git rev-parse HEAD", {
      cwd: targetRepo,
      encoding: "utf-8",
    }).trim();
    await commitFile(childRepo, "feature.txt", "feature\n", "child commit");
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const childTaskId = "child-task-replay-reset";
    const muxRoot = path.join(rootDir, "mux-replay-reset");
    const ancestorWorkspaceId = "ancestor-replay-reset";
    const currentWorkspaceId = "current-replay-reset";
    const ancestorSessionDir = path.join(muxRoot, "sessions", ancestorWorkspaceId);
    const currentSessionDir = path.join(muxRoot, "sessions", currentWorkspaceId);
    await fsPromises.mkdir(ancestorSessionDir, { recursive: true });
    await fsPromises.mkdir(currentSessionDir, { recursive: true });

    await writePatchArtifact({
      sessionDir: ancestorSessionDir,
      workspaceId: ancestorWorkspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir: ancestorSessionDir,
          childTaskId,
          storageKey: "target",
          projectPath: targetRepo,
          projectName: "target",
          childRepo,
          baseSha,
          headSha,
        }),
      ],
    });
    await fsPromises.writeFile(
      path.join(muxRoot, "config.json"),
      JSON.stringify({
        projects: [
          [
            targetRepo,
            {
              workspaces: [
                {
                  path: targetRepo,
                  id: ancestorWorkspaceId,
                  name: "ancestor",
                  runtimeConfig: { type: "local" },
                },
                {
                  path: targetRepo,
                  id: currentWorkspaceId,
                  name: "current",
                  runtimeConfig: { type: "local" },
                  parentWorkspaceId: ancestorWorkspaceId,
                },
              ],
            },
          ],
        ],
      }),
      "utf-8"
    );

    const deps = {
      ...getTestDeps(),
      workspaceId: currentWorkspaceId,
      cwd: targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: "/tmp",
      workspaceSessionDir: currentSessionDir,
    };

    const firstResult = await applyTaskGitPatchArtifact(
      deps,
      { task_id: childTaskId, three_way: true },
      {}
    );
    expect(firstResult.success).toBe(true);

    // A crash-before-checkpoint retry after the target was reset must not
    // let the workflow checkpoint past the now-missing commit series.
    execSync(`git reset --hard ${targetBaseSha}`, { cwd: targetRepo, stdio: "ignore" });
    const staleRetry = await applyTaskGitPatchArtifact(
      deps,
      { task_id: childTaskId, three_way: true },
      { allowAlreadyApplied: true }
    );
    expect(staleRetry.success).toBe(false);
    expect(staleRetry.projectResults?.[0]?.error).toContain(
      "no longer contains the recorded post-apply HEAD"
    );
  }, 20_000);

  it("applies nothing when an acknowledgment sweep has nothing to acknowledge", async () => {
    const harness = await setupSingleRepoHarness();

    await commitFile(harness.childRepo, "feature.txt", "feature\n", "child commit");
    const headSha = execSync("git rev-parse HEAD", {
      cwd: harness.childRepo,
      encoding: "utf-8",
    }).trim();
    await writePatchArtifact({
      sessionDir: harness.sessionDir,
      workspaceId: harness.currentWorkspaceId,
      childTaskId: harness.childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir: harness.sessionDir,
          childTaskId: harness.childTaskId,
          storageKey: "project",
          projectPath: harness.targetRepo,
          projectName: "project",
          childRepo: harness.childRepo,
          baseSha: harness.baseSha,
          headSha,
        }),
      ],
    });

    // A mistaken acknowledge flag with no recorded partial anywhere must
    // fail before any repository is modified, not after applying projects.
    const tool = createApplyTool(harness);
    const result = (await tool.execute!(
      { task_id: harness.childTaskId, acknowledge_partial_recovery: true },
      mockToolCallOptions
    )) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain("nothing to acknowledge");
    expect(
      execSync('git log --pretty=%s --grep "child commit"', {
        cwd: harness.targetRepo,
        encoding: "utf-8",
      }).trim()
    ).toBe("");
    const artifact = await readSubagentGitPatchArtifact(harness.sessionDir, harness.childTaskId);
    expect(artifact?.projectArtifacts[0]?.appliedAtMs).toBeUndefined();
  }, 20_000);

  it("propagates a failure to persist the partial-apply marker", async () => {
    // A FILE at the session-dir path makes the state write fail.
    const blockedSessionDir = path.join(rootDir, "blocked-session-dir");
    await fsPromises.writeFile(blockedSessionDir, "not a dir", "utf-8");

    let thrownMessage = "";
    try {
      await setLocalPatchPartialApply({
        workspaceId: "ws-propagate",
        workspaceSessionDir: blockedSessionDir,
        childTaskId: "task-propagate",
        projectPath: "/repo",
        record: { appliedAtMs: Date.now() },
      });
    } catch (error) {
      thrownMessage = error instanceof Error ? error.message : String(error);
    }
    // Setting the marker must fail loudly: a silently missing marker lets a
    // retry replay the already-applied commit series.
    expect(thrownMessage).toContain("Could not persist partial-application state");

    // A completion write must fail loudly too: swallowing it would report
    // success while the durable state still says partial.
    thrownMessage = "";
    try {
      await setLocalPatchPartialApply({
        workspaceId: "ws-propagate",
        workspaceSessionDir: blockedSessionDir,
        childTaskId: "task-propagate",
        projectPath: "/repo",
        record: null,
        completedAtMs: Date.now(),
      });
    } catch (error) {
      thrownMessage = error instanceof Error ? error.message : String(error);
    }
    expect(thrownMessage).toContain("Could not persist partial-application state");

    // A bare clear stays best-effort: a stale marker is fail-closed.
    await setLocalPatchPartialApply({
      workspaceId: "ws-propagate",
      workspaceSessionDir: blockedSessionDir,
      childTaskId: "task-propagate",
      projectPath: "/repo",
      record: null,
    });
  });

  it("rejects dirty target paths overlapping the worktree patch before applying anything", async () => {
    const harness = await setupSingleRepoHarness();

    await commitFile(harness.childRepo, "feature.txt", "feature\n", "child commit");
    const headSha = execSync("git rev-parse HEAD", {
      cwd: harness.childRepo,
      encoding: "utf-8",
    }).trim();
    await fsPromises.writeFile(
      path.join(harness.childRepo, "README.md"),
      "child version\n",
      "utf-8"
    );
    const worktreeFields = await writeWorktreePatchFile({
      sessionDir: harness.sessionDir,
      childTaskId: harness.childTaskId,
      storageKey: "project",
      childRepo: harness.childRepo,
    });

    // Uncommitted local edit on a path the worktree patch touches.
    await fsPromises.writeFile(path.join(harness.targetRepo, "README.md"), "local edit\n", "utf-8");

    await writePatchArtifact({
      sessionDir: harness.sessionDir,
      workspaceId: harness.currentWorkspaceId,
      childTaskId: harness.childTaskId,
      projectArtifacts: [
        {
          ...(await buildReadyProjectArtifact({
            sessionDir: harness.sessionDir,
            childTaskId: harness.childTaskId,
            storageKey: "project",
            projectPath: harness.targetRepo,
            projectName: "project",
            childRepo: harness.childRepo,
            baseSha: harness.baseSha,
            headSha,
          })),
          hadUncommittedChanges: true,
          ...worktreeFields,
        },
      ],
    });

    const tool = createApplyTool(harness);

    for (const dryRun of [true, false]) {
      const result = (await tool.execute!(
        { task_id: harness.childTaskId, dry_run: dryRun },
        mockToolCallOptions
      )) as {
        success: boolean;
        projectResults: Array<{ status: string; error?: string; conflictPaths?: string[] }>;
      };

      expect(result.success).toBe(false);
      expect(result.projectResults[0]?.conflictPaths).toEqual(["README.md"]);
      // Nothing was applied: the failure happened before git am could advance HEAD.
      expect(
        execSync("git log -1 --pretty=%s", { cwd: harness.targetRepo, encoding: "utf-8" }).trim()
      ).toBe("base");
    }
    const artifact = await readSubagentGitPatchArtifact(harness.sessionDir, harness.childTaskId);
    expect(artifact?.projectArtifacts[0]?.appliedAtMs).toBeUndefined();
  }, 20_000);

  it("rejects a worktree-only dry run when the target has overlapping local changes", async () => {
    const harness = await setupSingleRepoHarness();

    await fsPromises.writeFile(
      path.join(harness.childRepo, "README.md"),
      "child version\n",
      "utf-8"
    );
    const worktreeFields = await writeWorktreePatchFile({
      sessionDir: harness.sessionDir,
      childTaskId: harness.childTaskId,
      storageKey: "project",
      childRepo: harness.childRepo,
    });

    await fsPromises.writeFile(path.join(harness.targetRepo, "README.md"), "local edit\n", "utf-8");

    await writePatchArtifact({
      sessionDir: harness.sessionDir,
      workspaceId: harness.currentWorkspaceId,
      childTaskId: harness.childTaskId,
      projectArtifacts: [
        {
          projectPath: harness.targetRepo,
          projectName: "project",
          storageKey: "project",
          status: "ready",
          commitCount: 0,
          hadUncommittedChanges: true,
          ...worktreeFields,
        },
      ],
    });

    const tool = createApplyTool(harness);

    const result = (await tool.execute!(
      { task_id: harness.childTaskId, dry_run: true },
      mockToolCallOptions
    )) as {
      success: boolean;
      projectResults: Array<{ status: string; conflictPaths?: string[] }>;
    };

    expect(result.success).toBe(false);
    expect(result.projectResults[0]?.conflictPaths).toEqual(["README.md"]);
    // The local edit stays untouched.
    expect(await fsPromises.readFile(path.join(harness.targetRepo, "README.md"), "utf-8")).toBe(
      "local edit\n"
    );
  }, 20_000);

  it("treats dirty copy destinations as overlapping worktree patch paths", async () => {
    const harness = await setupSingleRepoHarness();

    // Identical source content in both repos so the copy patch's pre-image
    // blob exists at the target.
    const sourceBase = "line1\nline2\nline3\nline4\n";
    for (const repo of [harness.childRepo, harness.targetRepo]) {
      await fsPromises.writeFile(path.join(repo, "é src.txt"), sourceBase, "utf-8");
      execSync("git add -A", { cwd: repo, stdio: "ignore" });
      execSync('git commit -m "add source"', { cwd: repo, stdio: "ignore" });
    }

    // Copy detection needs the source modified alongside the copy; the child
    // copies the quoted-name source to an unquoted destination.
    execSync("git config diff.renames copies", { cwd: harness.childRepo, stdio: "ignore" });
    await fsPromises.writeFile(
      path.join(harness.childRepo, "é src.txt"),
      `${sourceBase}line5\n`,
      "utf-8"
    );
    await fsPromises.writeFile(
      path.join(harness.childRepo, "copied dest.txt"),
      `${sourceBase}line5\n`,
      "utf-8"
    );
    const worktreeFields = await writeWorktreePatchFile({
      sessionDir: harness.sessionDir,
      childTaskId: harness.childTaskId,
      storageKey: "project",
      childRepo: harness.childRepo,
    });
    // Fixture guard: the patch must carry the quoted-source copy record.
    const patchText = await fsPromises.readFile(worktreeFields.worktreePatchPath, "utf-8");
    expect(patchText).toContain("copy to copied dest.txt");
    expect(patchText).toContain('copy from "');

    await writePatchArtifact({
      sessionDir: harness.sessionDir,
      workspaceId: harness.currentWorkspaceId,
      childTaskId: harness.childTaskId,
      projectArtifacts: [
        {
          projectPath: harness.targetRepo,
          projectName: "project",
          storageKey: "project",
          status: "ready",
          commitCount: 0,
          hadUncommittedChanges: true,
          ...worktreeFields,
        },
      ],
    });

    // Dirty (untracked) copy destination at the target.
    await fsPromises.writeFile(
      path.join(harness.targetRepo, "copied dest.txt"),
      "local content\n",
      "utf-8"
    );

    const tool = createApplyTool(harness);

    const result = (await tool.execute!(
      { task_id: harness.childTaskId, dry_run: true },
      mockToolCallOptions
    )) as {
      success: boolean;
      projectResults: Array<{ status: string; conflictPaths?: string[] }>;
    };

    expect(result.success).toBe(false);
    expect(result.projectResults[0]?.conflictPaths).toEqual(["copied dest.txt"]);
    expect(
      await fsPromises.readFile(path.join(harness.targetRepo, "copied dest.txt"), "utf-8")
    ).toBe("local content\n");
  }, 20_000);

  it("reports uncaptured uncommitted changes when the artifact records a skip reason", async () => {
    const harness = await setupSingleRepoHarness();

    await writePatchArtifact({
      sessionDir: harness.sessionDir,
      workspaceId: harness.currentWorkspaceId,
      childTaskId: harness.childTaskId,
      projectArtifacts: [
        {
          projectPath: harness.targetRepo,
          projectName: "project",
          storageKey: "project",
          status: "skipped",
          commitCount: 0,
          hadUncommittedChanges: true,
          worktreePatchSkippedReason: "diff exceeded the capture cap",
        },
      ],
    });

    const tool = createApplyTool(harness);

    const result = (await tool.execute!({ task_id: harness.childTaskId }, mockToolCallOptions)) as {
      success: boolean;
      projectResults: Array<{ status: string; note?: string }>;
    };

    expect(result.success).toBe(false);
    expect(result.projectResults[0]?.note).toContain("diff exceeded the capture cap");
  }, 20_000);

  it("rejects a commit apply that would omit uncaptured changes until acknowledged", async () => {
    const harness = await setupSingleRepoHarness();

    await commitFile(harness.childRepo, "feature.txt", "feature\n", "child commit");
    const headSha = execSync("git rev-parse HEAD", {
      cwd: harness.childRepo,
      encoding: "utf-8",
    }).trim();

    await writePatchArtifact({
      sessionDir: harness.sessionDir,
      workspaceId: harness.currentWorkspaceId,
      childTaskId: harness.childTaskId,
      projectArtifacts: [
        {
          ...(await buildReadyProjectArtifact({
            sessionDir: harness.sessionDir,
            childTaskId: harness.childTaskId,
            storageKey: "project",
            projectPath: harness.targetRepo,
            projectName: "project",
            childRepo: harness.childRepo,
            baseSha: harness.baseSha,
            headSha,
          })),
          hadUncommittedChanges: true,
          worktreePatchSkippedReason: "diff exceeded the capture cap",
        },
      ],
    });

    const tool = createApplyTool(harness);

    // Success would let a workflow checkpoint past the uncaptured work; the
    // dry run must predict the same failure.
    for (const dryRun of [true, false]) {
      const result = (await tool.execute!(
        { task_id: harness.childTaskId, dry_run: dryRun },
        mockToolCallOptions
      )) as {
        success: boolean;
        projectResults: Array<{ status: string; error?: string }>;
      };
      expect(result.success).toBe(false);
      expect(result.projectResults[0]?.error).toContain("diff exceeded the capture cap");
      expect(result.projectResults[0]?.error).toContain("silently omit");
    }
    expect(
      execSync("git log -1 --pretty=%s", { cwd: harness.targetRepo, encoding: "utf-8" }).trim()
    ).toBe("base");

    const acknowledgedResult = (await tool.execute!(
      { task_id: harness.childTaskId, acknowledge_uncaptured_changes: true },
      mockToolCallOptions
    )) as {
      success: boolean;
      projectResults: Array<{ status: string; note?: string }>;
    };
    expect(acknowledgedResult.success).toBe(true);
    expect(acknowledgedResult.projectResults[0]?.status).toBe("applied");
    // The warning survives acknowledged applies.
    expect(acknowledgedResult.projectResults[0]?.note).toContain("diff exceeded the capture cap");
    expect(
      execSync("git log -1 --pretty=%s", { cwd: harness.targetRepo, encoding: "utf-8" }).trim()
    ).toBe("child commit");
  }, 20_000);
});
