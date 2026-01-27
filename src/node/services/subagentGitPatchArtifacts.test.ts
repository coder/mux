import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  getSubagentGitPatchArtifactsFilePath,
  markSubagentGitPatchArtifactApplied,
  readSubagentGitPatchArtifactsFile,
  upsertSubagentGitPatchArtifact,
} from "@/node/services/subagentGitPatchArtifacts";

describe("subagentGitPatchArtifacts", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-subagent-git-patch-"));
  });

  afterEach(async () => {
    await fsPromises.rm(testDir, { recursive: true, force: true });
  });

  test("readSubagentGitPatchArtifactsFile returns empty file when missing", async () => {
    const file = await readSubagentGitPatchArtifactsFile(testDir);
    expect(file.version).toBe(1);
    expect(file.artifactsByChildTaskId).toEqual({});
  });

  test("upsertSubagentGitPatchArtifact writes and updates artifacts", async () => {
    const workspaceId = "parent-1";
    const childTaskId = "child-1";

    const createdAtMs = Date.now();

    await upsertSubagentGitPatchArtifact({
      workspaceId,
      workspaceSessionDir: testDir,
      childTaskId,
      updater: () => ({
        childTaskId,
        parentWorkspaceId: workspaceId,
        createdAtMs,
        updatedAtMs: createdAtMs,
        status: "ready",
        commitCount: 2,
        mboxPath: "/tmp/series.mbox",
      }),
    });

    const pathOnDisk = getSubagentGitPatchArtifactsFilePath(testDir);
    await fsPromises.stat(pathOnDisk);

    const file = await readSubagentGitPatchArtifactsFile(testDir);
    const artifact = file.artifactsByChildTaskId[childTaskId];
    expect(artifact).toBeTruthy();
    expect(artifact?.childTaskId).toBe(childTaskId);
    expect(artifact?.parentWorkspaceId).toBe(workspaceId);
    expect(artifact?.createdAtMs).toBe(createdAtMs);
    expect(artifact?.status).toBe("ready");
    expect(artifact?.commitCount).toBe(2);
  });

  test("markSubagentGitPatchArtifactApplied sets appliedAtMs", async () => {
    const workspaceId = "parent-1";
    const childTaskId = "child-1";
    const createdAtMs = Date.now();

    await upsertSubagentGitPatchArtifact({
      workspaceId,
      workspaceSessionDir: testDir,
      childTaskId,
      updater: () => ({
        childTaskId,
        parentWorkspaceId: workspaceId,
        createdAtMs,
        updatedAtMs: createdAtMs,
        status: "ready",
        commitCount: 1,
        mboxPath: "/tmp/series.mbox",
      }),
    });

    const appliedAtMs = createdAtMs + 1234;
    const updated = await markSubagentGitPatchArtifactApplied({
      workspaceId,
      workspaceSessionDir: testDir,
      childTaskId,
      appliedAtMs,
    });

    expect(updated?.appliedAtMs).toBe(appliedAtMs);
    expect(updated?.updatedAtMs).toBe(appliedAtMs);

    const file = await readSubagentGitPatchArtifactsFile(testDir);
    expect(file.artifactsByChildTaskId[childTaskId]?.appliedAtMs).toBe(appliedAtMs);
  });
});
