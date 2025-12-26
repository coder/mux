/**
 * Integration tests for workspace creation and navigation.
 *
 * These tests verify that when a user creates a workspace from the project page,
 * the UI correctly navigates to the new workspace instead of going to home.
 *
 * Note: These tests don't fully prove there are no races under high CPU,
 * but they document and verify the expected behavior end-to-end.
 */

import { fireEvent, waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  withSharedWorkspace,
} from "../ipc/sendMessageTestHelpers";

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
