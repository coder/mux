import { describe, expect, it } from "bun:test";

import {
  buildContinuationProjectArtifacts,
  GitPatchArtifactService,
  upsertProjectArtifact,
} from "@/node/services/gitPatchArtifactService";
import { Config } from "@/node/config";
import { TestTempDir } from "@/node/services/tools/testHelpers";

describe("upsertProjectArtifact", () => {
  it("appends unmatched project artifacts instead of dropping them", () => {
    const updated = upsertProjectArtifact({
      artifact: {
        childTaskId: "child-1",
        parentWorkspaceId: "parent-1",
        createdAtMs: 1,
        updatedAtMs: 1,
        status: "pending",
        projectArtifacts: [
          {
            projectPath: "/tmp/project-a",
            projectName: "project-a",
            storageKey: "project-a",
            status: "ready",
          },
        ],
        readyProjectCount: 0,
        failedProjectCount: 0,
        skippedProjectCount: 0,
        totalCommitCount: 0,
      },
      nextProjectArtifact: {
        projectPath: "/tmp/project-b",
        projectName: "project-b",
        storageKey: "project-b",
        status: "ready",
      },
      updatedAtMs: 2,
    });

    expect(updated.projectArtifacts.map((artifact) => artifact.projectPath)).toEqual([
      "/tmp/project-a",
      "/tmp/project-b",
    ]);
  });
});

describe("GitPatchArtifactService coordination", () => {
  it("waits for an in-flight apply operation before refreshing the stable task artifact", async () => {
    using tempDir = new TestTempDir("git-patch-artifact-lock");
    const service = new GitPatchArtifactService(new Config(tempDir.path));
    let releaseApply: (() => void) | undefined;
    const applyGate = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    let applyStarted: (() => void) | undefined;
    const applyStartedPromise = new Promise<void>((resolve) => {
      applyStarted = resolve;
    });
    const apply = service.withOperationLock("stable-child", async () => {
      applyStarted?.();
      await applyGate;
    });
    await applyStartedPromise;

    let refreshSettled = false;
    const refresh = service
      .maybeStartGeneration("parent", "stable-child", () => Promise.resolve(), {
        refreshForContinuation: true,
      })
      .then(() => {
        refreshSettled = true;
      });
    await Promise.resolve();
    expect(refreshSettled).toBe(false);

    releaseApply?.();
    await Promise.all([apply, refresh]);
    expect(refreshSettled).toBe(true);
  });
});

describe("buildContinuationProjectArtifacts", () => {
  const pendingProjectArtifact = {
    projectPath: "/tmp/project-a",
    projectName: "project-a",
    storageKey: "project-a",
    status: "pending" as const,
    baseCommitSha: "launch-base",
  };

  it("uses the prior patch head after that patch was applied", () => {
    const projectArtifacts = buildContinuationProjectArtifacts({
      pendingProjectArtifacts: [pendingProjectArtifact],
      existingArtifact: {
        childTaskId: "child-1",
        parentWorkspaceId: "parent-1",
        createdAtMs: 1,
        updatedAtMs: 2,
        status: "ready",
        projectArtifacts: [
          {
            ...pendingProjectArtifact,
            status: "ready",
            baseCommitSha: "launch-base",
            headCommitSha: "prior-patch-head",
            appliedAtMs: 3,
          },
        ],
        readyProjectCount: 1,
        failedProjectCount: 0,
        skippedProjectCount: 0,
        totalCommitCount: 1,
      },
    });

    expect(projectArtifacts[0]?.baseCommitSha).toBe("prior-patch-head");
  });

  it("keeps the original base while the prior patch remains unapplied", () => {
    const projectArtifacts = buildContinuationProjectArtifacts({
      pendingProjectArtifacts: [pendingProjectArtifact],
      existingArtifact: {
        childTaskId: "child-1",
        parentWorkspaceId: "parent-1",
        createdAtMs: 1,
        updatedAtMs: 2,
        status: "ready",
        projectArtifacts: [
          {
            ...pendingProjectArtifact,
            status: "ready",
            baseCommitSha: "original-unapplied-base",
            headCommitSha: "prior-patch-head",
          },
        ],
        readyProjectCount: 1,
        failedProjectCount: 0,
        skippedProjectCount: 0,
        totalCommitCount: 1,
      },
    });

    expect(projectArtifacts[0]?.baseCommitSha).toBe("original-unapplied-base");
  });
});
