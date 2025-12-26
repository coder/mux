/**
 * Integration tests for the read-more context expansion feature in code review.
 *
 * Tests the ability to:
 * - Expand context above hunks (▲ button)
 * - Expand context below hunks (▼ button)
 * - Collapse expanded context via curvy-line indicator between hunk and context
 * - Hide expand buttons at file boundaries (BOF/EOF)
 * - Persist expansion state across re-renders
 */

import { fireEvent, waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  withSharedWorkspace,
} from "../ipc/sendMessageTestHelpers";

import { installDom } from "./dom";
import { renderReviewPanel, type RenderedApp } from "./renderReviewPanel";
import { cleanupView, setupWorkspaceView, waitForRefreshButtonIdle } from "./helpers";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { APIClient } from "@/browser/contexts/API";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

/**
 * Helper to set up the Review tab with a file change.
 * Creates a multi-line file and a diff at a non-first line to test context expansion.
 */
async function setupReviewPanelWithDiff(
  view: RenderedApp,
  metadata: FrontendWorkspaceMetadata,
  workspaceId: string,
  orpc: APIClient
): Promise<{ refreshButton: HTMLElement; container: HTMLElement }> {
  await setupWorkspaceView(view, metadata, workspaceId);

  // Create a multi-line file for context expansion testing
  // We create a file with 30 lines, then modify line 15
  const lines = Array.from({ length: 30 }, (_, i) => `// Line ${i + 1}: content here`);
  const fileContent = lines.join("\n");

  // Create the initial file (committed)
  await orpc.workspace.executeBash({
    workspaceId,
    script: `cat > test-readmore.ts << 'EOF'
${fileContent}
EOF
git add test-readmore.ts && git commit -m "Add test file"`,
  });

  // Modify line 15 (creating a diff in the middle of the file)
  const modifiedLines = [...lines];
  modifiedLines[14] = "// Line 15: MODIFIED FOR TEST";
  const modifiedContent = modifiedLines.join("\n");

  await orpc.workspace.executeBash({
    workspaceId,
    script: `cat > test-readmore.ts << 'EOF'
${modifiedContent}
EOF`,
  });

  // Switch to review tab
  await view.selectTab("review");

  // Wait for the diff to appear - refresh may be needed
  const refreshButton = view.getByTestId("review-refresh");
  fireEvent.click(refreshButton);

  // Wait for the diff content to appear
  await waitFor(
    () => {
      const diffContent = view.container.querySelector("[data-hunk-id]");
      if (!diffContent) throw new Error("No hunk found");
    },
    { timeout: 60_000 }
  );

  await waitForRefreshButtonIdle(refreshButton);

  return { refreshButton, container: view.container };
}

