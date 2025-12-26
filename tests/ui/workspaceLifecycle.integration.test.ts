/**
 * Integration tests for workspace lifecycle operations.
 *
 * Tests cover:
 * - Workspace creation and navigation
 * - Archive/unarchive operations (via UI clicks)
 * - Workspace deletion (via UI clicks)
 *
 * Note: These tests drive the UI from the user's perspective - clicking buttons,
 * not calling backend APIs directly for the actions being tested.
 */

import { fireEvent, waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  getSharedEnv,
  getSharedRepoPath,
  withSharedWorkspace,
} from "../ipc/sendMessageTestHelpers";
import { generateBranchName } from "../ipc/helpers";
import { detectDefaultTrunkBranch } from "../../src/node/git";

import { installDom } from "./dom";
import { renderApp } from "./renderReviewPanel";
import { cleanupView, setupWorkspaceView } from "./helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("Workspace Creation (UI)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("workspace selection persists after clicking workspace in sidebar", async () => {
    // Use withSharedWorkspace to get a properly created workspace
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderApp({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Click the workspace again to simulate navigation
        const wsElement = view.container.querySelector(
          `[data-workspace-id="${workspaceId}"]`
        ) as HTMLElement;
        fireEvent.click(wsElement);

        // Give React time to process the navigation
        await new Promise((r) => setTimeout(r, 100));

        // Verify we're in the workspace view (should see message list or chat input)
        await waitFor(
          () => {
            const messageArea = view.container.querySelector(
              '[role="log"], [data-testid="chat-input"], textarea'
            );
            if (!messageArea) {
              throw new Error("Not in workspace view");
            }
          },
          { timeout: 5_000 }
        );

        // Verify we're NOT on home screen
        // Home screen would mean the navigation raced and lost
        const homeScreen = view.container.querySelector('[data-testid="home-screen"]');
        expect(homeScreen).toBeNull();

        // Verify workspace is still in sidebar
        const wsElementAfter = view.container.querySelector(`[data-workspace-id="${workspaceId}"]`);
        expect(wsElementAfter).toBeTruthy();
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 30_000);

  test("workspace metadata contains required navigation fields", async () => {
    // Use withSharedWorkspace to get a properly created workspace and verify
    // the metadata has all fields needed for navigation
    await withSharedWorkspace("anthropic", async ({ metadata }) => {
      // These fields are required for toWorkspaceSelection() in onWorkspaceCreated
      expect(metadata.id).toBeTruthy();
      expect(metadata.projectPath).toBeTruthy();
      expect(metadata.projectName).toBeTruthy();
      expect(metadata.namedWorkspacePath).toBeTruthy();
    });
  }, 30_000);
});

describeIntegration("Workspace Archive (UI)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("clicking archive button on active workspace navigates to project page", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();
    const branchName = generateBranchName("test-archive-ui");
    const trunkBranch = await detectDefaultTrunkBranch(projectPath);

    // Create workspace (setup - OK to use API)
    const createResult = await env.orpc.workspace.create({
      projectPath,
      branchName,
      trunkBranch,
    });
    if (!createResult.success) throw new Error(createResult.error);
    const metadata = createResult.metadata;
    const workspaceId = metadata.id;
    const displayTitle = metadata.title ?? metadata.name;

    const cleanupDom = installDom();
    const view = renderApp({
      apiClient: env.orpc,
      metadata,
    });

    try {
      // Navigate to the workspace (make it active)
      await setupWorkspaceView(view, metadata, workspaceId);

      // Verify we're in the workspace view
      await waitFor(
        () => {
          const wsView = view.container.querySelector(
            '[role="log"], [data-testid="chat-input"], textarea'
          );
          if (!wsView) throw new Error("Not in workspace view");
        },
        { timeout: 5_000 }
      );

      // Find and click the archive button in the sidebar
      const archiveButton = await waitFor(
        () => {
          const btn = view.container.querySelector(
            `[aria-label="Archive workspace ${displayTitle}"]`
          ) as HTMLElement;
          if (!btn) throw new Error("Archive button not found");
          return btn;
        },
        { timeout: 5_000 }
      );
      fireEvent.click(archiveButton);

      // Wait for navigation to project page (workspace disappears from sidebar)
      await waitFor(
        () => {
          const el = view.container.querySelector(`[data-workspace-id="${workspaceId}"]`);
          if (el) throw new Error("Workspace still visible after archive");
        },
        { timeout: 5_000 }
      );

      // Should NOT be on home screen
      const homeScreen = view.container.querySelector('[data-testid="home-screen"]');
      expect(homeScreen).toBeNull();

      // Should be on the project page (has creation textarea for new workspace)
      await waitFor(
        () => {
          const creationTextarea = view.container.querySelector("textarea");
          if (!creationTextarea) {
            throw new Error("Not on project page after archiving");
          }
        },
        { timeout: 5_000 }
      );
    } finally {
      // Cleanup (OK to use API)
      await env.orpc.workspace.unarchive({ workspaceId }).catch(() => {});
      await env.orpc.workspace.remove({ workspaceId }).catch(() => {});
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);
});

