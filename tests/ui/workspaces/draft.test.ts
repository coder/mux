/**
 * Integration tests for draft workspace behavior.
 *
 * Tests that clicking "New Workspace" reuses existing empty drafts
 * instead of creating new ones.
 */

import "../dom";

import { fireEvent, waitFor } from "@testing-library/react";
import * as path from "node:path";

import { shouldRunIntegrationTests } from "../../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  getSharedEnv,
  getSharedRepoPath,
} from "../../ipc/sendMessageTestHelpers";

import {
  addProjectViaUI,
  cleanupView,
  getWorkspaceDraftIds,
  openProjectCreationView,
  setupTestDom,
} from "../helpers";
import { renderApp } from "../renderReviewPanel";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";

import { WORKSPACE_DRAFTS_BY_PROJECT_KEY } from "@/common/constants/storage";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

/** Wait for a specific number of drafts to exist */
async function waitForDraftCount(projectPath: string, count: number): Promise<string[]> {
  return await waitFor(
    () => {
      const ids = getWorkspaceDraftIds(projectPath);
      if (ids.length !== count) {
        throw new Error(`Expected ${count} drafts, got ${ids.length}`);
      }
      return ids;
    },
    { timeout: 5_000 }
  );
}

describeIntegration("Draft workspace behavior", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("clicking New Workspace reuses existing empty draft instead of creating another", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();

    const cleanupDom = setupTestDom();
    // Clear any existing drafts from previous tests
    updatePersistedState(WORKSPACE_DRAFTS_BY_PROJECT_KEY, null);

    const view = renderApp({ apiClient: env.orpc });

    try {
      await view.waitForReady();
      const normalizedProjectPath = await addProjectViaUI(view, projectPath);
      const projectName = path.basename(normalizedProjectPath);

      await openProjectCreationView(view, normalizedProjectPath);

      // Verify first draft was created
      const [firstDraftId] = await waitForDraftCount(normalizedProjectPath, 1);
      expect(firstDraftId).toBeTruthy();

      // Click "New Workspace" button - should reuse empty draft, not create new one
      const newChatButton = await waitFor(
        () => {
          const btn = view.container.querySelector(
            `[aria-label="New workspace in ${projectName}"]`
          );
          if (!btn) throw new Error(`New workspace button not found for ${projectName}`);
          return btn as HTMLElement;
        },
        { timeout: 5_000 }
      );
      fireEvent.click(newChatButton);

      // Verify still only 1 draft (reused the empty one)
      await waitFor(
        () => {
          const draftsAfterSecondClick = getWorkspaceDraftIds(normalizedProjectPath);
          expect(draftsAfterSecondClick.length).toBe(1);
          expect(draftsAfterSecondClick[0]).toBe(firstDraftId);
        },
        { timeout: 5_000 }
      );
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 60_000);

  test("draft row is hidden in sidebar when empty", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();

    const cleanupDom = setupTestDom();
    updatePersistedState(WORKSPACE_DRAFTS_BY_PROJECT_KEY, null);

    const view = renderApp({ apiClient: env.orpc });

    try {
      await view.waitForReady();
      const normalizedProjectPath = await addProjectViaUI(view, projectPath);

      await openProjectCreationView(view, normalizedProjectPath);

      // A draft exists in storage for reuse, but no row appears in the sidebar.
      const [draftId] = await waitForDraftCount(normalizedProjectPath, 1);
      expect(draftId).toBeTruthy();
      expect(view.container.querySelector("[data-draft-id]")).toBeNull();
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 60_000);

  test("clicking New Chat before typing reuses hidden draft without showing duplicates", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();

    const cleanupDom = setupTestDom();
    updatePersistedState(WORKSPACE_DRAFTS_BY_PROJECT_KEY, null);

    const view = renderApp({ apiClient: env.orpc });

    try {
      await view.waitForReady();
      const normalizedProjectPath = await addProjectViaUI(view, projectPath);
      const projectName = path.basename(normalizedProjectPath);

      await openProjectCreationView(view, normalizedProjectPath);

      const [draftId] = await waitForDraftCount(normalizedProjectPath, 1);
      expect(draftId).toBeTruthy();
      expect(view.container.querySelector("[data-draft-id]")).toBeNull();

      const newChatButton = await waitFor(
        () => {
          const btn = view.container.querySelector(
            `[aria-label="New workspace in ${projectName}"]`
          );
          if (!btn) throw new Error(`New workspace button not found for ${projectName}`);
          return btn as HTMLElement;
        },
        { timeout: 5_000 }
      );
      fireEvent.click(newChatButton);

      await waitFor(
        () => {
          expect(getWorkspaceDraftIds(normalizedProjectPath)).toEqual([draftId]);
          expect(view.container.querySelector("[data-draft-id]")).toBeNull();
        },
        { timeout: 5_000 }
      );
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 60_000);
});
