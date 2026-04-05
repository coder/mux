import { describe, expect, test } from "bun:test";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { ProjectConfig } from "@/common/types/project";
import { getRecentVisibleWorkspaces } from "./LandingPage";

function createWorkspace(
  id: string,
  projectPath: string,
  overrides: Partial<FrontendWorkspaceMetadata> = {}
): FrontendWorkspaceMetadata {
  return {
    id,
    name: `${id}-name`,
    title: `${id}-title`,
    projectName: projectPath.split("/").filter(Boolean).at(-1) ?? projectPath,
    projectPath,
    namedWorkspacePath: `${projectPath}/${id}`,
    runtimeConfig: { type: "local" },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("getRecentVisibleWorkspaces", () => {
  test("filters hidden system workspaces before sorting recents", () => {
    const workspaces = new Map<string, FrontendWorkspaceMetadata>([
      [
        "legacy-system",
        createWorkspace("legacy-system", "/system/internal-project", {
          createdAt: "2026-04-05T00:00:00.000Z",
        }),
      ],
      [
        "user-visible",
        createWorkspace("user-visible", "/repo/app", {
          createdAt: "2026-04-04T00:00:00.000Z",
        }),
      ],
    ]);
    const projectConfigs = new Map<string, ProjectConfig>([
      ["/system/internal-project", { workspaces: [], projectKind: "system" }],
      ["/repo/app", { workspaces: [] }],
    ]);

    const recentWorkspaces = getRecentVisibleWorkspaces(
      workspaces,
      {
        "legacy-system": 10,
        "user-visible": 1,
      },
      (projectPath) => projectConfigs.get(projectPath)
    );

    expect(recentWorkspaces.map((workspace) => workspace.id)).toEqual(["user-visible"]);
  });

  test("keeps visible multi-project workspaces in recent workspaces", () => {
    const workspaces = new Map<string, FrontendWorkspaceMetadata>([
      [
        "multi-project",
        createWorkspace("multi-project", "_multi", {
          createdAt: "2026-04-05T00:00:00.000Z",
        }),
      ],
      [
        "user-visible",
        createWorkspace("user-visible", "/repo/app", {
          createdAt: "2026-04-04T00:00:00.000Z",
        }),
      ],
    ]);
    const projectConfigs = new Map<string, ProjectConfig>([
      ["_multi", { workspaces: [], projectKind: "system" }],
      ["/repo/app", { workspaces: [] }],
    ]);

    const recentWorkspaces = getRecentVisibleWorkspaces(
      workspaces,
      {
        "multi-project": 10,
        "user-visible": 1,
      },
      (projectPath) => projectConfigs.get(projectPath)
    );

    expect(recentWorkspaces.map((workspace) => workspace.id)).toEqual([
      "multi-project",
      "user-visible",
    ]);
  });

  test("fails closed when project metadata is missing", () => {
    const workspaces = new Map<string, FrontendWorkspaceMetadata>([
      ["unknown-project", createWorkspace("unknown-project", "/repo/app")],
    ]);

    const recentWorkspaces = getRecentVisibleWorkspaces(
      workspaces,
      { "unknown-project": 10 },
      () => undefined
    );

    expect(recentWorkspaces).toEqual([]);
  });
});
