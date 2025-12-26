import { cleanup, fireEvent, waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests, validateApiKeys } from "../testUtils";
import {
  cleanupSharedRepo,
  configureTestRetries,
  createSharedRepo,
  withSharedWorkspace,
} from "../ipc/sendMessageTestHelpers";
import { HAIKU_MODEL, sendMessageWithModel } from "../ipc/helpers";
import type { ToolPolicy } from "../../src/common/utils/tools/toolPolicy";

import { installDom } from "./dom";
import { renderReviewPanel, type RenderedApp } from "./renderReviewPanel";
import {
  waitForToolCallEnd,
  waitForRefreshButtonIdle,
  assertRefreshButtonHasLastRefreshInfo,
} from "./helpers";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

configureTestRetries(2);

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

validateApiKeys(["ANTHROPIC_API_KEY"]);

/**
 * Helper to set up the full App UI and navigate to the Review tab.
 * Returns the view and refresh button for assertions.
 */
async function setupReviewPanel(
  view: RenderedApp,
  metadata: FrontendWorkspaceMetadata,
  workspaceId: string
): Promise<HTMLElement> {
  // Wait for the full App to be ready (loading screen gone)
  await view.waitForReady();

  // Expand the project first (it starts collapsed)
  const projectRow = await waitFor(
    () => {
      const el = view.container.querySelector(`[data-project-path="${metadata.projectPath}"]`);
      if (!el) throw new Error("Project not found in sidebar");
      return el as HTMLElement;
    },
    { timeout: 10_000 }
  );

  // Click the expand button within the project row
  const expandButton = projectRow.querySelector('[aria-label*="Expand project"]');
  if (expandButton) {
    fireEvent.click(expandButton);
  } else {
    fireEvent.click(projectRow);
  }

  // Now find and click the workspace
  const workspaceElement = await waitFor(
    () => {
      const el = view.container.querySelector(`[data-workspace-id="${workspaceId}"]`);
      if (!el) throw new Error("Workspace not found in sidebar");
      return el as HTMLElement;
    },
    { timeout: 10_000 }
  );
  fireEvent.click(workspaceElement);

  // Switch to review tab
  await view.selectTab("review");

  // Wait for the first diff load to complete
  await view.findAllByText(/No changes found/i, {}, { timeout: 60_000 });

  return view.getByTestId("review-refresh");
}

// ═══════════════════════════════════════════════════════════════════════════════
// MANUAL REFRESH TEST (fast, no LLM calls)
// ═══════════════════════════════════════════════════════════════════════════════

