import { describe, expect, test } from "bun:test";

import { formatGitPatchArtifactSummary } from "./taskPatchSummary";

describe("formatGitPatchArtifactSummary", () => {
  test("renders mixed per-project patch summary", () => {
    expect(
      formatGitPatchArtifactSummary({
        childTaskId: "task-1",
        parentWorkspaceId: "parent-1",
        createdAtMs: 123,
        status: "ready",
        projectArtifacts: [
          {
            projectPath: "/tmp/project-a",
            projectName: "project-a",
            storageKey: "project-a",
            status: "ready",
            commitCount: 2,
          },
          {
            projectPath: "/tmp/project-b",
            projectName: "project-b",
            storageKey: "project-b",
            status: "skipped",
            commitCount: 0,
          },
          {
            projectPath: "/tmp/project-c",
            projectName: "project-c",
            storageKey: "project-c",
            status: "failed",
            error: "git format-patch failed",
          },
        ],
        readyProjectCount: 1,
        failedProjectCount: 1,
        skippedProjectCount: 1,
        totalCommitCount: 2,
      })
    ).toBe("Patch: ready (1 ready, 1 skipped, 1 failed; 2 commits)");
  });

  test("falls back to legacy single-project commit counts", () => {
    expect(
      formatGitPatchArtifactSummary({
        status: "ready",
        commitCount: 1,
      })
    ).toBe("Patch: ready (1 commit)");
  });

  test("falls back to legacy top-level errors for failed summaries", () => {
    expect(
      formatGitPatchArtifactSummary({
        status: "failed",
        error: "legacy patch generation failed",
      })
    ).toBe("Patch: failed (legacy patch generation failed)");
  });
});
