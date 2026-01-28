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
import { cleanupView, openProjectCreationView, setupWorkspaceView } from "./helpers";

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

  test("archiving the active workspace navigates to project page, not home", async () => {
    // Use withSharedWorkspace to get a properly initialized workspace
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const projectPath = metadata.projectPath;
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

        // Find and click the archive button in sidebar
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

        // Wait for workspace to be archived (disappears from active list)
        await waitFor(
          () => {
            const wsEl = view.container.querySelector(`[data-workspace-id="${workspaceId}"]`);
            if (wsEl) throw new Error("Workspace still in sidebar");
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
        await cleanupView(view, cleanupDom);
      }
    });
  }, 30_000);
});

describeIntegration("Workspace Archive List Reactivity (UI)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("newly archived workspace appears immediately in archive list after archiving from workspace view", async () => {
    // Bug regression: archiving a workspace didn't update the archive list reactively.
    // When archiving the currently-viewed workspace, app navigates to project page
    // and the archived workspace should appear in the list immediately.
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();
    const trunkBranch = await detectDefaultTrunkBranch(projectPath);

    // Create TWO workspaces - one to archive first (so archive section exists),
    // and one to archive while viewing the archive list
    const firstBranch = generateBranchName("test-archive-reactivity-first");
    const secondBranch = generateBranchName("test-archive-reactivity-second");

    const firstResult = await env.orpc.workspace.create({
      projectPath,
      branchName: firstBranch,
      trunkBranch,
    });
    if (!firstResult.success) throw new Error(firstResult.error);
    const firstWorkspace = firstResult.metadata;

    const secondResult = await env.orpc.workspace.create({
      projectPath,
      branchName: secondBranch,
      trunkBranch,
    });
    if (!secondResult.success) throw new Error(secondResult.error);
    const secondWorkspace = secondResult.metadata;
    const secondDisplayTitle = secondWorkspace.title ?? secondWorkspace.name;

    // Archive the first workspace so the archive section will be visible
    await env.orpc.workspace.archive({ workspaceId: firstWorkspace.id });

    const cleanupDom = installDom();
    const view = renderApp({
      apiClient: env.orpc,
      metadata: secondWorkspace,
    });

    try {
      // Select the second workspace so its archive button is visible
      await setupWorkspaceView(view, secondWorkspace, secondWorkspace.id);

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

      // Now archive the second workspace via sidebar button (user action)
      // This should navigate us to project page AND the workspace should appear in archive list
      const archiveButton = await waitFor(
        () => {
          const btn = view.container.querySelector(
            `[aria-label="Archive workspace ${secondDisplayTitle}"]`
          ) as HTMLElement;
          if (!btn) throw new Error("Archive button not found for second workspace");
          return btn;
        },
        { timeout: 5_000 }
      );
      fireEvent.click(archiveButton);

      // Wait for navigation to project page (archive redirects there).
      // We need to wait for the archived workspaces section to appear, not just a textarea,
      // since workspace views also have textareas and we might still be there briefly.
      const expandArchivedButton = await waitFor(
        () => {
          const expand = view.container.querySelector(
            '[aria-label="Expand archived workspaces"]'
          ) as HTMLElement | null;
          const collapse = view.container.querySelector(
            '[aria-label="Collapse archived workspaces"]'
          ) as HTMLElement | null;

          if (!expand && !collapse) {
            throw new Error(
              "Archived workspaces toggle not found - navigation may not have completed"
            );
          }

          return expand;
        },
        { timeout: 10_000 }
      );

      if (expandArchivedButton) {
        fireEvent.click(expandArchivedButton);
      }

      await waitFor(
        () => {
          const collapse = view.container.querySelector(
            '[aria-label="Collapse archived workspaces"]'
          );
          if (!collapse) {
            throw new Error("Archived workspaces not expanded");
          }
        },
        { timeout: 5_000 }
      );

      // KEY ASSERTION: The newly archived workspace should appear in the archive list
      // immediately WITHOUT requiring a manual refresh
      await waitFor(
        () => {
          const deleteBtn = view.container.querySelector(
            `[aria-label="Delete workspace ${secondDisplayTitle}"]`
          );
          if (!deleteBtn) {
            throw new Error("Newly archived workspace not found in archive list - reactivity bug!");
          }
        },
        { timeout: 5_000 }
      );

      // Also verify it's no longer in the active sidebar
      const stillInSidebar = view.container.querySelector(
        `[data-workspace-id="${secondWorkspace.id}"]`
      );
      expect(stillInSidebar).toBeNull();
    } finally {
      await env.orpc.workspace
        .remove({ workspaceId: firstWorkspace.id, options: { force: true } })
        .catch(() => {});
      await env.orpc.workspace
        .remove({ workspaceId: secondWorkspace.id, options: { force: true } })
        .catch(() => {});
      await cleanupView(view, cleanupDom);
    }
  }, 60_000);
});

