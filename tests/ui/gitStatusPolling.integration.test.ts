import { cleanup, waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests, validateApiKeys } from "../testUtils";
import {
  cleanupSharedRepo,
  configureTestRetries,
  createSharedRepo,
  withSharedWorkspace,
} from "../ipc/sendMessageTestHelpers";

import { installDom } from "./dom";
import { renderReviewPanel, type RenderedApp } from "./renderReviewPanel";
import {
  getGitStatusFromElement,
  waitForGitStatusElement,
  waitForDirtyStatus,
  waitForCleanStatus,
} from "./helpers";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

configureTestRetries(2);

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

validateApiKeys(["ANTHROPIC_API_KEY"]);

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SETUP
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Set up the full App UI and navigate to the workspace.
 * Expands project tree and selects the workspace.
 */
async function setupWorkspaceView(
  view: RenderedApp,
  metadata: FrontendWorkspaceMetadata,
  workspaceId: string
): Promise<void> {
  await view.waitForReady();

  // Expand project tree
  const projectRow = await waitFor(
    () => {
      const el = view.container.querySelector(`[data-project-path="${metadata.projectPath}"]`);
      if (!el) throw new Error("Project not found in sidebar");
      return el as HTMLElement;
    },
    { timeout: 10_000 }
  );

  const expandButton = projectRow.querySelector('[aria-label*="Expand project"]');
  if (expandButton) {
    (expandButton as HTMLElement).click();
  } else {
    projectRow.click();
  }

  // Select the workspace
  const workspaceElement = await waitFor(
    () => {
      const el = view.container.querySelector(`[data-workspace-id="${workspaceId}"]`);
      if (!el) throw new Error("Workspace not found in sidebar");
      return el as HTMLElement;
    },
    { timeout: 10_000 }
  );
  workspaceElement.click();
}

// ═══════════════════════════════════════════════════════════════════════════════
// GIT STATUS POLLING TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describeIntegration("GitStatusPolling (UI + ORPC)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("initial git status shows clean state for fresh workspace", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Wait for git status to be fetched and displayed
        const statusElement = await waitForGitStatusElement(view.container, workspaceId);
        const status = getGitStatusFromElement(statusElement);

        expect(status).not.toBeNull();
        // Fresh workspace should be clean (no uncommitted changes)
        expect(status?.dirty).toBe(false);
      } finally {
        view.unmount();
        cleanup();
        await new Promise((r) => setTimeout(r, 100));
        cleanupDom();
      }
    });
  }, 120_000);

  test("git status updates after file modification via bash", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Verify initial clean state
        await waitForCleanStatus(view.container, workspaceId);

        // Make a file change via bash (triggers git status refresh)
        const MARKER = "GIT_STATUS_TEST_MARKER";
        const bashRes = await env.orpc.workspace.executeBash({
          workspaceId,
          script: `echo "${MARKER}" >> README.md`,
        });
        expect(bashRes.success).toBe(true);
        if (!bashRes.success) return;
        expect(bashRes.data.success).toBe(true);

        // Wait for git status to reflect the dirty state
        // GitStatusStore has a 3s debounce, so this needs some patience
        const dirtyStatus = await waitForDirtyStatus(view.container, workspaceId, 30_000);

        expect(dirtyStatus.dirty).toBe(true);
      } finally {
        view.unmount();
        cleanup();
        await new Promise((r) => setTimeout(r, 100));
        cleanupDom();
      }
    });
  }, 120_000);

  test("git status updates after staging changes", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Create an uncommitted change
        const MARKER = "STAGING_TEST_MARKER";
        let bashRes = await env.orpc.workspace.executeBash({
          workspaceId,
          script: `echo "${MARKER}" >> README.md`,
        });
        expect(bashRes.success).toBe(true);
        if (!bashRes.success) return;

        // Wait for dirty status
        await waitForDirtyStatus(view.container, workspaceId);

        // Stage the changes
        bashRes = await env.orpc.workspace.executeBash({
          workspaceId,
          script: "git add README.md",
        });
        expect(bashRes.success).toBe(true);

        // Status should still be dirty (staged but not committed)
        const status = await waitForDirtyStatus(view.container, workspaceId);
        expect(status.dirty).toBe(true);
      } finally {
        view.unmount();
        cleanup();
        await new Promise((r) => setTimeout(r, 100));
        cleanupDom();
      }
    });
  }, 120_000);

  test("git status shows clean after committing changes", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Create and commit a change
        const MARKER = "COMMIT_TEST_MARKER";
        let bashRes = await env.orpc.workspace.executeBash({
          workspaceId,
          script: `echo "${MARKER}" >> README.md && git add README.md && git commit -m "test commit"`,
        });
        expect(bashRes.success).toBe(true);
        if (!bashRes.success) return;
        expect(bashRes.data.success).toBe(true);

        // After commit, working directory should be clean
        const status = await waitForCleanStatus(view.container, workspaceId);
        expect(status.dirty).toBe(false);
        // Note: ahead count depends on branch tracking setup, which varies by workspace type
      } finally {
        view.unmount();
        cleanup();
        await new Promise((r) => setTimeout(r, 100));
        cleanupDom();
      }
    });
  }, 120_000);

  test("git status reflects ahead/behind remote tracking", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Make multiple commits to get ahead of remote
        for (let i = 0; i < 2; i++) {
          const bashRes = await env.orpc.workspace.executeBash({
            workspaceId,
            script: `echo "commit-${i}" >> README.md && git add README.md && git commit -m "test commit ${i}"`,
          });
          expect(bashRes.success).toBe(true);
          if (!bashRes.success) return;
        }

        // Wait for status update showing ahead count
        await waitFor(
          async () => {
            const el = view.container.querySelector(
              `[data-workspace-id="${workspaceId}"][data-git-status]`
            );
            if (!el) throw new Error("Git status element not found");
            const status = getGitStatusFromElement(el as HTMLElement);
            if (!status) throw new Error("Could not parse git status");
            // Should be ahead by at least 2 commits
            if ((status.ahead ?? 0) < 2) {
              throw new Error(`Expected ahead >= 2, got: ${status.ahead}`);
            }
          },
          { timeout: 30_000 }
        );
      } finally {
        view.unmount();
        cleanup();
        await new Promise((r) => setTimeout(r, 100));
        cleanupDom();
      }
    });
  }, 120_000);
});
