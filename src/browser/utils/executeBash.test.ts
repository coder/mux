import { describe, expect, test } from "bun:test";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { normalizeRepoRootFilePath, resolveRepoRootProjectPath } from "./executeBash";

const workspaceMetadata: Pick<FrontendWorkspaceMetadata, "projects"> = {
  projects: [
    { projectName: "project-a", projectPath: "/tmp/project-a" },
    { projectName: "project-b", projectPath: "/tmp/project-b" },
  ],
};

describe("executeBash repo-root helpers", () => {
  test("resolves repo-root project paths from workspace-relative sibling project paths", () => {
    expect(resolveRepoRootProjectPath(workspaceMetadata, "project-b/src/example.ts")).toBe(
      "/tmp/project-b"
    );
  });

  test("normalizes sibling project paths to repo-relative paths for repo-root execution", () => {
    expect(
      normalizeRepoRootFilePath(workspaceMetadata, "project-b/src/example.ts", "/tmp/project-b")
    ).toBe("src/example.ts");
  });

  test("keeps workspace-relative paths when execution stays on the container root", () => {
    expect(normalizeRepoRootFilePath(workspaceMetadata, "project-b/src/example.ts")).toBe(
      "project-b/src/example.ts"
    );
  });

  test("keeps primary-repo paths unchanged when no sibling project prefix is present", () => {
    expect(normalizeRepoRootFilePath(workspaceMetadata, "src/example.ts", "/tmp/project-a")).toBe(
      "src/example.ts"
    );
  });
});
