import { describe, expect, test } from "bun:test";

import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

import { getWorkspaceSidebarKey } from "./workspace";

function createWorkspaceMeta(
  overrides: Partial<FrontendWorkspaceMetadata> = {}
): FrontendWorkspaceMetadata {
  return {
    id: "workspace-1",
    name: "feature-branch",
    projectName: "repo",
    projectPath: "/tmp/repo",
    runtimeConfig: { type: "local" },
    namedWorkspacePath: "/tmp/repo/feature-branch",
    ...overrides,
  };
}

describe("getWorkspaceSidebarKey", () => {
  test("changes when taskStatus changes", () => {
    const running = createWorkspaceMeta({ taskStatus: "running" });
    const reported = createWorkspaceMeta({ taskStatus: "reported" });

    expect(getWorkspaceSidebarKey(running)).not.toBe(getWorkspaceSidebarKey(reported));
  });

  test("changes when heartbeat enabled changes", () => {
    const disabled = createWorkspaceMeta({
      heartbeat: {
        enabled: false,
        intervalMs: 1_800_000,
        contextMode: "normal",
      },
    });
    const enabled = createWorkspaceMeta({
      heartbeat: {
        enabled: true,
        intervalMs: 1_800_000,
        contextMode: "normal",
      },
    });

    expect(getWorkspaceSidebarKey(disabled)).not.toBe(getWorkspaceSidebarKey(enabled));
  });
});
