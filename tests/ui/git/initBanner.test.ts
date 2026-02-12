/**
 * Integration tests for the git init banner on the New Workspace screen.
 *
 * Tests cover:
 * - Banner appears when project is not a git repository
 * - Banner does not appear for git repositories
 * - Clicking "Run git init" initializes the repo and refreshes branch list
 */

import "../dom";
import { fireEvent, waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../../testUtils";
import { installDom } from "../dom";
import { renderApp } from "../renderReviewPanel";
import { cleanupView, openProjectCreationView } from "../helpers";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type { ProjectConfig } from "@/node/config";
import { expandProjects } from "@/browser/stories/storyHelpers";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

/** Helper to create a project config for a path with no workspaces */

function projectWithNoWorkspaces(path: string): [string, ProjectConfig] {
  return [path, { workspaces: [] }];
}

describeIntegration("Git Init Banner (UI)", () => {
  test("shows git init banner when project is not a git repository", async () => {
    const cleanupDom = installDom();

    // Set up project in sidebar
    expandProjects(["/Users/dev/non-git-project"]);

    // Create mock client with empty branches (indicates non-git repo)
    const client = createMockORPCClient({
      projects: new Map([projectWithNoWorkspaces("/Users/dev/non-git-project")]),
      workspaces: [],
      listBranches: async () => ({ branches: [], recommendedTrunk: null }),
    });

    const view = renderApp({
      apiClient: client,
      metadata: {
        id: "test-ws",
        name: "test-workspace",
        projectPath: "/Users/dev/non-git-project",
        projectName: "non-git-project",
        namedWorkspacePath: "/Users/dev/non-git-project",
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      },
    });

    try {
      await view.waitForReady();
      await openProjectCreationView(view, "/Users/dev/non-git-project");

      // Wait for the git init banner to appear
      await waitFor(
        () => {
          const banner = view.container.querySelector('[data-testid="git-init-banner"]');
          if (!banner) {
            throw new Error("Git init banner not found");
          }
        },
        { timeout: 5_000 }
      );

      // Verify banner content
      const banner = view.container.querySelector('[data-testid="git-init-banner"]');
      expect(banner?.textContent).toContain("git init");
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);

  test("does not show git init banner for git repositories", async () => {
    const cleanupDom = installDom();

    // Set up project in sidebar
    expandProjects(["/Users/dev/git-project"]);

    // Create mock client with branches (indicates git repo)
    const client = createMockORPCClient({
      projects: new Map([projectWithNoWorkspaces("/Users/dev/git-project")]),
      workspaces: [],
      // Default mock has branches, so it's a git repo
    });

    const view = renderApp({
      apiClient: client,
      metadata: {
        id: "test-ws",
        name: "test-workspace",
        projectPath: "/Users/dev/git-project",
        projectName: "git-project",
        namedWorkspacePath: "/Users/dev/git-project",
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      },
    });

    try {
      await view.waitForReady();
      await openProjectCreationView(view, "/Users/dev/git-project");

      // Wait for creation controls to load (branches need to load first)
      await waitFor(
        () => {
          const runtimeGroup = view.container.querySelector('[data-component="RuntimeTypeGroup"]');
          if (!runtimeGroup) {
            throw new Error("Runtime controls not found");
          }
        },
        { timeout: 5_000 }
      );

      // Banner should NOT be present
      const banner = view.container.querySelector('[data-testid="git-init-banner"]');
      expect(banner).toBeNull();
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);

  test("clicking git init button runs git init and reloads branches", async () => {
    const cleanupDom = installDom();

    // Set up project in sidebar
    expandProjects(["/Users/dev/non-git-project"]);

    let gitInitCalled = false;
    let branchesRefreshed = false;

    // Create mock client with empty branches initially, then return branches after git init
    const client = createMockORPCClient({
      projects: new Map([projectWithNoWorkspaces("/Users/dev/non-git-project")]),
      workspaces: [],
      listBranches: async () => {
        if (gitInitCalled) {
          branchesRefreshed = true;
          return { branches: ["main"], recommendedTrunk: "main" };
        }
        return { branches: [], recommendedTrunk: null };
      },
      gitInit: async () => {
        gitInitCalled = true;
        return { success: true };
      },
    });

    const view = renderApp({
      apiClient: client,
      metadata: {
        id: "test-ws",
        name: "test-workspace",
        projectPath: "/Users/dev/non-git-project",
        projectName: "non-git-project",
        namedWorkspacePath: "/Users/dev/non-git-project",
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      },
    });

    try {
      await view.waitForReady();
      await openProjectCreationView(view, "/Users/dev/non-git-project");

      // Wait for the git init banner to appear
      const banner = await waitFor(
        () => {
          const el = view.container.querySelector('[data-testid="git-init-banner"]');
          if (!el) throw new Error("Git init banner not found");
          return el as HTMLElement;
        },
        { timeout: 5_000 }
      );

      // Find and click the git init button
      const initButton = banner.querySelector("button");
      expect(initButton).toBeTruthy();
      fireEvent.click(initButton!);

      // Wait for git init to complete and branches to reload
      await waitFor(
        () => {
          if (!gitInitCalled) throw new Error("git init not called");
          if (!branchesRefreshed) throw new Error("branches not refreshed");
        },
        { timeout: 5_000 }
      );

      // Banner should disappear after successful git init
      await waitFor(
        () => {
          const bannerAfter = view.container.querySelector('[data-testid="git-init-banner"]');
          if (bannerAfter) throw new Error("Banner should be gone after git init");
        },
        { timeout: 5_000 }
      );
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);
});
