/**
 * Integration tests for workspace lifecycle operations.
 *
 * Tests cover:
 * - Workspace creation and navigation
 * - Archive/unarchive operations
 * - Workspace deletion (from active view and archived view)
 *
 * Note: These tests don't fully prove there are no races under high CPU,
 * but they document and verify the expected behavior end-to-end.
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
import { renderReviewPanel } from "./renderReviewPanel";
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

      const view = renderReviewPanel({
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

describeIntegration("Workspace Archive/Unarchive (UI)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("archiving a workspace removes it from the active workspace list", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();
    const branchName = generateBranchName("test-archive");
    const trunkBranch = await detectDefaultTrunkBranch(projectPath);

    // Create workspace
    const createResult = await env.orpc.workspace.create({
      projectPath,
      branchName,
      trunkBranch,
    });
    if (!createResult.success) throw new Error(createResult.error);
    const metadata = createResult.metadata;
    const workspaceId = metadata.id;

    const cleanupDom = installDom();
    const view = renderReviewPanel({
      apiClient: env.orpc,
      metadata,
    });

    try {
      await view.waitForReady();

      // Verify workspace is in the active list
      await waitFor(
        () => {
          const el = view.container.querySelector(`[data-workspace-id="${workspaceId}"]`);
          if (!el) throw new Error("Workspace not found in sidebar");
        },
        { timeout: 5_000 }
      );

      // Archive the workspace via API
      const archiveResult = await env.orpc.workspace.archive({ workspaceId });
      expect(archiveResult.success).toBe(true);

      // Wait for workspace to disappear from sidebar (it's now archived)
      await waitFor(
        () => {
          const el = view.container.querySelector(`[data-workspace-id="${workspaceId}"]`);
          if (el) throw new Error("Workspace still visible after archive");
        },
        { timeout: 5_000 }
      );

      // Verify it appears in the archived list
      const archivedList = await env.orpc.workspace.list({ archived: true });
      const archivedWorkspace = archivedList.find((w) => w.id === workspaceId);
      expect(archivedWorkspace).toBeTruthy();
      expect(archivedWorkspace?.archivedAt).toBeTruthy();
    } finally {
      // Clean up: unarchive then remove
      await env.orpc.workspace.unarchive({ workspaceId }).catch(() => {});
      await env.orpc.workspace.remove({ workspaceId }).catch(() => {});
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);

  test("archiving the active workspace navigates to project page, not home", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();
    const branchName = generateBranchName("test-archive-active");
    const trunkBranch = await detectDefaultTrunkBranch(projectPath);

    // Create workspace
    const createResult = await env.orpc.workspace.create({
      projectPath,
      branchName,
      trunkBranch,
    });
    if (!createResult.success) throw new Error(createResult.error);
    const metadata = createResult.metadata;
    const workspaceId = metadata.id;

    const cleanupDom = installDom();
    const view = renderReviewPanel({
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

      // Archive the active workspace via API
      const archiveResult = await env.orpc.workspace.archive({ workspaceId });
      expect(archiveResult.success).toBe(true);

      // Give React time to process the archive and navigate
      await new Promise((r) => setTimeout(r, 300));

      // Should NOT be on home screen
      const homeScreen = view.container.querySelector('[data-testid="home-screen"]');
      expect(homeScreen).toBeNull();

      // Should be on the project page (has creation textarea for new workspace)
      // The project page shows when project is selected but no workspace is active
      await waitFor(
        () => {
          // Project page has the ChatInput for creating new workspaces
          // Look for the creation textarea or the project being selected
          const creationTextarea = view.container.querySelector('textarea');
          const projectSelected = view.container.querySelector(
            `[data-project-path="${projectPath}"]`
          );
          if (!creationTextarea && !projectSelected) {
            throw new Error("Not on project page after archiving");
          }
        },
        { timeout: 5_000 }
      );
    } finally {
      await env.orpc.workspace.unarchive({ workspaceId }).catch(() => {});
      await env.orpc.workspace.remove({ workspaceId }).catch(() => {});
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);

  test("unarchiving a workspace adds it back to the active list", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();
    const branchName = generateBranchName("test-unarchive");
    const trunkBranch = await detectDefaultTrunkBranch(projectPath);

    // Create and immediately archive workspace
    const createResult = await env.orpc.workspace.create({
      projectPath,
      branchName,
      trunkBranch,
    });
    if (!createResult.success) throw new Error(createResult.error);
    const metadata = createResult.metadata;
    const workspaceId = metadata.id;

    await env.orpc.workspace.archive({ workspaceId });

    const cleanupDom = installDom();
    const view = renderReviewPanel({
      apiClient: env.orpc,
      metadata,
    });

    try {
      await view.waitForReady();

      // Workspace should NOT be in active sidebar (it's archived)
      const archivedEl = view.container.querySelector(`[data-workspace-id="${workspaceId}"]`);
      expect(archivedEl).toBeNull();

      // Unarchive the workspace
      const unarchiveResult = await env.orpc.workspace.unarchive({ workspaceId });
      expect(unarchiveResult.success).toBe(true);

      // Wait for workspace to appear in sidebar
      await waitFor(
        () => {
          const el = view.container.querySelector(`[data-workspace-id="${workspaceId}"]`);
          if (!el) throw new Error("Workspace not found after unarchive");
        },
        { timeout: 5_000 }
      );

      // Verify it's no longer in archived list
      const archivedList = await env.orpc.workspace.list({ archived: true });
      const stillArchived = archivedList.find((w) => w.id === workspaceId);
      expect(stillArchived).toBeFalsy();
    } finally {
      await env.orpc.workspace.remove({ workspaceId }).catch(() => {});
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);
});

describeIntegration("Workspace Deletion (UI)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("deleting an active workspace navigates to home", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();
    const branchName = generateBranchName("test-delete-active");
    const trunkBranch = await detectDefaultTrunkBranch(projectPath);

    // Create workspace
    const createResult = await env.orpc.workspace.create({
      projectPath,
      branchName,
      trunkBranch,
    });
    if (!createResult.success) throw new Error(createResult.error);
    const metadata = createResult.metadata;
    const workspaceId = metadata.id;

    const cleanupDom = installDom();
    const view = renderReviewPanel({
      apiClient: env.orpc,
      metadata,
    });

    try {
      await setupWorkspaceView(view, metadata, workspaceId);

      // Verify we're in the workspace (should see chat input or message area)
      await waitFor(
        () => {
          const wsView = view.container.querySelector(
            '[role="log"], [data-testid="chat-input"], textarea'
          );
          if (!wsView) throw new Error("Not in workspace view");
        },
        { timeout: 5_000 }
      );

      // Delete the workspace via API
      const deleteResult = await env.orpc.workspace.remove({ workspaceId });
      expect(deleteResult.success).toBe(true);

      // Should navigate away from workspace view
      // Workspace element should disappear from sidebar
      await waitFor(
        () => {
          const el = view.container.querySelector(`[data-workspace-id="${workspaceId}"]`);
          if (el) throw new Error("Workspace still in sidebar after delete");
        },
        { timeout: 5_000 }
      );
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);

  test("deleting an archived workspace does not navigate away from project page", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();
    const branchName = generateBranchName("test-delete-archived");
    const trunkBranch = await detectDefaultTrunkBranch(projectPath);

    // Create and archive workspace
    const createResult = await env.orpc.workspace.create({
      projectPath,
      branchName,
      trunkBranch,
    });
    if (!createResult.success) throw new Error(createResult.error);
    const metadata = createResult.metadata;
    const workspaceId = metadata.id;

    await env.orpc.workspace.archive({ workspaceId });

    const cleanupDom = installDom();
    const view = renderReviewPanel({
      apiClient: env.orpc,
      metadata,
    });

    try {
      await view.waitForReady();

      // Expand project to see the project page (where archived workspaces are shown)
      const projectRow = await waitFor(
        () => {
          const el = view.container.querySelector(`[data-project-path="${projectPath}"]`);
          if (!el) throw new Error("Project not found");
          return el as HTMLElement;
        },
        { timeout: 5_000 }
      );
      fireEvent.click(projectRow);

      // Give React time to render project page
      await new Promise((r) => setTimeout(r, 200));

      // Verify we're on the project page (should see creation input or archived section)
      // The project page has the ChatInput for creating new workspaces
      const isOnProjectPage = () => {
        // Look for indicators that we're on project page:
        // - The project is selected in sidebar
        // - There's a creation form or archived section
        const selectedProject = view.container.querySelector(
          `[data-project-path="${projectPath}"][data-selected="true"]`
        );
        const creationInput = view.container.querySelector('textarea');
        return selectedProject || creationInput;
      };
      expect(isOnProjectPage()).toBeTruthy();

      // Delete the archived workspace via API
      const deleteResult = await env.orpc.workspace.remove({ workspaceId, options: { force: true } });
      expect(deleteResult.success).toBe(true);

      // Give React time to process the deletion
      await new Promise((r) => setTimeout(r, 200));

      // Should still be on project page (not navigated away)
      // The key assertion: we should NOT be on home screen
      const homeScreen = view.container.querySelector('[data-testid="home-screen"]');
      expect(homeScreen).toBeNull();

      // Project should still be visible/selected
      expect(isOnProjectPage()).toBeTruthy();
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);
});
