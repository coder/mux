import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Ok } from "@/common/types/result";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { log } from "@/node/services/log";
import { createWorktreeArchiveHook } from "./worktreeLifecycleHooks";

function createWorkspaceMetadata(overrides?: Partial<WorkspaceMetadata>): WorkspaceMetadata {
  return {
    id: "ws",
    name: "workspace-name",
    projectName: "project-name",
    projectPath: "/tmp/project-name",
    runtimeConfig: {
      type: "worktree",
      srcBaseDir: "/tmp/src",
    },
    ...overrides,
  };
}

function getManagedPath(workspaceMetadata: WorkspaceMetadata): string {
  const runtimeConfig = workspaceMetadata.runtimeConfig;
  if (!runtimeConfig || !("srcBaseDir" in runtimeConfig) || !runtimeConfig.srcBaseDir) {
    throw new Error("Expected test metadata with srcBaseDir");
  }

  return path.join(runtimeConfig.srcBaseDir, workspaceMetadata.projectName, workspaceMetadata.name);
}

describe("createWorktreeArchiveHook", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    mock.restore();

    await Promise.all(
      tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true }))
    );
  });

  async function createTempRoot(): Promise<string> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mux-worktree-archive-"));
    tempDirs.push(tempRoot);
    return tempRoot;
  }

  it("skips deletion when deleteWorktreeOnArchive is false", async () => {
    const srcBaseDir = await createTempRoot();
    const workspaceMetadata = createWorkspaceMetadata({
      runtimeConfig: { type: "worktree", srcBaseDir },
    });
    const managedPath = getManagedPath(workspaceMetadata);
    await mkdir(managedPath, { recursive: true });

    const hook = createWorktreeArchiveHook({
      getDeleteWorktreeOnArchive: () => false,
    });

    const result = await hook({ workspaceId: workspaceMetadata.id, workspaceMetadata });

    expect(result).toEqual(Ok(undefined));
    expect(fs.existsSync(managedPath)).toBe(true);
  });

  it("deletes the managed worktree for worktree runtimes when cleanup is enabled", async () => {
    const srcBaseDir = await createTempRoot();
    const workspaceMetadata = createWorkspaceMetadata({
      runtimeConfig: { type: "worktree", srcBaseDir },
    });
    const managedPath = getManagedPath(workspaceMetadata);
    await mkdir(managedPath, { recursive: true });

    const hook = createWorktreeArchiveHook({
      getDeleteWorktreeOnArchive: () => true,
    });

    const result = await hook({ workspaceId: workspaceMetadata.id, workspaceMetadata });

    expect(result).toEqual(Ok(undefined));
    expect(fs.existsSync(managedPath)).toBe(false);
  });

  it("skips cleanup for non-worktree runtimes even when cleanup is enabled", async () => {
    const tempRoot = await createTempRoot();
    const untouchedPath = path.join(tempRoot, "project-name", "workspace-name");
    await mkdir(untouchedPath, { recursive: true });

    const workspaceMetadata = createWorkspaceMetadata({
      runtimeConfig: { type: "local" },
    });

    const hook = createWorktreeArchiveHook({
      getDeleteWorktreeOnArchive: () => true,
    });

    const result = await hook({ workspaceId: workspaceMetadata.id, workspaceMetadata });

    expect(result).toEqual(Ok(undefined));
    expect(fs.existsSync(untouchedPath)).toBe(true);
  });

  it("returns Ok when the managed worktree directory is already missing", async () => {
    const srcBaseDir = await createTempRoot();
    const workspaceMetadata = createWorkspaceMetadata({
      runtimeConfig: { type: "worktree", srcBaseDir },
    });
    const debugSpy = spyOn(log, "debug").mockImplementation(() => undefined);

    const hook = createWorktreeArchiveHook({
      getDeleteWorktreeOnArchive: () => true,
    });

    const result = await hook({ workspaceId: workspaceMetadata.id, workspaceMetadata });

    expect(result).toEqual(Ok(undefined));
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("logs rm failures and still returns Ok", async () => {
    const srcBaseDir = await createTempRoot();
    const workspaceMetadata = createWorkspaceMetadata({
      runtimeConfig: { type: "worktree", srcBaseDir },
    });
    const managedPath = getManagedPath(workspaceMetadata);
    const rmError = new Error("rm failed");
    await mkdir(managedPath, { recursive: true });

    const rmSpy = spyOn(fs.promises, "rm").mockRejectedValueOnce(rmError);
    const debugSpy = spyOn(log, "debug").mockImplementation(() => undefined);
    const hook = createWorktreeArchiveHook({
      getDeleteWorktreeOnArchive: () => true,
    });

    const result = await hook({ workspaceId: workspaceMetadata.id, workspaceMetadata });

    expect(result).toEqual(Ok(undefined));
    expect(rmSpy).toHaveBeenCalledWith(managedPath, { recursive: true, force: true });
    expect(debugSpy).toHaveBeenCalledWith(
      "Failed to delete managed worktree during archive",
      expect.objectContaining({ managedPath, error: rmError })
    );
    expect(fs.existsSync(managedPath)).toBe(true);
  });
});
