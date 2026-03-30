import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { WorkspaceMetadata } from "@/common/types/workspace";
import { Config } from "@/node/config";
import { WorktreeArchiveSnapshotService } from "@/node/services/worktreeArchiveSnapshotService";

interface TestFixture {
  muxRoot: string;
  projectPath: string;
  workspacePath: string;
  workspaceId: string;
  workspaceName: string;
  baseSha: string;
  metadata: WorkspaceMetadata;
  config: Config;
  service: WorktreeArchiveSnapshotService;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Mux Test",
      GIT_AUTHOR_EMAIL: "mux@example.com",
      GIT_COMMITTER_NAME: "Mux Test",
      GIT_COMMITTER_EMAIL: "mux@example.com",
    },
  }).trim();
}

async function pathExists(targetPath: string): Promise<boolean> {
  return fs
    .access(targetPath)
    .then(() => true)
    .catch(() => false);
}

async function createFixture(): Promise<TestFixture> {
  const muxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mux-worktree-archive-snapshot-"));
  const srcBaseDir = path.join(muxRoot, "src");
  const projectPath = path.join(muxRoot, "project");
  const workspaceName = "feature-snapshot";
  const workspacePath = path.join(srcBaseDir, "project", workspaceName);
  const workspaceId = "ws-snapshot";

  await fs.mkdir(projectPath, { recursive: true });
  runGit(projectPath, ["init", "-b", "main"]);
  await fs.writeFile(path.join(projectPath, "tracked.txt"), "base\n", "utf-8");
  runGit(projectPath, ["add", "tracked.txt"]);
  runGit(projectPath, ["commit", "-m", "base"]);
  const baseSha = runGit(projectPath, ["rev-parse", "HEAD"]);

  await fs.mkdir(path.dirname(workspacePath), { recursive: true });
  runGit(projectPath, ["worktree", "add", "-b", workspaceName, workspacePath, "main"]);

  const config = new Config(muxRoot);
  await config.editConfig((cfg) => {
    cfg.projects.set(projectPath, {
      trusted: false,
      workspaces: [
        {
          path: workspacePath,
          id: workspaceId,
          name: workspaceName,
          runtimeConfig: { type: "worktree", srcBaseDir },
          taskTrunkBranch: "main",
          taskBaseCommitSha: baseSha,
        },
      ],
    });
    return cfg;
  });

  const metadata: WorkspaceMetadata = {
    id: workspaceId,
    name: workspaceName,
    projectName: "project",
    projectPath,
    runtimeConfig: { type: "worktree", srcBaseDir },
  };

  return {
    muxRoot,
    projectPath,
    workspacePath,
    workspaceId,
    workspaceName,
    baseSha,
    metadata,
    config,
    service: new WorktreeArchiveSnapshotService(config),
  };
}

async function makeWorkspaceDirty(fixture: TestFixture): Promise<void> {
  await fs.writeFile(
    path.join(fixture.workspacePath, "tracked.txt"),
    "base\ncommit one\n",
    "utf-8"
  );
  runGit(fixture.workspacePath, ["add", "tracked.txt"]);
  runGit(fixture.workspacePath, ["commit", "-m", "commit one"]);

  await fs.writeFile(
    path.join(fixture.workspacePath, "tracked.txt"),
    "base\ncommit one\ncommit two\n",
    "utf-8"
  );
  runGit(fixture.workspacePath, ["add", "tracked.txt"]);
  runGit(fixture.workspacePath, ["commit", "-m", "commit two"]);

  await fs.writeFile(
    path.join(fixture.workspacePath, "tracked.txt"),
    "base\ncommit one\ncommit two\nstaged change\n",
    "utf-8"
  );
  runGit(fixture.workspacePath, ["add", "tracked.txt"]);

  await fs.writeFile(
    path.join(fixture.workspacePath, "tracked.txt"),
    "base\ncommit one\ncommit two\nstaged change\nunstaged change\n",
    "utf-8"
  );
}

