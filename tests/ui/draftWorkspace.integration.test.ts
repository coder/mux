/**
 * Integration tests for draft workspace behavior.
 *
 * Tests that clicking "New Workspace" reuses existing empty drafts
 * instead of creating new ones.
 */

import { fireEvent, waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  getSharedEnv,
  getSharedRepoPath,
} from "../ipc/sendMessageTestHelpers";
import { generateBranchName } from "../ipc/helpers";
import { detectDefaultTrunkBranch } from "../../src/node/git";

import { renderApp } from "./renderReviewPanel";
import { cleanupView, openProjectCreationView, setupTestDom } from "./helpers";

import { WORKSPACE_DRAFTS_BY_PROJECT_KEY } from "@/common/constants/storage";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

type DraftTestView = {
  env: ReturnType<typeof getSharedEnv>;
  projectPath: string;
  projectName: string;
  workspaceId: string;
  view: ReturnType<typeof renderApp>;
  cleanupDom: () => void;
};

async function setupDraftTestView(): Promise<DraftTestView> {
  const env = getSharedEnv();
  const projectPath = getSharedRepoPath();
  const branchName = generateBranchName("draft-test");
  const trunkBranch = await detectDefaultTrunkBranch(projectPath);

  const createResult = await env.orpc.workspace.create({
    projectPath,
    branchName,
    trunkBranch,
  });
  if (!createResult.success) {
    throw new Error(createResult.error);
  }

  const metadata = createResult.metadata;
  const workspaceId = metadata.id;
  if (!workspaceId) {
    throw new Error("Workspace ID not returned from creation");
  }

  // Archive the workspace so we have a project but no active workspaces
  await env.orpc.workspace.archive({ workspaceId });

  const cleanupDom = setupTestDom();
  // Clear any existing drafts from previous tests
  globalThis.localStorage.removeItem(WORKSPACE_DRAFTS_BY_PROJECT_KEY);

  const view = renderApp({ apiClient: env.orpc, metadata });

  await view.waitForReady();

  // Wait for project to appear in sidebar
  await waitFor(
    () => {
      const el = view.container.querySelector(`[data-project-path="${projectPath}"]`);
      if (!el) throw new Error("Project not found in sidebar");
    },
    { timeout: 10_000 }
  );

  return {
    env,
    projectPath,
    projectName: metadata.projectName,
    workspaceId,
    view,
    cleanupDom,
  };
}

/** Get all draft IDs for a project from localStorage */
function getDraftIds(projectPath: string): string[] {
  const rawDrafts = globalThis.localStorage.getItem(WORKSPACE_DRAFTS_BY_PROJECT_KEY);
  const parsedDrafts = rawDrafts
    ? (JSON.parse(rawDrafts) as Record<string, { draftId: string }[]>)
    : {};
  const draftsForProject = parsedDrafts[projectPath] ?? [];
  return draftsForProject.map((d) => d.draftId);
}

/** Click the "New chat" button for a project */
async function clickNewWorkspaceButton(container: HTMLElement, projectName: string): Promise<void> {
  const button = await waitFor(
    () => {
      const btn = container.querySelector(`[aria-label="New chat in ${projectName}"]`);
      if (!btn) throw new Error(`New chat button not found for ${projectName}`);
      return btn as HTMLElement;
    },
    { timeout: 5_000 }
  );
  fireEvent.click(button);
}

/** Wait for a specific number of drafts to exist */
async function waitForDraftCount(projectPath: string, count: number): Promise<string[]> {
  return await waitFor(
    () => {
      const ids = getDraftIds(projectPath);
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
    const { env, projectPath, projectName, workspaceId, view, cleanupDom } =
      await setupDraftTestView();

    try {
      // Open the project creation view (creates a draft and navigates to it)
      await openProjectCreationView(view, projectPath);

      // Wait for first draft to be created in localStorage and verify it exists
      const [firstDraftId] = await waitForDraftCount(projectPath, 1);
      expect(firstDraftId).toBeTruthy();

      // Click "New Workspace" button again - should NOT create a new draft
      // because the existing one is empty
      await clickNewWorkspaceButton(view.container, projectName);

      // Wait a moment and verify still only 1 draft
      await new Promise((r) => setTimeout(r, 500));
      const draftsAfterSecondClick = getDraftIds(projectPath);

      expect(draftsAfterSecondClick.length).toBe(1);
      expect(draftsAfterSecondClick[0]).toBe(firstDraftId);
    } finally {
      await env.orpc.workspace.remove({ workspaceId, options: { force: true } }).catch(() => {});
      await cleanupView(view, cleanupDom);
    }
  }, 60_000);
});
