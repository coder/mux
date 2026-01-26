/**
 * UI integration tests for Docker runtime selection during workspace creation.
 *
 * These tests validate the creation controls without invoking real AI models:
 * - Docker runtime can be selected and exposes the image input
 * - Docker runtime is disabled for non-git projects (requires git)
 */

import { fireEvent, waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../testUtils";
import { installDom } from "./dom";
import { renderApp } from "./renderReviewPanel";
import { cleanupView } from "./helpers";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { expandProjects } from "@/browser/stories/storyHelpers";
import type { ProjectConfig } from "@/node/config";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

/** Helper to create a project config for a path with no workspaces */
function projectWithNoWorkspaces(path: string): [string, ProjectConfig] {
  return [path, { workspaces: [] }];
}

async function openProjectCreationView(container: HTMLElement, projectPath: string): Promise<void> {
  const projectRow = await waitFor(
    () => {
      const el = container.querySelector(
        `[data-project-path="${projectPath}"][aria-controls]`
      ) as HTMLElement | null;
      if (!el) {
        throw new Error(`Project row not found for ${projectPath}`);
      }
      return el;
    },
    { timeout: 5_000 }
  );

  fireEvent.click(projectRow);

  // ProjectPage renders a branch selector textarea + runtime controls.
  await waitFor(
    () => {
      const textarea = container.querySelector("textarea");
      if (!textarea) {
        throw new Error("Project creation page not rendered");
      }
    },
    { timeout: 5_000 }
  );
}

function findRuntimeButton(container: HTMLElement, label: string): HTMLButtonElement | null {
  const group = container.querySelector(
    '[data-component="RuntimeTypeGroup"]'
  ) as HTMLElement | null;
  if (!group) {
    return null;
  }

  const buttons = Array.from(group.querySelectorAll("button"));
  const button = buttons.find((btn) => btn.textContent?.includes(label));
  return (button ?? null) as HTMLButtonElement | null;
}

describeIntegration("Docker runtime selection (UI)", () => {
  test("selecting Docker shows image input", async () => {
    const cleanupDom = installDom();

    const projectPath = "/Users/dev/docker-project";
    expandProjects([projectPath]);

    const client = createMockORPCClient({
      projects: new Map([projectWithNoWorkspaces(projectPath)]),
      workspaces: [],
    });

    const view = renderApp({ apiClient: client });

    try {
      await view.waitForReady();
      await openProjectCreationView(view.container, projectPath);

      // Wait for runtime controls to render (depends on listBranches finishing)
      await waitFor(
        () => {
          const group = view.container.querySelector('[data-component="RuntimeTypeGroup"]');
          if (!group) {
            throw new Error("Runtime controls not found");
          }
        },
        { timeout: 5_000 }
      );

      const dockerButton = findRuntimeButton(view.container, "Docker");
      expect(dockerButton).toBeTruthy();
      fireEvent.click(dockerButton!);

      // Verify Docker button becomes active
      await waitFor(
        () => {
          const btn = findRuntimeButton(view.container, "Docker");
          if (!btn) throw new Error("Docker button not found");
          if (btn.getAttribute("aria-pressed") !== "true") {
            throw new Error("Docker runtime not selected");
          }
        },
        { timeout: 2_000 }
      );

      // Docker image input should appear
      const imageInput = await waitFor(
        () => {
          const input = view.container.querySelector(
            'input[placeholder="node:20"]'
          ) as HTMLInputElement | null;
          if (!input) {
            throw new Error("Docker image input not found");
          }
          return input;
        },
        { timeout: 2_000 }
      );

      // SSH host input should NOT be visible
      const hostInput = view.container.querySelector('input[placeholder="user@host"]');
      expect(hostInput).toBeNull();

      fireEvent.change(imageInput, { target: { value: "node:20" } });
      expect(imageInput.value).toBe("node:20");

      // Switching to SSH should hide Docker image input and show host input
      const sshButton = findRuntimeButton(view.container, "SSH");
      expect(sshButton).toBeTruthy();
      fireEvent.click(sshButton!);

      await waitFor(
        () => {
          const input = view.container.querySelector(
            'input[placeholder="user@host"]'
          ) as HTMLInputElement | null;
          if (!input) throw new Error("SSH host input not found");
        },
        { timeout: 2_000 }
      );

      const imageInputAfter = view.container.querySelector('input[placeholder="node:20"]');
      expect(imageInputAfter).toBeNull();
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);

  test("Docker runtime is disabled for non-git projects", async () => {
    const cleanupDom = installDom();

    const projectPath = "/Users/dev/non-git-docker-project";
    expandProjects([projectPath]);

    // For non-git projects, the backend returns runtimeAvailability with git-based
    // runtimes unavailable. The UI uses this to disable the buttons.
    const client = createMockORPCClient({
      projects: new Map([projectWithNoWorkspaces(projectPath)]),
      workspaces: [],
      listBranches: async () => ({ branches: [], recommendedTrunk: null }),
      runtimeAvailability: {
        local: { available: true },
        worktree: { available: false, reason: "Requires git repository" },
        ssh: { available: false, reason: "Requires git repository" },
        docker: { available: false, reason: "Requires git repository" },
        devcontainer: { available: false, reason: "Requires git repository" },
      },
    });

    const view = renderApp({ apiClient: client });

    try {
      await view.waitForReady();
      await openProjectCreationView(view.container, projectPath);

      // Wait for the git init banner to confirm the project is treated as non-git
      await waitFor(
        () => {
          const banner = view.container.querySelector('[data-testid="git-init-banner"]');
          if (!banner) {
            throw new Error("Git init banner not found");
          }
        },
        { timeout: 5_000 }
      );

      // Local should be forced when repo is not a git repository
      await waitFor(
        () => {
          const localButton = findRuntimeButton(view.container, "Local");
          if (!localButton) throw new Error("Local button not found");
          if (localButton.getAttribute("aria-pressed") !== "true") {
            throw new Error("Local runtime not selected for non-git repo");
          }
        },
        { timeout: 2_000 }
      );

      const dockerButton = findRuntimeButton(view.container, "Docker");
      expect(dockerButton).toBeTruthy();
      expect(dockerButton!.disabled).toBe(true);
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);
});
