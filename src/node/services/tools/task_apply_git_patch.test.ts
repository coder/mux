import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execSync } from "node:child_process";

import type { ToolExecutionOptions } from "ai";

import { createTaskApplyGitPatchTool } from "@/node/services/tools/task_apply_git_patch";
import {
  getSubagentGitPatchArtifactsFilePath,
  getSubagentGitPatchMboxPath,
  readSubagentGitPatchArtifact,
  upsertSubagentGitPatchArtifact,
} from "@/node/services/subagentGitPatchArtifacts";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { getTestDeps } from "@/node/services/tools/testHelpers";

const mockToolCallOptions: ToolExecutionOptions = {
  toolCallId: "test-call-id",
  messages: [],
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
}) {
  const patchPath = getSubagentGitPatchMboxPath(
    params.sessionDir,
    params.childTaskId,
    params.storageKey
  );
  const patch = execSync(
    `git format-patch --stdout --binary ${params.baseSha}..${params.headSha}`,
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
  projectArtifacts: Array<
    | Awaited<ReturnType<typeof buildReadyProjectArtifact>>
    | {
        projectPath: string;
        projectName: string;
        storageKey: string;
        status: "skipped" | "failed";
        error?: string;
        commitCount?: number;
      }
  >;
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
