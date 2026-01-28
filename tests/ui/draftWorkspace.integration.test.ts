/**
 * Integration tests for draft workspace behavior.
 *
 * Tests that clicking "New Workspace" reuses existing empty drafts
 * instead of creating new ones.
 */

import "./dom";

import { fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as path from "node:path";

import { shouldRunIntegrationTests } from "../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  getSharedEnv,
  getSharedRepoPath,
} from "../ipc/sendMessageTestHelpers";

import { cleanupView, setupTestDom } from "./helpers";
import { renderApp, type RenderedApp } from "./renderReviewPanel";

import { WORKSPACE_DRAFTS_BY_PROJECT_KEY } from "@/common/constants/storage";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

/** Get all draft IDs for a project from localStorage */
function getDraftIds(projectPath: string): string[] {
  const rawDrafts = globalThis.localStorage.getItem(WORKSPACE_DRAFTS_BY_PROJECT_KEY);
  const parsedDrafts = rawDrafts
    ? (JSON.parse(rawDrafts) as Record<string, { draftId: string }[]>)
    : {};
  const draftsForProject = parsedDrafts[projectPath] ?? [];
  return draftsForProject.map((d) => d.draftId);
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

/**
 * Add a project through the sidebar modal.
 * Radix Dialog content is portaled to document.body, so query the body instead of the app container.
 */
async function addProjectViaUI(view: RenderedApp, projectPath: string): Promise<string> {
  const existingProjectPaths = new Set(
    Array.from(view.container.querySelectorAll("[data-project-path]"))
      .map((element) => element.getAttribute("data-project-path"))
      .filter((value): value is string => !!value)
  );

  const addProjectButton = await waitFor(
    () => {
      const button = view.container.querySelector('[aria-label="Add project"]');
      if (!button) {
        throw new Error("Add project button not found");
      }
      return button as HTMLElement;
    },
    { timeout: 10_000 }
  );

  fireEvent.click(addProjectButton);

  const body = within(view.container.ownerDocument.body);
  const dialog = await body.findByRole("dialog", {}, { timeout: 10_000 });
  const dialogCanvas = within(dialog);

  const pathInput = await dialogCanvas.findByRole("textbox", {}, { timeout: 10_000 });
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.clear(pathInput);
  await user.type(pathInput, projectPath);

  const submitButton = await dialogCanvas.findByRole(
    "button",
    { name: /add project/i },
    { timeout: 10_000 }
  );
  fireEvent.click(submitButton);

  const projectRow = await waitFor(
    () => {
      const error = dialog.querySelector(".text-error");
      if (error?.textContent) {
        throw new Error(`Project creation failed: ${error.textContent}`);
      }

      const rows = Array.from(view.container.querySelectorAll("[data-project-path]"));
      const newRow = rows.find((row) => {
        const path = row.getAttribute("data-project-path");
        return !!path && !existingProjectPaths.has(path);
      });

      if (!newRow) {
        throw new Error("Project row not found after adding project");
      }

      return newRow as HTMLElement;
    },
    { timeout: 10_000 }
  );

  const normalizedPath = projectRow.getAttribute("data-project-path");
  if (!normalizedPath) {
    throw new Error("Project row missing data-project-path");
  }

  return normalizedPath;
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
    globalThis.localStorage.removeItem(WORKSPACE_DRAFTS_BY_PROJECT_KEY);

    const view = renderApp({ apiClient: env.orpc });

    try {
      await view.waitForReady();
      const normalizedProjectPath = await addProjectViaUI(view, projectPath);
      const projectName = path.basename(normalizedProjectPath);

      // Click project row to open creation view (creates first draft)
      const projectRow = await waitFor(
        () => {
          const el = view.container.querySelector(
            `[data-project-path="${normalizedProjectPath}"][aria-controls]`
          );
          if (!el) throw new Error("Project row not found");
          return el as HTMLElement;
        },
        { timeout: 5_000 }
      );
      fireEvent.click(projectRow);

      // Wait for creation textarea to appear
      await waitFor(
        () => {
          const textarea = view.container.querySelector("textarea");
          if (!textarea) throw new Error("Creation textarea not found");
        },
        { timeout: 5_000 }
      );

      // Verify first draft was created
      const [firstDraftId] = await waitForDraftCount(normalizedProjectPath, 1);
      expect(firstDraftId).toBeTruthy();

      // Click "New Workspace" button - should reuse empty draft, not create new one
      const newChatButton = await waitFor(
        () => {
          const btn = view.container.querySelector(`[aria-label="New chat in ${projectName}"]`);
          if (!btn) throw new Error(`New chat button not found for ${projectName}`);
          return btn as HTMLElement;
        },
        { timeout: 5_000 }
      );
      fireEvent.click(newChatButton);

      // Verify still only 1 draft (reused the empty one)
      await new Promise((r) => setTimeout(r, 500));
      const draftsAfterSecondClick = getDraftIds(normalizedProjectPath);

      expect(draftsAfterSecondClick.length).toBe(1);
      expect(draftsAfterSecondClick[0]).toBe(firstDraftId);
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 60_000);
});