describeIntegration("Workspace Delete from Archive (UI)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("clicking delete on archived workspace stays on project page", async () => {
    // Ensure deleting an archived workspace does not navigate away from the project page.
    // (Mux now boots into mux-chat, so tests must explicitly open ProjectPage.)
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();
    const branchName = generateBranchName("test-delete-default-view");
    const trunkBranch = await detectDefaultTrunkBranch(projectPath);

    // Create and archive workspace (setup)
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
      await openProjectCreationView(view, projectPath);

      // ArchivedWorkspaces is collapsed by default; expand so archived rows are visible.
      const expandArchivedButton = await waitFor(
        () => {
          const expand = view.container.querySelector(
            '[aria-label="Expand archived workspaces"]'
          ) as HTMLElement | null;
          const collapse = view.container.querySelector(
            '[aria-label="Collapse archived workspaces"]'
          ) as HTMLElement | null;

          if (!expand && !collapse) {
            throw new Error("Archived workspaces toggle not found");
          }

          return expand;
        },
        { timeout: 5_000 }
      );

      if (expandArchivedButton) {
        fireEvent.click(expandArchivedButton);
      }

      await waitFor(
        () => {
          const collapse = view.container.querySelector(
            '[aria-label="Collapse archived workspaces"]'
          );
          if (!collapse) {
            throw new Error("Archived workspaces not expanded");
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

      // Wait for the delete button to disappear
      await waitFor(
        () => {
          const btn = view.container.querySelector(
            `[aria-label="Delete workspace ${displayTitle}"]`
          );
          if (btn) throw new Error("Delete button still present");
        },
        { timeout: 5_000 }
      );

      // Should still see the project page (textarea for new workspace creation)
      const creationTextarea = view.container.querySelector("textarea");
      expect(creationTextarea).toBeTruthy();

      // Project should still be visible in sidebar
      const projectStillVisible = view.container.querySelector(
        `[data-project-path="${projectPath}"]`
      );
      expect(projectStillVisible).toBeTruthy();
    } finally {
      await env.orpc.workspace.remove({ workspaceId, options: { force: true } }).catch(() => {});
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);

  test("clicking delete on archived workspace stays on project page (explicit navigation)", async () => {
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
      await openProjectCreationView(view, projectPath);

      // ArchivedWorkspaces is collapsed by default; expand so archived rows are visible.
      const expandArchivedButton = await waitFor(
        () => {
          const expand = view.container.querySelector(
            '[aria-label="Expand archived workspaces"]'
          ) as HTMLElement | null;
          const collapse = view.container.querySelector(
            '[aria-label="Collapse archived workspaces"]'
          ) as HTMLElement | null;

          if (!expand && !collapse) {
            throw new Error("Archived workspaces toggle not found");
          }

          return expand;
        },
        { timeout: 5_000 }
      );

      if (expandArchivedButton) {
        fireEvent.click(expandArchivedButton);
      }

      await waitFor(
        () => {
          const collapse = view.container.querySelector(
            '[aria-label="Collapse archived workspaces"]'
          );
          if (!collapse) {
            throw new Error("Archived workspaces not expanded");
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
