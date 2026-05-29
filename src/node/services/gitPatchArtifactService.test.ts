import { describe, expect, it } from "bun:test";

import { upsertProjectArtifact } from "@/node/services/gitPatchArtifactService";

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