describe("WorktreeArchiveSnapshotService", () => {
  let fixture: TestFixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    await fs.rm(fixture.muxRoot, { recursive: true, force: true });
  });

  test("captures a durable snapshot and restores tracked staged + unstaged changes", async () => {
    await makeWorkspaceDirty(fixture);

    const captureResult = await fixture.service.captureSnapshotForArchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(captureResult.success).toBe(true);
    if (!captureResult.success) {
      return;
    }

    expect(captureResult.data.projects).toHaveLength(1);
    expect(
      await pathExists(
        path.join(
          fixture.config.getSessionDir(fixture.workspaceId),
          "archive-state",
          "metadata.json"
        )
      )
    ).toBe(true);

    await fixture.config.editConfig((cfg) => {
      const workspace = cfg.projects.get(fixture.projectPath)?.workspaces[0];
      if (!workspace) {
        throw new Error("Missing workspace entry");
      }
      workspace.worktreeArchiveSnapshot = captureResult.data;
      return cfg;
    });

    runGit(fixture.projectPath, ["worktree", "remove", "--force", fixture.workspacePath]);
    expect(await pathExists(fixture.workspacePath)).toBe(false);

    const restoreResult = await fixture.service.restoreSnapshotAfterUnarchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(restoreResult).toEqual({ success: true, data: "restored" });
    expect(await pathExists(fixture.workspacePath)).toBe(true);
    expect(runGit(fixture.workspacePath, ["log", "--format=%s", "-n", "3"])).toContain(
      "commit two"
    );
    expect(runGit(fixture.workspacePath, ["diff", "--cached", "--name-only"])).toBe("tracked.txt");
    expect(runGit(fixture.workspacePath, ["diff", "--name-only"])).toBe("tracked.txt");
    expect(
      runGit(fixture.workspacePath, ["status", "--short"])
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    ).toEqual(["MM tracked.txt"]);

    const storedWorkspace = fixture.config.loadConfigOrDefault().projects.get(fixture.projectPath)
      ?.workspaces[0];
    expect(storedWorkspace?.worktreeArchiveSnapshot).toBeUndefined();
    expect(
      await pathExists(
        path.join(fixture.config.getSessionDir(fixture.workspaceId), "archive-state")
      )
    ).toBe(false);
  });

  test("falls back to base commit + mailbox replay when the archived head commit is gone", async () => {
    await makeWorkspaceDirty(fixture);

    const captureResult = await fixture.service.captureSnapshotForArchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(captureResult.success).toBe(true);
    if (!captureResult.success) {
      return;
    }

    const headSha = captureResult.data.projects[0]?.headSha;
    expect(typeof headSha).toBe("string");

    await fixture.config.editConfig((cfg) => {
      const workspace = cfg.projects.get(fixture.projectPath)?.workspaces[0];
      if (!workspace) {
        throw new Error("Missing workspace entry");
      }
      workspace.worktreeArchiveSnapshot = captureResult.data;
      return cfg;
    });

    runGit(fixture.projectPath, ["worktree", "remove", "--force", fixture.workspacePath]);
    runGit(fixture.projectPath, ["branch", "-D", fixture.workspaceName]);
    runGit(fixture.projectPath, ["reflog", "expire", "--expire=now", "--all"]);
    runGit(fixture.projectPath, ["gc", "--prune=now"]);

    expect(() => runGit(fixture.projectPath, ["cat-file", "-e", `${headSha}^{commit}`])).toThrow();

    const restoreResult = await fixture.service.restoreSnapshotAfterUnarchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });
    expect(restoreResult).toEqual({ success: true, data: "restored" });
    expect(runGit(fixture.workspacePath, ["log", "--format=%s", "-n", "3"])).toContain(
      "commit two"
    );
    expect(runGit(fixture.workspacePath, ["status", "--short"]).includes("MM tracked.txt")).toBe(
      true
    );
  });

  test("rejects archive snapshots when untracked files are present", async () => {
    await fs.writeFile(path.join(fixture.workspacePath, "untracked.txt"), "hello\n", "utf-8");

    const captureResult = await fixture.service.captureSnapshotForArchive({
      workspaceId: fixture.workspaceId,
      workspaceMetadata: fixture.metadata,
    });

    expect(captureResult.success).toBe(false);
    if (!captureResult.success) {
      expect(captureResult.error).toContain("untracked files");
    }
    expect(
      await pathExists(
        path.join(fixture.config.getSessionDir(fixture.workspaceId), "archive-state")
      )
    ).toBe(false);
  });
});