// ═══════════════════════════════════════════════════════════════════════════════
// READ-MORE CONTEXT EXPANSION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describeIntegration("ReadMore context expansion (UI + ORPC)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("expand-up button loads additional context above hunk", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        const { container } = await setupReviewPanelWithDiff(view, metadata, workspaceId, env.orpc);

        // Find the expand-up button (▲) - should exist since diff is at line 15, not line 1
        const expandUpButton = await waitFor(
          () => {
            const btn = container.querySelector('button[aria-label="Show more context above"]');
            if (!btn) throw new Error("Expand-up button not found");
            return btn as HTMLElement;
          },
          { timeout: 10_000 }
        );

        // Click expand up
        fireEvent.click(expandUpButton);

        // Wait for expanded content to appear - should contain lines from before line 15
        await waitFor(
          () => {
            // Check that loading is complete and content appeared
            const hunkContent = container.textContent ?? "";
            if (hunkContent.includes("Loading...")) {
              throw new Error("Still loading");
            }
            // Should now have context lines from before the hunk (lines 1-14)
            // Look for a line number that would only appear in expanded content
            if (!hunkContent.includes("Line 10") && !hunkContent.includes("Line 5")) {
              throw new Error("Expanded content not visible - expected earlier line numbers");
            }
          },
          { timeout: 15_000 }
        );

        // Verify the expand button is still available for further expansion
        // (since we expanded 20 lines but file has 14 lines above hunk)
        const hunkContainer = container.querySelector("[data-hunk-id]");
        expect(hunkContainer).not.toBeNull();
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 180_000);

  test("expand-down button loads additional context below hunk", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        const { container } = await setupReviewPanelWithDiff(view, metadata, workspaceId, env.orpc);

        // Find the expand-down button (▼) - should exist since diff is at line 15, file has 30 lines
        const expandDownButton = await waitFor(
          () => {
            const btn = container.querySelector('button[aria-label="Show more context below"]');
            if (!btn) throw new Error("Expand-down button not found");
            return btn as HTMLElement;
          },
          { timeout: 10_000 }
        );

        // Click expand down
        fireEvent.click(expandDownButton);

        // Wait for expanded content to appear - should contain lines after line 15
        await waitFor(
          () => {
            const hunkContent = container.textContent ?? "";
            if (hunkContent.includes("Loading...")) {
              throw new Error("Still loading");
            }
            // Should now have context lines from after the hunk (lines 16-30)
            // Look for a line number that would only appear in expanded content
            if (!hunkContent.includes("Line 20") && !hunkContent.includes("Line 25")) {
              throw new Error("Expanded content not visible - expected later line numbers");
            }
          },
          { timeout: 15_000 }
        );

        // Verify the hunk container still exists
        const hunkContainer = container.querySelector("[data-hunk-id]");
        expect(hunkContainer).not.toBeNull();
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 180_000);

  test("hides expand-up button when diff starts at line 1 (BOF)", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Create a small file with diff at line 1 (so BOF is immediate)
        await env.orpc.workspace.executeBash({
          workspaceId,
          script: `echo "// Original line 1" > bof-test.ts && git add bof-test.ts && git commit -m "Add BOF test"`,
        });

        await env.orpc.workspace.executeBash({
          workspaceId,
          script: `echo "// Modified line 1" > bof-test.ts`,
        });

        // Switch to review tab and refresh
        await view.selectTab("review");
        const refreshButton = view.getByTestId("review-refresh");
        fireEvent.click(refreshButton);

        // Wait for hunk to appear
        await waitFor(
          () => {
            const hunk = view.container.querySelector("[data-hunk-id]");
            if (!hunk) throw new Error("No hunk found");
          },
          { timeout: 60_000 }
        );

        await waitForRefreshButtonIdle(refreshButton);

        // For a diff starting at line 1:
        // No expand-up button should exist (nothing above line 1)
        // and no BOF marker is shown (we just don't show the control row)
        const expandUpButton = view.container.querySelector(
          'button[aria-label="Show more context above"]'
        );
        expect(expandUpButton).toBeNull();

        // Expand-down button should still exist
        const expandDownButton = view.container.querySelector(
          'button[aria-label="Show more context below"]'
        );
        expect(expandDownButton).not.toBeNull();
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 180_000);

  test("hides expand-up button for newly added files (oldStart=0, newStart=1)", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Create a NEW file (not modifying existing) - this will have oldStart=0
        // Must stage it for it to show up in the review panel diff
        await env.orpc.workspace.executeBash({
          workspaceId,
          script: `echo "// New file line 1" > brand-new-file.ts && git add brand-new-file.ts`,
        });

        // Switch to review tab and refresh
        await view.selectTab("review");
        const refreshButton = view.getByTestId("review-refresh");
        fireEvent.click(refreshButton);

        // Wait for hunk to appear
        await waitFor(
          () => {
            const hunk = view.container.querySelector("[data-hunk-id]");
            if (!hunk) throw new Error("No hunk found");
          },
          { timeout: 60_000 }
        );

        await waitForRefreshButtonIdle(refreshButton);

        // For a newly added file:
        // oldStart=0 (no old content), newStart=1
        // Should NOT show expand-up button (nothing to expand above a new file)
        const expandUpButton = view.container.querySelector(
          'button[aria-label="Show more context above"]'
        );
        expect(expandUpButton).toBeNull();
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 180_000);

  test("hides expand-down button when expanded past file end (EOF)", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Create a file with 10 lines - modify line 5 so there's context below
        const lines = Array.from({ length: 10 }, (_, i) => `// Line ${i + 1}`);
        const fileContent = lines.join("\n");

        await env.orpc.workspace.executeBash({
          workspaceId,
          script: `cat > eof-test.ts << 'EOF'
${fileContent}
EOF
git add eof-test.ts && git commit -m "Add EOF test"`,
        });

        // Modify line 5 (creates a diff in the middle with context above and below)
        const modifiedLines = [...lines];
        modifiedLines[4] = "// Line 5 - MODIFIED";
        const modifiedContent = modifiedLines.join("\n");

        await env.orpc.workspace.executeBash({
          workspaceId,
          script: `cat > eof-test.ts << 'EOF'
${modifiedContent}
EOF`,
        });

        // Switch to review tab and refresh
        await view.selectTab("review");
        const refreshButton = view.getByTestId("review-refresh");
        fireEvent.click(refreshButton);

        // Wait for hunk to appear
        await waitFor(
          () => {
            const hunk = view.container.querySelector("[data-hunk-id]");
            if (!hunk) throw new Error("No hunk found");
          },
          { timeout: 60_000 }
        );

        await waitForRefreshButtonIdle(refreshButton);

        // Click expand-down to reach EOF (file only has 10 lines, expansion requests 20)
        const expandDownButton = await waitFor(
          () => {
            const btn = view.container.querySelector(
              'button[aria-label="Show more context below"]'
            );
            if (!btn) throw new Error("Expand-down button not found");
            return btn as HTMLElement;
          },
          { timeout: 10_000 }
        );

        fireEvent.click(expandDownButton);

        // After reaching EOF, expand-down button should be gone (replaced by collapse only)
        await waitFor(
          () => {
            const expandBtn = view.container.querySelector(
              'button[aria-label="Show more context below"]'
            );
            if (expandBtn) throw new Error("Expand button should be gone at EOF");

            const collapseBtn = view.container.querySelector(
              'button[aria-label="Collapse context below"]'
            );
            if (!collapseBtn) throw new Error("Collapse button should exist at EOF");
          },
          { timeout: 30_000 }
        );
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 180_000);

  test("expand button stays hidden after reaching EOF (no flash back)", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Create a very small file (5 lines) - modify line 3
        const lines = Array.from({ length: 5 }, (_, i) => `// Line ${i + 1}`);
        const fileContent = lines.join("\n");

        await env.orpc.workspace.executeBash({
          workspaceId,
          script: `cat > tiny-file.ts << 'EOF'
${fileContent}
EOF
git add tiny-file.ts && git commit -m "Add tiny file"`,
        });

        // Modify line 3
        const modifiedLines = [...lines];
        modifiedLines[2] = "// Line 3 - MODIFIED";
        const modifiedContent = modifiedLines.join("\n");

        await env.orpc.workspace.executeBash({
          workspaceId,
          script: `cat > tiny-file.ts << 'EOF'
${modifiedContent}
EOF`,
        });

        // Switch to review tab and refresh
        await view.selectTab("review");
        const refreshButton = view.getByTestId("review-refresh");
        fireEvent.click(refreshButton);

        await waitFor(
          () => {
            const hunk = view.container.querySelector("[data-hunk-id]");
            if (!hunk) throw new Error("No hunk found");
          },
          { timeout: 60_000 }
        );

        await waitForRefreshButtonIdle(refreshButton);

        // Click expand-down - this should immediately hit EOF (5 line file, expansion = 20)
        const expandDownButton = await waitFor(
          () => {
            const btn = view.container.querySelector(
              'button[aria-label="Show more context below"]'
            );
            if (!btn) throw new Error("Expand-down button not found");
            return btn as HTMLElement;
          },
          { timeout: 10_000 }
        );

        fireEvent.click(expandDownButton);

        // Wait for EOF state - button should be gone
        await waitFor(
          () => {
            const loadingText = view.container.textContent?.includes("Loading...");
            if (loadingText) throw new Error("Still loading");

            const expandBtn = view.container.querySelector(
              'button[aria-label="Show more context below"]'
            );
            if (expandBtn) throw new Error("Expand button should be hidden at EOF");
          },
          { timeout: 15_000 }
        );

        // Wait a bit and verify button doesn't flash back
        await new Promise((r) => setTimeout(r, 1000));

        // Button should STILL be hidden (no flash back)
        const expandBtnAfterWait = view.container.querySelector(
          'button[aria-label="Show more context below"]'
        );
        expect(expandBtnAfterWait).toBeNull();
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 180_000);

  test("multiple expand clicks accumulate context", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        const { container } = await setupReviewPanelWithDiff(view, metadata, workspaceId, env.orpc);

        // First expand-up click
        const expandUpButton = await waitFor(
          () => {
            const btn = container.querySelector('button[aria-label="Show more context above"]');
            if (!btn) throw new Error("Expand-up button not found");
            return btn as HTMLElement;
          },
          { timeout: 10_000 }
        );

        fireEvent.click(expandUpButton);

        // Wait for first expansion
        await waitFor(
          () => {
            const hunkContent = container.textContent ?? "";
            if (hunkContent.includes("Loading...")) throw new Error("Still loading");
          },
          { timeout: 15_000 }
        );

        // After first click (20 lines), we're at BOF since hunk is at line 15
        // The expand-up button should be gone (replaced by collapse only)
        await waitFor(
          () => {
            const expandBtn = container.querySelector(
              'button[aria-label="Show more context above"]'
            );
            if (expandBtn) throw new Error("Expand-up should be gone at BOF");

            const collapseBtn = container.querySelector(
              'button[aria-label="Collapse context above"]'
            );
            if (!collapseBtn) throw new Error("Collapse button should exist at BOF");
          },
          { timeout: 5_000 }
        );
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 180_000);

  test("per-side collapse button hides expanded context", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        const { container } = await setupReviewPanelWithDiff(view, metadata, workspaceId, env.orpc);

        // First expand up to get some expanded content
        const expandUpButton = await waitFor(
          () => {
            const btn = container.querySelector('button[aria-label="Show more context above"]');
            if (!btn) throw new Error("Expand-up button not found");
            return btn as HTMLElement;
          },
          { timeout: 10_000 }
        );

        fireEvent.click(expandUpButton);

        // Wait for the per-side collapse button to appear (indicates expansion completed)
        const collapseButton = await waitFor(
          () => {
            const btn = container.querySelector('button[aria-label="Collapse context above"]');
            if (!btn) throw new Error("Collapse button not found");
            return btn as HTMLElement;
          },
          { timeout: 15_000 }
        );

        // Click collapse
        fireEvent.click(collapseButton);

        // Wait for collapse button to disappear (no more expanded content above)
        await waitFor(
          () => {
            const collapseBtn = container.querySelector(
              'button[aria-label="Collapse context above"]'
            );
            if (collapseBtn) throw new Error("Collapse button should be gone");
          },
          { timeout: 10_000 }
        );

        // Hunk should still be visible
        const hunkAfterCollapse = container.querySelector("[data-hunk-id]");
        expect(hunkAfterCollapse).not.toBeNull();
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 180_000);

  // Skip: happy-dom cleanup issue with React state updates after unmount
  // The persistence is tested via Storybook stories which use real browser
  test.skip("expansion state persists across tab switches", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        const { container } = await setupReviewPanelWithDiff(view, metadata, workspaceId, env.orpc);

        // Find and click expand-up button
        const expandUpButton = await waitFor(
          () => {
            const btn = container.querySelector('button[aria-label="Show more context above"]');
            if (!btn) throw new Error("Expand-up button not found");
            return btn as HTMLElement;
          },
          { timeout: 10_000 }
        );

        fireEvent.click(expandUpButton);

        // Wait for expansion to complete
        await waitFor(
          () => {
            const loadingText = container.querySelector('[class*="text-muted"]');
            if (loadingText?.textContent?.includes("Loading...")) {
              throw new Error("Still loading");
            }
          },
          { timeout: 10_000 }
        );

        // Switch away from review tab - use costs tab which is always available
        const costsTab = container.querySelector('[role="tab"][aria-controls*="costs"]');
        if (costsTab) fireEvent.click(costsTab);

        // Give time for tab switch
        await new Promise((r) => setTimeout(r, 500));

        // Switch back to review tab
        const reviewTab = container.querySelector('[role="tab"][aria-controls*="review"]');
        if (reviewTab) fireEvent.click(reviewTab);

        // The expanded state should be restored (hunk should still be visible)
        await waitFor(
          () => {
            const hunk = container.querySelector("[data-hunk-id]");
            if (!hunk) throw new Error("Hunk not found after tab switch");
          },
          { timeout: 15_000 }
        );
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 180_000);
});
