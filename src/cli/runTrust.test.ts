import { describe, expect, test } from "bun:test";
import type { ProjectConfig } from "@/node/config";
import { buildTrustOnlyProjectsForRun } from "./runTrust";

const CANONICAL_PROJECT_PATH = "/Users/tester/src/mux";
const SRC_DIR = "/Users/tester/.mux/src";
const WORKTREE_PROJECT_PATH = `${SRC_DIR}/mux`;
const KNOWN_WORKTREE_PATH = `${WORKTREE_PROJECT_PATH}/lsp-rb97`;
const UNKNOWN_WORKTREE_PATH = `${WORKTREE_PROJECT_PATH}/not-configured`;

function createProjectConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    workspaces: [],
    ...overrides,
  };
}

describe("buildTrustOnlyProjectsForRun", () => {
  test("preserves canonical project trust without workspace metadata", () => {
    const projects = new Map<string, ProjectConfig>([
      [CANONICAL_PROJECT_PATH, createProjectConfig({ trusted: true })],
    ]);

    const trustOnlyProjects = buildTrustOnlyProjectsForRun(
      projects,
      CANONICAL_PROJECT_PATH,
      SRC_DIR
    );

    expect(trustOnlyProjects).toEqual(
      new Map<string, ProjectConfig>([[CANONICAL_PROJECT_PATH, { workspaces: [], trusted: true }]])
    );
  });

  test("adds an exact trust alias for a known worktree path", () => {
    const projects = new Map<string, ProjectConfig>([
      [
        CANONICAL_PROJECT_PATH,
        createProjectConfig({
          trusted: true,
          workspaces: [{ path: KNOWN_WORKTREE_PATH }],
        }),
      ],
    ]);

    const trustOnlyProjects = buildTrustOnlyProjectsForRun(projects, KNOWN_WORKTREE_PATH, SRC_DIR);

    expect(trustOnlyProjects).toEqual(
      new Map<string, ProjectConfig>([
        [CANONICAL_PROJECT_PATH, { workspaces: [], trusted: true }],
        [WORKTREE_PROJECT_PATH, { workspaces: [], trusted: true }],
      ])
    );
  });

  test("does not trust arbitrary unconfigured worktree-like paths", () => {
    const projects = new Map<string, ProjectConfig>([
      [
        CANONICAL_PROJECT_PATH,
        createProjectConfig({
          trusted: true,
          workspaces: [{ path: KNOWN_WORKTREE_PATH }],
        }),
      ],
    ]);

    const trustOnlyProjects = buildTrustOnlyProjectsForRun(
      projects,
      UNKNOWN_WORKTREE_PATH,
      SRC_DIR
    );

    expect(trustOnlyProjects.has(UNKNOWN_WORKTREE_PATH)).toBe(false);
    expect(trustOnlyProjects.has(WORKTREE_PROJECT_PATH)).toBe(false);
    expect(trustOnlyProjects).toEqual(
      new Map<string, ProjectConfig>([[CANONICAL_PROJECT_PATH, { workspaces: [], trusted: true }]])
    );
  });
});
