import { fireEvent, waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests, validateApiKeys } from "../testUtils";
import { STORAGE_KEYS } from "@/constants/workspaceDefaults";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  cleanupSharedRepo,
  configureTestRetries,
  createSharedRepo,
  withSharedWorkspace,
} from "../ipc/sendMessageTestHelpers";

import { installDom } from "./dom";
import { renderReviewPanel, type RenderedApp } from "./renderReviewPanel";
import { cleanupView, setupWorkspaceView } from "./helpers";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

configureTestRetries(2);

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

validateApiKeys(["ANTHROPIC_API_KEY"]);

/**
 * Helper to set up the full App UI and navigate to the Review tab.
 */
async function setupReviewPanel(
  view: RenderedApp,
  metadata: FrontendWorkspaceMetadata,
  workspaceId: string
): Promise<HTMLElement> {
  await setupWorkspaceView(view, metadata, workspaceId);
  await view.selectTab("review");
  // Wait for the review panel to be ready
  await view.findAllByText(/No changes found/i, {}, { timeout: 60_000 });
  return view.getByTestId("review-refresh");
}

// ═══════════════════════════════════════════════════════════════════════════════
// BASE SELECTOR TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describeIntegration("ReviewPanel base selector", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("base value updates when changed via localStorage sync", async () => {
    // This test verifies that the ReviewPanel correctly syncs with persisted base value changes.
    // We use localStorage directly because Radix popovers don't work reliably in happy-dom.
    // The underlying fix ensures functional updates avoid stale closure issues.
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      // Set initial base to HEAD
      const storageKey = STORAGE_KEYS.reviewDiffBase(workspaceId);
      window.localStorage.setItem(storageKey, JSON.stringify("HEAD"));

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupReviewPanel(view, metadata, workspaceId);

        // Find the base selector button
        const baseValueButton = view.getByTestId("review-base-value");
        expect(baseValueButton).toBeTruthy();

        // Check initial value
        expect(baseValueButton.textContent).toBe("HEAD");

        // Simulate external base change (like from GitStatusIndicator)
        // This mimics what happens when the user changes the base elsewhere
        const newBase = "HEAD~1";
        updatePersistedState(storageKey, newBase);

        // Wait for the UI to sync
        await waitFor(
          () => {
            expect(baseValueButton.textContent).toBe(newBase);
          },
          { timeout: 5000 }
        );
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  });

  test("multiple rapid base changes apply correctly", async () => {
    // Tests that rapid successive base changes work (no stale closure issues)
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const storageKey = STORAGE_KEYS.reviewDiffBase(workspaceId);
      window.localStorage.setItem(storageKey, JSON.stringify("HEAD"));

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupReviewPanel(view, metadata, workspaceId);

        const baseValueButton = view.getByTestId("review-base-value");
        expect(baseValueButton.textContent).toBe("HEAD");

        // Rapidly change base multiple times
        const bases = ["HEAD~1", "HEAD~2", "main"];

        for (const newBase of bases) {
          updatePersistedState(storageKey, newBase);

          // Wait for UI to update
          await waitFor(
            () => {
              expect(baseValueButton.textContent).toBe(newBase);
            },
            { timeout: 5000 }
          );
        }

        // Final check
        expect(baseValueButton.textContent).toBe("main");
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  });
});