describeIntegration("Workspace Delete from Archive (UI)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("clicking delete on archived workspace stays on project page", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();
    const branchName = generateBranchName("test-delete-archived-ui");
    const trunkBranch = await detectDefaultTrunkBranch(projectPath);

    // Create and archive workspace (setup - OK to use API)
    const createResult = await env.orpc.workspace.create({
      projectPath,
      branchName,
      trunkBranch,
    });
    if (!createResult.success) throw new Error(createResult.error);
    const metadata = createResult.metadata;
    const workspaceId = metadata.id;
    const displayTitle = metadata.title ?? metadata.name;

    await env.orpc.workspace.archive({ workspaceId });

    const cleanupDom = installDom();
    const view = renderApp({
      apiClient: env.orpc,
      metadata,
    });

    try {
      await view.waitForReady();

      // Click the project to navigate to project page (where archived workspaces show)
      const projectRow = await waitFor(
        () => {
          const el = view.container.querySelector(`[data-project-path="${projectPath}"]`);
          if (!el) throw new Error("Project not found");
          return el as HTMLElement;
        },
        { timeout: 5_000 }
      );
      fireEvent.click(projectRow);

      // Wait for project page to render with archived workspaces section
      await waitFor(
        () => {
          const archivedSection = view.container.querySelector('[class*="Archived"]');
          const textarea = view.container.querySelector("textarea");
          if (!archivedSection && !textarea) {
            throw new Error("Project page not rendered");
          }
        },
        { timeout: 5_000 }
      );

      // Find the delete button for our archived workspace
      const deleteButton = await waitFor(
        () => {
          const btn = view.container.querySelector(
            `[aria-label="Delete workspace ${displayTitle}"]`
          ) as HTMLElement;
          if (!btn) throw new Error("Delete button not found in archived list");
          return btn;
        },
        { timeout: 5_000 }
      );

      // Click delete
      fireEvent.click(deleteButton);

      // Wait for the delete button to disappear (workspace removed from archived list)
      await waitFor(
        () => {
          const btn = view.container.querySelector(
            `[aria-label="Delete workspace ${displayTitle}"]`
          );
          if (btn) throw new Error("Delete button still present - deletion not complete");
        },
        { timeout: 5_000 }
      );

      // Should still be on project page (not navigated to home)
      const homeScreen = view.container.querySelector('[data-testid="home-screen"]');
      expect(homeScreen).toBeNull();

      // Project should still be visible
      const projectStillVisible = view.container.querySelector(
        `[data-project-path="${projectPath}"]`
      );
      expect(projectStillVisible).toBeTruthy();

      // Textarea for creating new workspace should still be there
      const creationTextarea = view.container.querySelector("textarea");
      expect(creationTextarea).toBeTruthy();
    } finally {
      // Workspace should be deleted, but cleanup just in case
      await env.orpc.workspace.remove({ workspaceId, options: { force: true } }).catch(() => {});
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);
});
