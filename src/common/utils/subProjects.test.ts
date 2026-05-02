import { describe, expect, test } from "bun:test";
import type { ProjectConfig } from "@/common/types/project";
import {
  deriveProjectHierarchy,
  formatProjectHierarchyLabel,
  getSubProjectsForParent,
  isPathDescendant,
} from "./subProjects";

function project(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return { workspaces: [], ...overrides };
}

describe("subProjects", () => {
  test("detects only boundary-safe descendants", () => {
    expect(isPathDescendant("/repo", "/repo/packages/api")).toBe(true);
    expect(isPathDescendant("/repo", "/repo-sibling")).toBe(false);
    expect(isPathDescendant("/repo", "/repo")).toBe(false);
  });

  test("treats Windows drive-letter paths as case-insensitive", () => {
    expect(isPathDescendant("C:\\Repo", "c:\\repo\\packages\\api")).toBe(true);
  });

  test("derives one-level parentage from registered project paths", () => {
    const projects = new Map<string, ProjectConfig>([
      ["/repo", project()],
      ["/repo/packages/api", project()],
      ["/repo/packages/api/nested", project()],
    ]);

    const derived = deriveProjectHierarchy(projects);

    expect(derived.get("/repo")?.parentProjectPath).toBeUndefined();
    expect(derived.get("/repo/packages/api")?.parentProjectPath).toBe("/repo");
    expect(derived.get("/repo/packages/api/nested")?.parentProjectPath).toBe("/repo");
  });

  test("clears stale parent pointers for top-level projects", () => {
    const projects = deriveProjectHierarchy(
      new Map<string, ProjectConfig>([["/repo", project({ parentProjectPath: "/stale" })]])
    );

    expect(projects.get("/repo")?.parentProjectPath).toBeUndefined();
  });

  test("does not depend on insertion order for nested existing paths", () => {
    const projects = deriveProjectHierarchy(
      new Map<string, ProjectConfig>([
        ["/repo", project()],
        ["/repo/packages/api/nested", project()],
        ["/repo/packages/api", project()],
      ])
    );

    expect(projects.get("/repo/packages/api")?.parentProjectPath).toBe("/repo");
    expect(projects.get("/repo/packages/api/nested")?.parentProjectPath).toBe("/repo");
  });

  test("orders sub-projects by display name and labels them with parent context", () => {
    const projects = deriveProjectHierarchy(
      new Map<string, ProjectConfig>([
        ["/repo", project({ displayName: "Mux" })],
        ["/repo/packages/web", project({ displayName: "Web" })],
        ["/repo/packages/api", project({ displayName: "API" })],
      ])
    );

    expect(getSubProjectsForParent("/repo", projects).map(([path]) => path)).toEqual([
      "/repo/packages/api",
      "/repo/packages/web",
    ]);
    expect(formatProjectHierarchyLabel("/repo/packages/api", projects)).toBe("Mux / API");
  });
});