describeIntegration("ReviewPanel manual refresh (UI + ORPC)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("manual refresh updates diff and sets lastRefreshInfo", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        const refreshButton = await setupReviewPanel(view, metadata, workspaceId);

        // Make a direct FS change (no tool-call events)
        const MANUAL_MARKER = "MANUAL_REFRESH_TEST_MARKER";
        const bashRes = await env.orpc.workspace.executeBash({
          workspaceId,
          script: `echo "${MANUAL_MARKER}" >> README.md`,
        });
        expect(bashRes.success).toBe(true);
        if (!bashRes.success) return;
        expect(bashRes.data.success).toBe(true);

        // Without manual refresh, the UI should not pick this up yet
        expect(view.queryByText(new RegExp(MANUAL_MARKER))).toBeNull();

        // Click refresh
        fireEvent.click(refreshButton);

        // Immediate feedback: spinner should become visible
        const icon = refreshButton.querySelector("svg");
        await waitFor(
          () => {
            expect(icon?.getAttribute("class") ?? "").toContain("animate-spin");
          },
          { timeout: 5_000 }
        );

        // Wait for the marker to appear in the diff
        await view.findByText(new RegExp(MANUAL_MARKER), {}, { timeout: 60_000 });

        // lastRefreshInfo should reflect manual refresh
        await waitForRefreshButtonIdle(refreshButton);
        await assertRefreshButtonHasLastRefreshInfo(refreshButton, "manual");
      } finally {
        view.unmount();
        cleanup();
        // Wait for any pending React updates to settle before destroying DOM
        await new Promise((r) => setTimeout(r, 100));
        cleanupDom();
      }
    });
  }, 120_000);

  test("Ctrl+R triggers manual refresh", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        const refreshButton = await setupReviewPanel(view, metadata, workspaceId);

        // Initially no lastRefreshInfo
        expect(refreshButton.getAttribute("data-last-refresh-trigger")).toBe("");

        // Press Ctrl+R (or Cmd+R on mac)
        fireEvent.keyDown(window, { key: "r", ctrlKey: true });

        // Should trigger refresh and update lastRefreshInfo
        await waitForRefreshButtonIdle(refreshButton);
        await assertRefreshButtonHasLastRefreshInfo(refreshButton, "manual");
      } finally {
        view.unmount();
        cleanup();
        await new Promise((r) => setTimeout(r, 100));
        cleanupDom();
      }
    });
  }, 120_000);

  test("manual refresh updates lastRefreshInfo even when diff unchanged", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        const refreshButton = await setupReviewPanel(view, metadata, workspaceId);

        // At this point, initial load has completed but no manual refresh yet
        // The button should NOT have lastRefreshInfo (initial load doesn't set it)
        const initialTrigger = refreshButton.getAttribute("data-last-refresh-trigger");
        
        // First manual refresh (no changes to diff, just clicking refresh)
        fireEvent.click(refreshButton);
        await waitForRefreshButtonIdle(refreshButton);
        await assertRefreshButtonHasLastRefreshInfo(refreshButton, "manual");

        // Record the first timestamp
        const firstTimestamp = refreshButton.getAttribute("data-last-refresh-timestamp");
        expect(firstTimestamp).toBeTruthy();

        // Wait a moment so timestamp will differ
        await new Promise((r) => setTimeout(r, 100));

        // Second manual refresh (still no changes - diff is identical)
        fireEvent.click(refreshButton);
        await waitForRefreshButtonIdle(refreshButton);
        await assertRefreshButtonHasLastRefreshInfo(refreshButton, "manual");

        // Timestamp should be updated even though diff is unchanged
        const secondTimestamp = refreshButton.getAttribute("data-last-refresh-timestamp");
        expect(secondTimestamp).toBeTruthy();
        expect(Number(secondTimestamp)).toBeGreaterThan(Number(firstTimestamp));


      } finally {
        view.unmount();
        cleanup();
        await new Promise((r) => setTimeout(r, 100));
        cleanupDom();
      }
    });
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO REFRESH TEST (slow, requires LLM)
// ═══════════════════════════════════════════════════════════════════════════════

describeIntegration("ReviewPanel auto refresh (UI + ORPC + live LLM)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("tool-call-end triggers scheduled refresh", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, collector, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        const refreshButton = await setupReviewPanel(view, metadata, workspaceId);

        // Use LLM to make a file change via bash tool
        const AUTO_MARKER = "AUTO_REFRESH_MARKER";
        const FORCE_BASH: ToolPolicy = [{ regex_match: "bash", action: "require" }];

        const autoRes = await sendMessageWithModel(
          env,
          workspaceId,
          `Use bash to append a new line containing "${AUTO_MARKER}" to README.md.`,
          HAIKU_MODEL,
          {
            mode: "exec",
            thinkingLevel: "off",
            toolPolicy: FORCE_BASH,
          }
        );
        expect(autoRes.success).toBe(true);

        await collector.waitForEvent("stream-end", 30_000);
        await waitForToolCallEnd(collector, "bash");

        // Verify the workspace actually changed
        const statusRes = await env.orpc.workspace.executeBash({
          workspaceId,
          script: "git status --porcelain",
        });
        expect(statusRes.success).toBe(true);
        if (!statusRes.success) return;
        expect(statusRes.data.success).toBe(true);
        expect(statusRes.data.output).toContain("README.md");

        // Wait for ReviewPanel's tool-completion debounce + refresh to land
        // Use findAllByText since the marker may appear in chat (user message, tool output) and diff
        const matches = await view.findAllByText(new RegExp(AUTO_MARKER), {}, { timeout: 60_000 });
        // There should be at least one match in the diff panel
        expect(matches.length).toBeGreaterThanOrEqual(1);

        // lastRefreshInfo should reflect the scheduled/tool-completion refresh
        await waitForRefreshButtonIdle(refreshButton);
        await assertRefreshButtonHasLastRefreshInfo(refreshButton, "scheduled");
      } finally {
        view.unmount();
        cleanup();
        // Wait for any pending React updates to settle before destroying DOM
        await new Promise((r) => setTimeout(r, 100));
        cleanupDom();
      }
    });
  }, 180_000);
});
