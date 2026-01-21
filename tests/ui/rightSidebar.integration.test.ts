/**
 * Integration tests for RightSidebar dock-lite behavior.
 *
 * Tests cover:
 * - Tab switching (costs, review, terminal)
 * - Sidebar collapse/expand
 * - Tab persistence across navigation
 *
 * Note: These tests drive the UI from the user's perspective - clicking tabs,
 * not calling backend APIs directly for the actions being tested.
 */

import { fireEvent, waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  withSharedWorkspace,
} from "../ipc/sendMessageTestHelpers";

import { installDom } from "./dom";
import { renderApp } from "./renderReviewPanel";
import { cleanupView, setupWorkspaceView } from "./helpers";
import {
  RIGHT_SIDEBAR_TAB_KEY,
  RIGHT_SIDEBAR_COLLAPSED_KEY,
  getRightSidebarLayoutKey,
} from "@/common/constants/storage";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
// RightSidebarLayoutState used for initial setup via persisted-state helpers - acceptable for test fixtures
import type { RightSidebarLayoutState } from "@/browser/utils/rightSidebarLayout";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("RightSidebar (UI)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  beforeEach(() => {
    // Clear persisted state before each test
    // Note: layout is per-workspace now, so cleared inside tests with workspace context
    updatePersistedState(RIGHT_SIDEBAR_TAB_KEY, null);
    updatePersistedState(RIGHT_SIDEBAR_COLLAPSED_KEY, null);
  });

  test("tab switching updates active tab and persists selection", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      // Clear any persisted state
      updatePersistedState(RIGHT_SIDEBAR_TAB_KEY, null);
      updatePersistedState(getRightSidebarLayoutKey(workspaceId), null);

      const view = renderApp({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Find the right sidebar
        const sidebar = await waitFor(
          () => {
            const el = view.container.querySelector(
              '[role="complementary"][aria-label="Workspace insights"]'
            );
            if (!el) throw new Error("RightSidebar not found");
            return el as HTMLElement;
          },
          { timeout: 10_000 }
        );

        // Find the Costs tab (should be default)
        const costsTab = await waitFor(
          () => {
            const tab = sidebar.querySelector(
              '[role="tab"][aria-controls*="costs"]'
            ) as HTMLElement;
            if (!tab) throw new Error("Costs tab not found");
            return tab;
          },
          { timeout: 5_000 }
        );

        // Costs should be selected by default
        expect(costsTab.getAttribute("aria-selected")).toBe("true");

        // Click Review tab
        const reviewTab = sidebar.querySelector(
          '[role="tab"][aria-controls*="review"]'
        ) as HTMLElement;
        expect(reviewTab).toBeTruthy();
        fireEvent.click(reviewTab);

        // Wait for Review tab to become selected (visible UI state)
        await waitFor(() => {
          expect(reviewTab.getAttribute("aria-selected")).toBe("true");
          expect(costsTab.getAttribute("aria-selected")).toBe("false");
        });

        // Verify Review panel is now visible
        await waitFor(() => {
          const reviewPanel = sidebar.querySelector('[role="tabpanel"][id*="review"]');
          if (!reviewPanel) throw new Error("Review panel should be visible after tab click");
        });

        // Create a terminal via the "+" button
        const newTerminalButton = await waitFor(
          () => {
            const btn = sidebar.querySelector('button[aria-label="New terminal"]');
            if (!btn) throw new Error("New terminal button not found");
            return btn as HTMLElement;
          },
          { timeout: 5_000 }
        );
        fireEvent.click(newTerminalButton);

        // Wait for the terminal tab to appear and become selected
        const terminalTab = await waitFor(
          () => {
            const tab = sidebar.querySelector(
              '[role="tab"][aria-controls*="terminal:"]'
            ) as HTMLElement | null;
            if (!tab) throw new Error("Terminal tab not found");
            return tab;
          },
          { timeout: 10_000 }
        );

        await waitFor(() => {
          expect(terminalTab.getAttribute("aria-selected")).toBe("true");
          expect(reviewTab.getAttribute("aria-selected")).toBe("false");
        });

        // Verify terminal panel is now visible
        await waitFor(() => {
          const terminalPanel = sidebar.querySelector('[role="tabpanel"][id*="terminal"]');
          if (!terminalPanel) throw new Error("Terminal panel should be visible after tab click");
        });
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 60_000);

  test("stats tab enabled does not steal default focus", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const previousStatsTabState = await env.orpc.features.getStatsTabState();
      await env.orpc.features.setStatsTabOverride({ override: "on" });

      // Clear any persisted state
      updatePersistedState(RIGHT_SIDEBAR_TAB_KEY, null);
      updatePersistedState(getRightSidebarLayoutKey(workspaceId), null);

      const view = renderApp({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Find the right sidebar
        const sidebar = await waitFor(
          () => {
            const el = view.container.querySelector(
              '[role="complementary"][aria-label="Workspace insights"]'
            );
            if (!el) throw new Error("RightSidebar not found");
            return el as HTMLElement;
          },
          { timeout: 10_000 }
        );

        // Wait for Stats tab injection and confirm it doesn't steal focus.
        await waitFor(() => {
          const costsTab = sidebar.querySelector(
            '[role="tab"][aria-controls*="costs"]'
          ) as HTMLElement | null;
          if (!costsTab) throw new Error("Costs tab not found");

          const statsTab = sidebar.querySelector(
            '[role="tab"][aria-controls*="stats"]'
          ) as HTMLElement | null;
          if (!statsTab) throw new Error("Stats tab not found");

          expect(costsTab.getAttribute("aria-selected")).toBe("true");
          expect(statsTab.getAttribute("aria-selected")).toBe("false");
        });
      } finally {
        try {
          await env.orpc.features.setStatsTabOverride({ override: previousStatsTabState.override });
        } finally {
          await cleanupView(view, cleanupDom);
        }
      }
    });
  }, 60_000);

  test("sidebar collapse and expand via button", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      // Start expanded
      updatePersistedState(RIGHT_SIDEBAR_COLLAPSED_KEY, false);

      const view = renderApp({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Find sidebar - should be expanded with tabs visible
        const sidebar = await waitFor(
          () => {
            const el = view.container.querySelector(
              '[role="complementary"][aria-label="Workspace insights"]'
            );
            if (!el) throw new Error("RightSidebar not found");
            return el as HTMLElement;
          },
          { timeout: 10_000 }
        );

        // Verify tabs are visible (expanded state)
        await waitFor(() => {
          const tablist = sidebar.querySelector('[role="tablist"]');
          if (!tablist) throw new Error("Tablist should be visible when expanded");
        });

        // Find and click collapse button
        const collapseButton = await waitFor(
          () => {
            // The collapse button has aria-label containing "collapse" or "expand"
            const btn = sidebar.querySelector('button[aria-label*="ollapse"]') as HTMLElement;
            if (!btn) throw new Error("Collapse button not found");
            return btn;
          },
          { timeout: 5_000 }
        );
        fireEvent.click(collapseButton);

        // Wait for collapse - tablist should not be rendered
        await waitFor(() => {
          const tablist = sidebar.querySelector('[role="tablist"]');
          if (tablist) throw new Error("Tablist should be hidden when collapsed");
        });

        // Re-query sidebar and find expand button (sidebar reference may be stale after collapse)
        const collapsedSidebar = view.container.querySelector(
          '[role="complementary"][aria-label="Workspace insights"]'
        ) as HTMLElement;
        expect(collapsedSidebar).toBeTruthy();
        const expandButton = collapsedSidebar.querySelector(
          'button[aria-label="Expand sidebar"]'
        ) as HTMLElement;
        expect(expandButton).toBeTruthy();
        fireEvent.click(expandButton);

        // Wait for expand - tablist should be visible again
        await waitFor(() => {
          const tablist = sidebar.querySelector('[role="tablist"]');
          if (!tablist) throw new Error("Tablist should be visible after expand");
        });
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 60_000);

  test("tab selection persists across workspace navigation", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      // Start with Review tab selected
      const initialLayout: RightSidebarLayoutState = {
        version: 1,
        nextId: 2,
        focusedTabsetId: "tabset-1",
        root: {
          type: "tabset",
          id: "tabset-1",
          tabs: ["costs", "review"],
          activeTab: "review",
        },
      };
      updatePersistedState(getRightSidebarLayoutKey(workspaceId), initialLayout);

      const view = renderApp({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Find the right sidebar
        const sidebar = await waitFor(
          () => {
            const el = view.container.querySelector(
              '[role="complementary"][aria-label="Workspace insights"]'
            );
            if (!el) throw new Error("RightSidebar not found");
            return el as HTMLElement;
          },
          { timeout: 10_000 }
        );

        // Verify Review tab is selected (from persisted state)
        await waitFor(() => {
          const reviewTab = sidebar.querySelector(
            '[role="tab"][aria-controls*="review"]'
          ) as HTMLElement;
          if (!reviewTab) throw new Error("Review tab not found");
          if (reviewTab.getAttribute("aria-selected") !== "true") {
            throw new Error("Review tab should be selected from persisted state");
          }
        });

        // Navigate away by clicking project row (goes to home)
        const projectRow = view.container.querySelector(
          `[data-project-path="${metadata.projectPath}"]`
        ) as HTMLElement;
        if (projectRow) {
          fireEvent.click(projectRow);
        }

        // Wait a moment for navigation
        await new Promise((r) => setTimeout(r, 200));

        // Navigate back to workspace
        const workspaceElement = await waitFor(
          () => {
            const el = view.container.querySelector(`[data-workspace-id="${workspaceId}"]`);
            if (!el) throw new Error("Workspace not found in sidebar");
            return el as HTMLElement;
          },
          { timeout: 5_000 }
        );
        fireEvent.click(workspaceElement);

        // Verify Review tab is still selected after navigation
        await waitFor(() => {
          const sidebar2 = view.container.querySelector(
            '[role="complementary"][aria-label="Workspace insights"]'
          );
          if (!sidebar2) throw new Error("Sidebar not found after navigation");
          const reviewTab = sidebar2.querySelector(
            '[role="tab"][aria-controls*="review"]'
          ) as HTMLElement;
          if (!reviewTab) throw new Error("Review tab not found after navigation");
          if (reviewTab.getAttribute("aria-selected") !== "true") {
            throw new Error("Review tab selection should persist across navigation");
          }
        });
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 60_000);

  test("correct tab content is displayed for each tab", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderApp({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        const sidebar = await waitFor(
          () => {
            const el = view.container.querySelector(
              '[role="complementary"][aria-label="Workspace insights"]'
            );
            if (!el) throw new Error("RightSidebar not found");
            return el as HTMLElement;
          },
          { timeout: 10_000 }
        );

        // Switch to Costs tab and verify content
        const costsTab = await waitFor(
          () => {
            const tab = sidebar.querySelector(
              '[role="tab"][aria-controls*="costs"]'
            ) as HTMLElement | null;
            if (!tab) throw new Error("Costs tab not found");
            return tab;
          },
          { timeout: 5_000 }
        );
        fireEvent.click(costsTab);
        await waitFor(() => {
          // Costs panel should contain model/cost info or "No usage data"
          const costsPanel = sidebar.querySelector('[role="tabpanel"][id*="costs"]');
          if (!costsPanel) throw new Error("Costs panel not found");
        });

        // Switch to Review tab and verify content
        const reviewTab = await waitFor(
          () => {
            const tab = sidebar.querySelector(
              '[role="tab"][aria-controls*="review"]'
            ) as HTMLElement | null;
            if (!tab) throw new Error("Review tab not found");
            return tab;
          },
          { timeout: 5_000 }
        );
        fireEvent.click(reviewTab);
        await waitFor(() => {
          // Review panel should exist
          const reviewPanel = sidebar.querySelector('[role="tabpanel"][id*="review"]');
          if (!reviewPanel) throw new Error("Review panel not found");
        });

        // Create a terminal via the "+" button
        const newTerminalButton = await waitFor(
          () => {
            const btn = sidebar.querySelector('button[aria-label="New terminal"]');
            if (!btn) throw new Error("New terminal button not found");
            return btn as HTMLElement;
          },
          { timeout: 5_000 }
        );
        fireEvent.click(newTerminalButton);

        // Wait for the terminal tab to appear and verify its content
        const terminalTab = await waitFor(
          () => {
            const tab = sidebar.querySelector(
              '[role="tab"][aria-controls*="terminal:"]'
            ) as HTMLElement | null;
            if (!tab) throw new Error("Terminal tab not found");
            return tab;
          },
          { timeout: 10_000 }
        );

        await waitFor(() => {
          expect(terminalTab.getAttribute("aria-selected")).toBe("true");
        });

        await waitFor(() => {
          // Terminal panel should exist (may contain terminal-view class)
          const terminalPanel = sidebar.querySelector('[role="tabpanel"][id*="terminal"]');
          if (!terminalPanel) throw new Error("Terminal panel not found");
        });
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 60_000);

  test("sidebar width persists consistently across all tabs", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      // Clear any persisted width state
      updatePersistedState("right-sidebar:width", null);

      const view = renderApp({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Find the right sidebar
        const sidebar = await waitFor(
          () => {
            const el = view.container.querySelector(
              '[role="complementary"][aria-label="Workspace insights"]'
            );
            if (!el) throw new Error("RightSidebar not found");
            return el as HTMLElement;
          },
          { timeout: 10_000 }
        );

        // Find the resize handle (left edge of sidebar)
        const resizeHandle = await waitFor(
          () => {
            const handle = sidebar.querySelector('[class*="cursor-col-resize"]') as HTMLElement;
            if (!handle) throw new Error("Resize handle not found");
            return handle;
          },
          { timeout: 5_000 }
        );

        // Simulate drag resize to 500px
        // Start on Costs tab (default)
        const costsTab = await waitFor(
          () => {
            const tab = sidebar.querySelector(
              '[role="tab"][aria-controls*="costs"]'
            ) as HTMLElement | null;
            if (!tab) throw new Error("Costs tab not found");
            return tab;
          },
          { timeout: 5_000 }
        );
        expect(costsTab.getAttribute("aria-selected")).toBe("true");

        // Simulate mousedown on resize handle
        fireEvent.mouseDown(resizeHandle, { clientX: 1000 });

        // Move mouse to resize (moving left increases width)
        fireEvent.mouseMove(document, { clientX: 500 }); // Move left by 500px

        // Release mouse
        fireEvent.mouseUp(document);

        // Helper to get sidebar's computed width (the style attribute is set inline)
        const getSidebarWidth = () => {
          const styleWidth = sidebar.style.width;
          if (styleWidth && styleWidth.endsWith("px")) {
            return parseInt(styleWidth, 10);
          }
          return sidebar.getBoundingClientRect().width;
        };

        // Wait for width to change (resize should update inline style)
        await waitFor(() => {
          const width = getSidebarWidth();
          // Should have a width greater than default (~400px after resize)
          if (width < 400) throw new Error(`Expected width >= 400, got ${width}`);
        });

        const widthAfterResize = getSidebarWidth();

        // Switch to Review tab
        const reviewTab = await waitFor(
          () => {
            const tab = sidebar.querySelector(
              '[role="tab"][aria-controls*="review"]'
            ) as HTMLElement | null;
            if (!tab) throw new Error("Review tab not found");
            return tab;
          },
          { timeout: 5_000 }
        );
        fireEvent.click(reviewTab);

        await waitFor(() => {
          expect(reviewTab.getAttribute("aria-selected")).toBe("true");
        });

        // Width should still be the same (unified across tabs) - verify via UI
        expect(getSidebarWidth()).toBe(widthAfterResize);

        // Create a terminal via the "+" button (terminal tabs are not present by default)
        const newTerminalButton = await waitFor(
          () => {
            const btn = sidebar.querySelector('button[aria-label="New terminal"]');
            if (!btn) throw new Error("New terminal button not found");
            return btn as HTMLElement;
          },
          { timeout: 5_000 }
        );
        fireEvent.click(newTerminalButton);

        const terminalTab = await waitFor(
          () => {
            const tab = sidebar.querySelector(
              '[role="tab"][aria-controls*="terminal:"]'
            ) as HTMLElement | null;
            if (!tab) throw new Error("Terminal tab not found");
            return tab;
          },
          { timeout: 10_000 }
        );

        await waitFor(() => {
          expect(terminalTab.getAttribute("aria-selected")).toBe("true");
        });

        // Width should still be the same (verify via UI)
        expect(getSidebarWidth()).toBe(widthAfterResize);
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 60_000);

  test("resizing works the same regardless of which tab is active", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      // Clear any persisted state
      updatePersistedState("right-sidebar:width", null);

      const view = renderApp({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        const sidebar = await waitFor(
          () => {
            const el = view.container.querySelector(
              '[role="complementary"][aria-label="Workspace insights"]'
            );
            if (!el) throw new Error("RightSidebar not found");
            return el as HTMLElement;
          },
          { timeout: 10_000 }
        );

        // Switch to Review tab first
        const reviewTab = await waitFor(
          () => {
            const tab = sidebar.querySelector(
              '[role="tab"][aria-controls*="review"]'
            ) as HTMLElement | null;
            if (!tab) throw new Error("Review tab not found");
            return tab;
          },
          { timeout: 5_000 }
        );
        fireEvent.click(reviewTab);

        await waitFor(() => {
          expect(reviewTab.getAttribute("aria-selected")).toBe("true");
        });

        // Find and use resize handle
        const resizeHandle = await waitFor(
          () => {
            const handle = sidebar.querySelector('[class*="cursor-col-resize"]') as HTMLElement;
            if (!handle) throw new Error("Resize handle not found");
            return handle;
          },
          { timeout: 5_000 }
        );

        // Helper to get sidebar's visible width
        const getSidebarWidth = () => {
          const styleWidth = sidebar.style.width;
          if (styleWidth && styleWidth.endsWith("px")) {
            return parseInt(styleWidth, 10);
          }
          return sidebar.getBoundingClientRect().width;
        };

        // Resize while on Review tab
        fireEvent.mouseDown(resizeHandle, { clientX: 1000 });
        fireEvent.mouseMove(document, { clientX: 600 });
        fireEvent.mouseUp(document);

        // Wait for width to change in UI
        await waitFor(() => {
          const width = getSidebarWidth();
          if (width < 400) throw new Error(`Expected width >= 400, got ${width}`);
        });

        const widthAfterReviewResize = getSidebarWidth();

        // Switch to Costs tab
        const costsTab = await waitFor(
          () => {
            const tab = sidebar.querySelector(
              '[role="tab"][aria-controls*="costs"]'
            ) as HTMLElement | null;
            if (!tab) throw new Error("Costs tab not found");
            return tab;
          },
          { timeout: 5_000 }
        );
        fireEvent.click(costsTab);

        await waitFor(() => {
          expect(costsTab.getAttribute("aria-selected")).toBe("true");
        });

        // Width should persist when switching to Costs (verify via UI)
        expect(getSidebarWidth()).toBe(widthAfterReviewResize);

        // Resize again on Costs tab
        fireEvent.mouseDown(resizeHandle, { clientX: 800 });
        fireEvent.mouseMove(document, { clientX: 500 });
        fireEvent.mouseUp(document);

        await waitFor(() => {
          const width = getSidebarWidth();
          // Width should have changed
          if (width === widthAfterReviewResize) throw new Error("Width should have changed");
        });

        const widthAfterCostsResize = getSidebarWidth();

        // Switch back to Review - should have same new width (verify via UI)
        fireEvent.click(reviewTab);
        await waitFor(() => {
          expect(reviewTab.getAttribute("aria-selected")).toBe("true");
        });

        expect(getSidebarWidth()).toBe(widthAfterCostsResize);
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 60_000);

  test("split layout renders multiple panes with separate tablists", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      // Set up a split layout with two panes (top: costs, bottom: review)
      const splitLayout: RightSidebarLayoutState = {
        version: 1,
        nextId: 10,
        root: {
          type: "split",
          id: "split-1",
          direction: "horizontal",
          sizes: [50, 50],
          children: [
            { type: "tabset", id: "tabset-top", tabs: ["costs"], activeTab: "costs" },
            { type: "tabset", id: "tabset-bottom", tabs: ["review"], activeTab: "review" },
          ],
        },
        focusedTabsetId: "tabset-top",
      };
      updatePersistedState(getRightSidebarLayoutKey(workspaceId), splitLayout);

      const view = renderApp({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        const sidebar = await waitFor(
          () => {
            const el = view.container.querySelector(
              '[role="complementary"][aria-label="Workspace insights"]'
            );
            if (!el) throw new Error("RightSidebar not found");
            return el as HTMLElement;
          },
          { timeout: 10_000 }
        );

        // Wait for both tablists (two panes)
        await waitFor(() => {
          const tablists = sidebar.querySelectorAll('[role="tablist"]');
          if (tablists.length < 2) throw new Error(`Expected 2 tablists, found ${tablists.length}`);
        });

        const tablists = sidebar.querySelectorAll('[role="tablist"]');
        expect(tablists.length).toBe(2);

        // Verify top pane has Costs tab selected
        const topTablist = tablists[0] as HTMLElement;
        const costsTab = topTablist.querySelector('[role="tab"]') as HTMLElement;
        expect(costsTab).toBeTruthy();
        expect(costsTab.getAttribute("aria-selected")).toBe("true");

        // Verify bottom pane has Review tab selected
        const bottomTablist = tablists[1] as HTMLElement;
        const reviewTab = bottomTablist.querySelector('[role="tab"]') as HTMLElement;
        expect(reviewTab).toBeTruthy();
        expect(reviewTab.getAttribute("aria-selected")).toBe("true");

        // Verify both tabpanels are rendered
        const costsPanel = sidebar.querySelector('[role="tabpanel"][id*="costs"]');
        const reviewPanel = sidebar.querySelector('[role="tabpanel"][id*="review"]');
        expect(costsPanel).toBeTruthy();
        expect(reviewPanel).toBeTruthy();
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 60_000);

  test("Cmd+T opens terminal and selects its tab", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      // Clear any persisted state
      updatePersistedState(RIGHT_SIDEBAR_TAB_KEY, null);
      updatePersistedState(getRightSidebarLayoutKey(workspaceId), null);

      const view = renderApp({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Find the right sidebar
        const sidebar = await waitFor(
          () => {
            const el = view.container.querySelector(
              '[role="complementary"][aria-label="Workspace insights"]'
            );
            if (!el) throw new Error("RightSidebar not found");
            return el as HTMLElement;
          },
          { timeout: 10_000 }
        );

        // Verify no terminal tab exists initially
        const initialTerminalTab = sidebar.querySelector(
          '[role="tab"][aria-controls*="terminal:"]'
        );
        expect(initialTerminalTab).toBeNull();

        // Press Ctrl+T (Cmd+T on mac) to open a new terminal
        fireEvent.keyDown(window, { key: "t", ctrlKey: true });

        // Wait for the terminal tab to appear and become selected
        const terminalTab = await waitFor(
          () => {
            const tab = sidebar.querySelector(
              '[role="tab"][aria-controls*="terminal:"]'
            ) as HTMLElement | null;
            if (!tab) throw new Error("Terminal tab not found after Cmd+T");
            return tab;
          },
          { timeout: 10_000 }
        );

        await waitFor(() => {
          expect(terminalTab.getAttribute("aria-selected")).toBe("true");
        });

        // Verify terminal panel is visible (not hidden)
        const terminalPanel = await waitFor(
          () => {
            const panel = sidebar.querySelector(
              '[role="tabpanel"][id*="terminal"]:not([hidden])'
            ) as HTMLElement | null;
            if (!panel) throw new Error("Terminal panel not visible");
            return panel;
          },
          { timeout: 5_000 }
        );

        // Verify the terminal view is rendered inside the panel
        await waitFor(
          () => {
            const terminalView = terminalPanel.querySelector(
              ".terminal-view"
            ) as HTMLElement | null;
            if (!terminalView) throw new Error("Terminal view not found");
          },
          { timeout: 5_000 }
        );

        // Note: Actual terminal focus cannot be reliably tested in happy-dom
        // because ghostty-web uses WebAssembly and complex browser APIs.
        // The autoFocus behavior is verified by the implementation passing
        // autoFocus={true} to TerminalView when the terminal is opened via keybind.
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 60_000);
});
