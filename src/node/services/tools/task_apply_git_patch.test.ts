import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execSync } from "node:child_process";

import type { ToolCallOptions } from "ai";

import { createTaskApplyGitPatchTool } from "@/node/services/tools/task_apply_git_patch";
import {
  getSubagentGitPatchMboxPath,
  readSubagentGitPatchArtifact,
  upsertSubagentGitPatchArtifact,
} from "@/node/services/subagentGitPatchArtifacts";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { getTestDeps } from "@/node/services/tools/testHelpers";

const mockToolCallOptions: ToolCallOptions = {
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

describe("task_apply_git_patch tool", () => {
  let rootDir: string;
  let childRepo: string;
  let targetRepo: string;
  let sessionDir: string;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-task-apply-git-patch-"));
    childRepo = path.join(rootDir, "child");
    targetRepo = path.join(rootDir, "target");
    sessionDir = path.join(rootDir, "session");

    await fsPromises.mkdir(childRepo, { recursive: true });
    await fsPromises.mkdir(targetRepo, { recursive: true });
    await fsPromises.mkdir(sessionDir, { recursive: true });
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  it("applies a ready patch artifact via git am and marks it applied", async () => {
    initGitRepo(childRepo);
    initGitRepo(targetRepo);

    // Both repos start from the same base content so the patch applies cleanly.
    await commitFile(childRepo, "README.md", "hello", "base");
    await commitFile(targetRepo, "README.md", "hello", "base");

    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    await commitFile(childRepo, "README.md", "hello\nworld", "child change");
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const childTaskId = "child-task-1";
    const workspaceId = getTestDeps().workspaceId;

    const patchPath = getSubagentGitPatchMboxPath(sessionDir, childTaskId);
    const patch = execSync(`git format-patch --stdout --binary ${baseSha}..${headSha}`, {
      cwd: childRepo,
      encoding: "buffer",
    });

    await fsPromises.mkdir(path.dirname(patchPath), { recursive: true });
    await fsPromises.writeFile(patchPath, patch);

    await upsertSubagentGitPatchArtifact({
      workspaceId,
      workspaceSessionDir: sessionDir,
      childTaskId,
      updater: () => ({
        childTaskId,
        parentWorkspaceId: workspaceId,
        createdAtMs: Date.now(),
        status: "ready",
        baseCommitSha: baseSha,
        headCommitSha: headSha,
        commitCount: 1,
        mboxPath: patchPath,
      }),
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
      error?: string;
    };

    expect(result.success).toBe(true);
    expect(execSync("git log -1 --pretty=%s", { cwd: targetRepo, encoding: "utf-8" }).trim()).toBe(
      "child change"
    );

    const artifact = await readSubagentGitPatchArtifact(sessionDir, childTaskId);
    expect(artifact?.appliedAtMs).toBeTruthy();
  }, 20_000);

  it("supports dry_run without changing the repo or marking applied", async () => {
    initGitRepo(childRepo);
    initGitRepo(targetRepo);

    await commitFile(childRepo, "README.md", "hello", "base");
    await commitFile(targetRepo, "README.md", "hello", "base");

    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    await commitFile(childRepo, "README.md", "hello\nworld", "child change");
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const childTaskId = "child-task-1";
    const workspaceId = getTestDeps().workspaceId;

    const patchPath = getSubagentGitPatchMboxPath(sessionDir, childTaskId);
    const patch = execSync(`git format-patch --stdout --binary ${baseSha}..${headSha}`, {
      cwd: childRepo,
      encoding: "buffer",
    });

    await fsPromises.mkdir(path.dirname(patchPath), { recursive: true });
    await fsPromises.writeFile(patchPath, patch);

    await upsertSubagentGitPatchArtifact({
      workspaceId,
      workspaceSessionDir: sessionDir,
      childTaskId,
      updater: () => ({
        childTaskId,
        parentWorkspaceId: workspaceId,
        createdAtMs: Date.now(),
        status: "ready",
        baseCommitSha: baseSha,
        headCommitSha: headSha,
        commitCount: 1,
        mboxPath: patchPath,
      }),
    });

    const tool = createTaskApplyGitPatchTool({
      ...getTestDeps(),
      cwd: targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: "/tmp",
      workspaceSessionDir: sessionDir,
    });

    const result = (await tool.execute!(
      { task_id: childTaskId, dry_run: true },
      mockToolCallOptions
    )) as { success: boolean; error?: string };

    expect(result.success).toBe(true);

    // HEAD should remain on the base commit.
    expect(execSync("git log -1 --pretty=%s", { cwd: targetRepo, encoding: "utf-8" }).trim()).toBe(
      "base"
    );

    const artifact = await readSubagentGitPatchArtifact(sessionDir, childTaskId);
    expect(artifact?.appliedAtMs).toBeUndefined();
  }, 20_000);
});
