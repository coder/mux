import { describe, expect, test } from "bun:test";

import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

import { getWorkspaceSidebarKey } from "./workspace";

function createWorkspaceMeta(
  taskStatus: FrontendWorkspaceMetadata["taskStatus"]
): FrontendWorkspaceMetadata {
  return {
    id: "workspace-1",
    name: "feature-branch",
    projectName: "repo",
    projectPath: "/tmp/repo",
    runtimeConfig: { type: "local" },
    namedWorkspacePath: "/tmp/repo/feature-branch",
    taskStatus,
  };
}

describe("getWorkspaceSidebarKey", () => {
  test("changes when taskStatus changes", () => {
    const running = createWorkspaceMeta("running");
    const reported = createWorkspaceMeta("reported");

    expect(getWorkspaceSidebarKey(running)).not.toBe(getWorkspaceSidebarKey(reported));
  });
});
