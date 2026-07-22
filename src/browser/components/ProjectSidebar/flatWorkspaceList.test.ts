import { describe, expect, test } from "bun:test";
import type { ProjectConfig } from "@/common/types/project";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { buildFlatWorkspaceList } from "./flatWorkspaceList";

function workspace(
  id: string,
  projectPath: string,
  overrides: Partial<FrontendWorkspaceMetadata> = {}
): FrontendWorkspaceMetadata {
  return {
    id,
    name: id,
    projectName: projectPath.split("/").at(-1) ?? projectPath,
    projectPath,
    namedWorkspacePath: `${projectPath}/${id}`,
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    ...overrides,
  };
}

const projects = new Map<string, ProjectConfig>([
  ["/repo/a", { workspaces: [], displayName: "Alpha" }],
  ["/repo/b", { workspaces: [], displayName: "Beta" }],
]);

describe("buildFlatWorkspaceList", () => {
  test("sorts root threads globally by recency while keeping descendants adjacent", () => {
    const parent = workspace("parent", "/repo/a");
    const child = workspace("child", "/repo/a", { parentWorkspaceId: "parent" });
    const newer = workspace("newer", "/repo/b");

    const rows = buildFlatWorkspaceList({
      sortedWorkspacesByProject: new Map([
        ["/repo/a", [parent, child]],
        ["/repo/b", [newer]],
      ]),
      workspaceRecency: { parent: 100, child: 500, newer: 200 },
      userProjects: projects,
      githubRepoInfoByProject: {},
      multiProjectWorkspacesEnabled: true,
    });

    expect(rows.map((row) => row.metadata.id)).toEqual(["newer", "parent", "child"]);
  });

  test("includes scratch once and assigns multi-project rows to their primary project", () => {
    const scratch = workspace("scratch", "/scratch", { kind: "scratch" });
    const multi = workspace("multi", "/repo/a", {
      projects: [
        { projectPath: "/repo/b", projectName: "beta-primary" },
        { projectPath: "/repo/a", projectName: "alpha-secondary" },
      ],
    });

    const rows = buildFlatWorkspaceList({
      sortedWorkspacesByProject: new Map([
        ["/repo/a", [scratch, multi]],
        ["/repo/b", [scratch, multi]],
      ]),
      workspaceRecency: { scratch: 200, multi: 100 },
      userProjects: projects,
      githubRepoInfoByProject: {},
      multiProjectWorkspacesEnabled: true,
    });

    expect(rows.map((row) => [row.metadata.id, row.projectPath, row.projectName])).toEqual([
      ["scratch", null, "Scratch"],
      ["multi", "/repo/b", "beta-primary"],
    ]);
  });

  test("drops orphaned and cyclic descendants like the canonical workspace tree", () => {
    const root = workspace("root", "/repo/a");
    const orphan = workspace("orphan", "/repo/a", { parentWorkspaceId: "missing" });
    const cycleA = workspace("cycle-a", "/repo/a", { parentWorkspaceId: "cycle-b" });
    const cycleB = workspace("cycle-b", "/repo/a", { parentWorkspaceId: "cycle-a" });

    const rows = buildFlatWorkspaceList({
      sortedWorkspacesByProject: new Map([["/repo/a", [root, orphan, cycleA, cycleB]]]),
      workspaceRecency: {},
      userProjects: projects,
      githubRepoInfoByProject: {},
      multiProjectWorkspacesEnabled: true,
    });

    expect(rows.map((row) => row.metadata.id)).toEqual(["root"]);
  });

  test("attaches GitHub identity by the resolved project path", () => {
    const info = {
      owner: "coder",
      repo: "mux",
      avatarUrl: "https://github.com/coder.png?size=64",
    };
    const rows = buildFlatWorkspaceList({
      sortedWorkspacesByProject: new Map([["/repo/a", [workspace("a", "/repo/a")]]]),
      workspaceRecency: { a: 1 },
      userProjects: projects,
      githubRepoInfoByProject: { "/repo/a": info },
      multiProjectWorkspacesEnabled: true,
    });

    expect(rows[0]).toMatchObject({ projectName: "Alpha", githubRepoInfo: info });
  });
});
