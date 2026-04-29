import { describe, expect, test } from "bun:test";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { ProjectConfig } from "@/node/config";
import { isWorkspaceTrustedForSharedExecution } from "./workspaceTrust";

const CANONICAL_PROJECT_PATH = "/Users/tester/src/mux";
const WORKTREE_PARENT_PATH = "/Users/tester/.mux/src/mux";
const KNOWN_WORKTREE_PATH = `${WORKTREE_PARENT_PATH}/lsp-rb97`;
const UNKNOWN_WORKTREE_PATH = `${WORKTREE_PARENT_PATH}/not-configured`;

function createMetadata(namedWorkspacePath: string): FrontendWorkspaceMetadata {
  return {
    id: "run-123",
    name: namedWorkspacePath.split("/").at(-1) ?? namedWorkspacePath,
    projectName: "mux",
    projectPath: WORKTREE_PARENT_PATH,
    namedWorkspacePath,
    runtimeConfig: { type: "local" },
  };
}

function createProjects(entries: Array<[string, ProjectConfig]>): Map<string, ProjectConfig> {
  return new Map(entries);
}

describe("isWorkspaceTrustedForSharedExecution", () => {
  test("keeps canonical project runs trusted", () => {
    const metadata: FrontendWorkspaceMetadata = {
      id: "run-123",
      name: CANONICAL_PROJECT_PATH,
      projectName: "mux",
      projectPath: CANONICAL_PROJECT_PATH,
      namedWorkspacePath: CANONICAL_PROJECT_PATH,
      runtimeConfig: { type: "local" },
    };
    const projects = createProjects([[CANONICAL_PROJECT_PATH, { workspaces: [], trusted: true }]]);

    expect(isWorkspaceTrustedForSharedExecution(metadata, projects)).toBe(true);
  });

  test("treats known worktree metadata as trusted when mux run saved the derived project key", () => {
    const projects = createProjects([
      [CANONICAL_PROJECT_PATH, { workspaces: [], trusted: true }],
      [WORKTREE_PARENT_PATH, { workspaces: [], trusted: true }],
    ]);

    expect(
      isWorkspaceTrustedForSharedExecution(createMetadata(KNOWN_WORKTREE_PATH), projects)
    ).toBe(true);
  });

  test("does not trust unknown worktree metadata from a sibling path", () => {
    const projects = createProjects([[CANONICAL_PROJECT_PATH, { workspaces: [], trusted: true }]]);

    expect(
      isWorkspaceTrustedForSharedExecution(createMetadata(UNKNOWN_WORKTREE_PATH), projects)
    ).toBe(false);
  });
});
