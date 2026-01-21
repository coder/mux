/**
 * RightSidebar tab stories - testing dynamic tab data display
 *
 * Uses wide viewport (1600px) to ensure RightSidebar tabs are visible.
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import {
  setupSimpleChatStory,
  setupStreamingChatStory,
  expandRightSidebar,
  setHunkFirstSeen,
  setReviewSortOrder,
} from "./storyHelpers";
import { createUserMessage, createAssistantMessage } from "./mockFactory";
import { within, userEvent, waitFor, expect } from "@storybook/test";
import { blurActiveElement } from "./storyPlayHelpers.js";
import {
  RIGHT_SIDEBAR_TAB_KEY,
  RIGHT_SIDEBAR_WIDTH_KEY,
  getRightSidebarLayoutKey,
} from "@/common/constants/storage";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import type { ComponentType } from "react";
import type { MockSessionUsage } from "@/browser/stories/mocks/orpc";

export default {
  ...appMeta,
  title: "App/RightSidebar",
  decorators: [
    (Story: ComponentType) => (
      <div style={{ width: 1600, height: "100dvh" }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    ...appMeta.parameters,
    chromatic: {
      ...(appMeta.parameters?.chromatic ?? {}),
      modes: {
        dark: { theme: "dark", viewport: 1600 },
        light: { theme: "light", viewport: 1600 },
      },
    },
  },
};

/**
 * Helper to create session usage data with costs
 */
function createSessionUsage(cost: number): MockSessionUsage {
  const inputCost = cost * 0.6;
  const outputCost = cost * 0.2;
  const cachedCost = cost * 0.1;
  const reasoningCost = cost * 0.1;

  return {
    byModel: {
      "claude-sonnet-4-20250514": {
        input: { tokens: 10000, cost_usd: inputCost },
        cached: { tokens: 5000, cost_usd: cachedCost },
        cacheCreate: { tokens: 0, cost_usd: 0 },
        output: { tokens: 2000, cost_usd: outputCost },
        reasoning: { tokens: 1000, cost_usd: reasoningCost },
        model: "claude-sonnet-4-20250514",
      },
    },
    version: 1,
  };
}

/**
 * Costs tab with session cost displayed in tab label ($0.56)
 */
export const CostsTab: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("costs"));
        localStorage.setItem("costsTab:viewMode", JSON.stringify("session"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "400");
        localStorage.removeItem(getRightSidebarLayoutKey("ws-costs"));

        const client = setupSimpleChatStory({
          workspaceId: "ws-costs",
          workspaceName: "feature/api",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Help me build an API", { historySequence: 1 }),
            createAssistantMessage("msg-2", "I'll help you build a REST API.", {
              historySequence: 2,
            }),
          ],
          sessionUsage: createSessionUsage(0.56),
        });
        expandRightSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Session usage is fetched async via WorkspaceStore; wait to avoid snapshot races.
    await waitFor(
      () => {
        canvas.getByRole("tab", { name: /costs.*\$0\.56/i });
      },
      { timeout: 5000 }
    );
  },
};

/**
 * Costs tab showing cache create vs cache read differentiation.
 * Cache create is more expensive than cache read; both render in grey tones.
 * This story uses realistic Anthropic-style usage where most input is cached.
 */
export const CostsTabWithCacheCreate: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("costs"));
        localStorage.setItem("costsTab:viewMode", JSON.stringify("session"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "350");
        const modelUsage = {
          // Realistic Anthropic usage: heavy caching, cache create is expensive
          input: { tokens: 2000, cost_usd: 0.006 },
          cached: { tokens: 45000, cost_usd: 0.0045 }, // Cache read: cheap
          cacheCreate: { tokens: 30000, cost_usd: 0.1125 }, // Cache create: expensive!
          output: { tokens: 3000, cost_usd: 0.045 },
          reasoning: { tokens: 0, cost_usd: 0 },
          model: "anthropic:claude-sonnet-4-20250514",
        };

        localStorage.removeItem(getRightSidebarLayoutKey("ws-cache-create"));

        const client = setupSimpleChatStory({
          workspaceId: "ws-cache-create",
          workspaceName: "feature/caching",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Refactor the auth module", { historySequence: 1 }),
            createAssistantMessage("msg-2", "I'll refactor the authentication module.", {
              historySequence: 2,
            }),
          ],
          sessionUsage: {
            byModel: {
              [modelUsage.model]: modelUsage,
            },
            lastRequest: {
              model: modelUsage.model,
              usage: modelUsage,
              timestamp: 0,
            },
            version: 1,
          },
        });
        expandRightSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Ensure we're on the Costs tab (layout state can persist across stories).
    const costsTab = await canvas.findByRole("tab", { name: /^costs/i }, { timeout: 10_000 });
    await userEvent.click(costsTab);

    // Wait for session usage to load + render.
    await waitFor(
      () => {
        canvas.getByText(/cache create/i);
        canvas.getByText(/cache read/i);
      },
      { timeout: 15_000 }
    );
  },
};

/**
 * Review tab selected - click switches from Costs to Review tab
 * Verifies per-tab width persistence: starts at Costs width (350px), switches to Review width (700px)
 */
export const ReviewTab: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("costs"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "700");
        localStorage.removeItem(getRightSidebarLayoutKey("ws-review"));

        const client = setupSimpleChatStory({
          workspaceId: "ws-review",
          workspaceName: "feature/review",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Add a new component", { historySequence: 1 }),
            createAssistantMessage("msg-2", "I've added the component.", { historySequence: 2 }),
          ],
          sessionUsage: createSessionUsage(0.42),
        });
        expandRightSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for session usage to land (avoid theme/mode snapshots diverging on timing).
    await waitFor(
      () => {
        canvas.getByRole("tab", { name: /costs.*\$0\.42/i });
      },
      { timeout: 5000 }
    );

    const reviewTab = canvas.getByRole("tab", { name: /^review/i });
    await userEvent.click(reviewTab);

    await waitFor(() => {
      canvas.getByRole("tab", { name: /^review/i, selected: true });
    });
  },
};

/**
 * Explorer tab showing workspace file tree with folders and files
 */
export const ExplorerTab: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("explorer"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "350");
        localStorage.removeItem(getRightSidebarLayoutKey("ws-explorer"));

        const client = setupSimpleChatStory({
          workspaceId: "ws-explorer",
          workspaceName: "feature/files",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Show me the project structure", { historySequence: 1 }),
            createAssistantMessage("msg-2", "Here is the project structure.", {
              historySequence: 2,
            }),
          ],
        });
        expandRightSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for explorer tab to be available and click it
    const explorerTab = await canvas.findByRole("tab", { name: /^explorer/i }, { timeout: 3000 });
    await userEvent.click(explorerTab);

    // Wait for file tree to load (mock returns src, tests, node_modules, etc.)
    await waitFor(
      () => {
        canvas.getByText("src");
        canvas.getByText("package.json");
      },
      { timeout: 5000 }
    );

    // Verify ignored folder is shown with reduced opacity (node_modules)
    await waitFor(() => {
      canvas.getByText("node_modules");
    });
  },
};

/**
 * Explorer tab with expanded directory showing Collapse All button
 */
export const ExplorerTabExpanded: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("explorer"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "350");
        localStorage.removeItem(getRightSidebarLayoutKey("ws-explorer-expanded"));

        const client = setupSimpleChatStory({
          workspaceId: "ws-explorer-expanded",
          workspaceName: "feature/files",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Show me the project structure", { historySequence: 1 }),
            createAssistantMessage("msg-2", "Here is the project structure.", {
              historySequence: 2,
            }),
          ],
        });
        expandRightSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for explorer tab and click it
    const explorerTab = await canvas.findByRole("tab", { name: /^explorer/i }, { timeout: 3000 });
    await userEvent.click(explorerTab);

    // Wait for file tree to load
    await waitFor(
      () => {
        canvas.getByText("src");
      },
      { timeout: 5000 }
    );

    // Click on src folder to expand it
    const srcFolder = canvas.getByText("src");
    await userEvent.click(srcFolder);

    // Wait for src contents to load and collapse all button to appear
    await waitFor(
      () => {
        canvas.getByText("App.tsx");
        canvas.getByText("components");
      },
      { timeout: 5000 }
    );

    // Verify collapse all button is visible (tooltip text)
    await waitFor(() => {
      canvas.getByRole("button", { name: /collapse all/i });
    });

    // Blur to get clean screenshot
    blurActiveElement();
  },
};

/**
 * Explorer tab with selected item showing blue background
 */
export const ExplorerTabSelected: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("explorer"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "350");
        localStorage.removeItem(getRightSidebarLayoutKey("ws-explorer-selected"));

        const client = setupSimpleChatStory({
          workspaceId: "ws-explorer-selected",
          workspaceName: "feature/files",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Show me the project structure", { historySequence: 1 }),
            createAssistantMessage("msg-2", "Here is the project structure.", {
              historySequence: 2,
            }),
          ],
        });
        expandRightSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for explorer tab and click it
    const explorerTab = await canvas.findByRole("tab", { name: /^explorer/i }, { timeout: 3000 });
    await userEvent.click(explorerTab);

    // Wait for file tree to load
    await waitFor(
      () => {
        canvas.getByText("src");
      },
      { timeout: 5000 }
    );

    // Click on src folder to select it (will have focus/selected blue background)
    // Using a folder instead of a file to avoid opening a file viewer tab
    const srcFolder = canvas.getByText("src");
    await userEvent.click(srcFolder);

    // Don't blur - keep the item selected/focused for the screenshot
  },
};

/**
 * Stats tab when idle (no timing data) - shows placeholder message
 */
export const StatsTabIdle: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("stats"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "400");
        // Clear persisted layout to ensure stats tab appears in fresh default layout
        localStorage.removeItem(getRightSidebarLayoutKey("ws-stats-idle"));

        const client = setupSimpleChatStory({
          workspaceId: "ws-stats-idle",
          workspaceName: "feature/stats",
          projectName: "my-app",
          statsTabEnabled: true,
          messages: [
            createUserMessage("msg-1", "Help me with something", { historySequence: 1 }),
            createAssistantMessage("msg-2", "Sure, I can help with that.", { historySequence: 2 }),
          ],
          sessionUsage: createSessionUsage(0.25),
        });
        expandRightSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Feature flags are async, so allow more time.
    const statsTab = await canvas.findByRole("tab", { name: /^stats/i }, { timeout: 3000 });
    await userEvent.click(statsTab);

    await waitFor(() => {
      canvas.getByText(/no timing data yet/i);
    });
  },
};

/**
 * Stats tab during active streaming - shows timing statistics
 */
export const StatsTabStreaming: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("stats"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "400");
        // Clear persisted layout to ensure stats tab appears in fresh default layout
        localStorage.removeItem(getRightSidebarLayoutKey("ws-stats-streaming"));

        const client = setupStreamingChatStory({
          workspaceId: "ws-stats-streaming",
          workspaceName: "feature/streaming",
          projectName: "my-app",
          statsTabEnabled: true,
          messages: [
            createUserMessage("msg-1", "Write a comprehensive test suite", { historySequence: 1 }),
          ],
          streamingMessageId: "msg-2",
          historySequence: 2,
          streamText: "I'll create a test suite for you. Let me start by analyzing...",
        });
        expandRightSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Feature flags are async; wait for Stats tab to appear, then select it.
    const statsTab = await canvas.findByRole("tab", { name: /^stats/i }, { timeout: 5000 });
    await userEvent.click(statsTab);

    await waitFor(
      () => {
        canvas.getByRole("tab", { name: /^stats/i, selected: true });
      },
      { timeout: 5000 }
    );

    // Verify timing header is shown (with pulsing active indicator)
    await waitFor(() => {
      canvas.getByText(/timing/i);
    });

    // Verify timing table components are displayed
    await waitFor(() => {
      canvas.getByText(/model time/i);
    });
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// REVIEW TAB SORTING STORIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sample git diff output for review panel stories
 */
const SAMPLE_DIFF_OUTPUT = `diff --git a/src/utils/format.ts b/src/utils/format.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/utils/format.ts
@@ -0,0 +1,12 @@
+export function formatDate(date: Date): string {
+  return date.toISOString();
+}
+
+export function formatCurrency(amount: number): string {
+  return \`$\${amount.toFixed(2)}\`;
+}
+
+export function formatPercentage(value: number): string {
+  return \`\${(value * 100).toFixed(1)}%\`;
+}
+
diff --git a/src/components/Button.tsx b/src/components/Button.tsx
index def5678..ghi9012 100644
--- a/src/components/Button.tsx
+++ b/src/components/Button.tsx
@@ -1,8 +1,15 @@
 import React from 'react';
 
-export const Button = ({ children }) => {
+interface ButtonProps {
+  children: React.ReactNode;
+  variant?: 'primary' | 'secondary';
+  onClick?: () => void;
+}
+
+export const Button: React.FC<ButtonProps> = ({ children, variant = 'primary', onClick }) => {
   return (
-    <button className="btn">
+    <button className={\`btn btn-\${variant}\`} onClick={onClick}>
       {children}
     </button>
   );
diff --git a/src/api/client.ts b/src/api/client.ts
index 111aaa..222bbb 100644
--- a/src/api/client.ts
+++ b/src/api/client.ts
@@ -5,6 +5,10 @@ const BASE_URL = '/api';
 export async function fetchData(endpoint: string) {
   const response = await fetch(\`\${BASE_URL}/\${endpoint}\`);
+  if (!response.ok) {
+    throw new Error(\`HTTP error: \${response.status}\`);
+  }
   return response.json();
 }
`;

const SAMPLE_NUMSTAT_OUTPUT = `12\t0\tsrc/utils/format.ts
10\t3\tsrc/components/Button.tsx
4\t0\tsrc/api/client.ts`;

// Hunk IDs generated from the diff content (these match what diffParser produces)
// We use approximate hunk IDs based on how generateHunkId works
const HUNK_IDS = {
  format: "hunk-1a2b3c4d",
  button: "hunk-5e6f7g8h",
  client: "hunk-9i0j1k2l",
};

/**
 * Review tab with hunks sorted by "Last edit" (LIFO order).
 * Shows timestamps in hunk headers indicating when each change was first seen.
 */
export const ReviewTabSortByLastEdit: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("review"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "700");
        // Clear persisted layout to ensure review tab appears in fresh default layout
        const workspaceId = "ws-review-sort";
        localStorage.removeItem(getRightSidebarLayoutKey(workspaceId));
        const now = Date.now();

        // Set up first-seen timestamps for hunks (oldest to newest: format -> button -> client)
        // We use placeholder IDs since exact hash depends on content
        setHunkFirstSeen(workspaceId, {
          // format.ts was seen 2 hours ago
          [HUNK_IDS.format]: now - 2 * 60 * 60 * 1000,
          // Button.tsx was seen 30 minutes ago
          [HUNK_IDS.button]: now - 30 * 60 * 1000,
          // client.ts was seen 5 minutes ago
          [HUNK_IDS.client]: now - 5 * 60 * 1000,
        });

        // Set sort order to "last-edit"
        setReviewSortOrder("last-edit");

        const client = setupSimpleChatStory({
          workspaceId,
          workspaceName: "feature/sorting",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Add utilities and refactor button", { historySequence: 1 }),
            createAssistantMessage("msg-2", "Done! Added format utilities and improved Button.", {
              historySequence: 2,
            }),
          ],
          gitDiff: {
            diffOutput: SAMPLE_DIFF_OUTPUT,
            numstatOutput: SAMPLE_NUMSTAT_OUTPUT,
          },
        });
        expandRightSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Ensure the Review tab is active. Storybook can reuse a long-lived AppLoader
    // instance between stories, so persisted state might not apply until interaction.
    const expandButtons = canvas.queryAllByRole("button", { name: "Expand sidebar" });
    if (expandButtons.length > 0) {
      await userEvent.click(expandButtons[expandButtons.length - 1]);
    }

    const reviewTab = await canvas.findByRole("tab", { name: /^review/i }, { timeout: 10_000 });
    await userEvent.click(reviewTab);

    await waitFor(
      () => {
        canvas.getByRole("tab", { name: /^review/i, selected: true });
      },
      { timeout: 10_000 }
    );

    // Verify the sort dropdown shows "Last edit"
    // Use a more specific selector since there are multiple combobox elements
    const sortSelect = await canvas.findByRole(
      "combobox",
      { name: /sort hunks by/i },
      { timeout: 3000 }
    );
    await expect(sortSelect).toHaveValue("last-edit");

    // Wait for hunks to load - look for file paths in the diff
    // Use getAllByText since files appear in both file tree and hunk headers
    await waitFor(
      () => {
        canvas.getAllByText(/format\.ts/i);
        canvas.getAllByText(/Button\.tsx/i);
        canvas.getAllByText(/client\.ts/i);
      },
      { timeout: 5000 }
    );

    // Verify relative time indicators are shown (e.g., "5m ago", "30m ago", "2h ago")
    // These come from the firstSeenAt timestamps we set
    await waitFor(
      async () => {
        // At least one relative time indicator should be visible
        const timeIndicators = canvas.getAllByText(/ago|just now/i);
        await expect(timeIndicators.length).toBeGreaterThan(0);
      },
      { timeout: 3000 }
    );
  },
};

/**
 * Review tab with hunks sorted by file order (default).
 * Demonstrates switching between sort modes.
 */
export const ReviewTabSortByFileOrder: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("review"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "700");
        const workspaceId = "ws-review-file-order";
        localStorage.removeItem(getRightSidebarLayoutKey(workspaceId));

        // Set sort order to "file-order" (default)
        setReviewSortOrder("file-order");

        const client = setupSimpleChatStory({
          workspaceId,
          workspaceName: "feature/file-order",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Make some changes", { historySequence: 1 }),
            createAssistantMessage("msg-2", "Changes made.", { historySequence: 2 }),
          ],
          gitDiff: {
            diffOutput: SAMPLE_DIFF_OUTPUT,
            numstatOutput: SAMPLE_NUMSTAT_OUTPUT,
          },
        });
        expandRightSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Ensure Review tab is active (Storybook may reuse the same App instance).
    const expandButtons = canvas.queryAllByRole("button", { name: "Expand sidebar" });
    if (expandButtons.length > 0) {
      await userEvent.click(expandButtons[expandButtons.length - 1]);
    }

    const reviewTab = await canvas.findByRole("tab", { name: /^review/i }, { timeout: 10_000 });
    await userEvent.click(reviewTab);

    await waitFor(
      () => {
        canvas.getByRole("tab", { name: /^review/i, selected: true });
      },
      { timeout: 10_000 }
    );

    // Verify the sort dropdown shows "File order"
    // Use a more specific selector since there are multiple combobox elements
    const sortSelect = await canvas.findByRole(
      "combobox",
      { name: /sort hunks by/i },
      { timeout: 3000 }
    );
    await expect(sortSelect).toHaveValue("file-order");

    // Wait for hunks to load - use getAllByText since files appear in both file tree and hunk headers
    await waitFor(
      () => {
        canvas.getAllByText(/format\.ts/i);
      },
      { timeout: 5000 }
    );

    // Switch to "Last edit" sorting
    await userEvent.selectOptions(sortSelect, "last-edit");

    await expect(sortSelect).toHaveValue("last-edit");
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// DIFF LAYOUT STORIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Diff with mixed line types for visual alignment testing.
 * Tests that the padding strip at top/bottom of diff aligns correctly with
 * the gutter and code areas in the actual diff lines.
 *
 * Key visual checks:
 * - Top padding strip (green for additions) aligns with first + line's gutter/code split
 * - Bottom padding strip aligns with last line's gutter/code split
 * - The more saturated gutter background ends exactly at the indicator column
 * - The less saturated code background starts at the indicator column
 */
const ALIGNMENT_TEST_DIFF = `diff --git a/src/test.ts b/src/test.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/test.ts
@@ -0,0 +1,8 @@
+// This file tests diff padding alignment
+export function add(a: number, b: number): number {
+  return a + b;
+}
+
+export function subtract(a: number, b: number): number {
+  return a - b;
+}
`;

const ALIGNMENT_TEST_NUMSTAT = `8\t0\tsrc/test.ts`;

/**
 * Review tab with diff focused on padding alignment verification.
 * The saturated green gutter (line numbers) should align perfectly with
 * the top/bottom padding strips. The indicator column (+/-) should have
 * the less saturated code background.
 */
export const DiffPaddingAlignment: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("review"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "700");
        localStorage.removeItem(getRightSidebarLayoutKey("ws-diff-alignment"));

        const client = setupSimpleChatStory({
          workspaceId: "ws-diff-alignment",
          workspaceName: "feature/alignment-test",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Add math utilities", { historySequence: 1 }),
            createAssistantMessage("msg-2", "Added the utilities.", { historySequence: 2 }),
          ],
          gitDiff: {
            diffOutput: ALIGNMENT_TEST_DIFF,
            numstatOutput: ALIGNMENT_TEST_NUMSTAT,
          },
        });
        expandRightSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Ensure Review tab is active.
    const expandButtons = canvas.queryAllByRole("button", { name: "Expand sidebar" });
    if (expandButtons.length > 0) {
      await userEvent.click(expandButtons[expandButtons.length - 1]);
    }

    const reviewTab = await canvas.findByRole("tab", { name: /^review/i }, { timeout: 10_000 });
    await userEvent.click(reviewTab);

    // Wait for Review tab to be selected.
    await waitFor(
      () => {
        canvas.getByRole("tab", { name: /^review/i, selected: true });
      },
      { timeout: 10_000 }
    );

    // Wait for diff content to render
    await waitFor(
      () => {
        canvas.getByText(/add\(a: number/i);
      },
      { timeout: 5000 }
    );

    // Visual verification: the padding strip should align with the diff gutter
    // This is primarily a visual regression test for Chromatic
  },
};

/**
 * Diff with context lines (modifications) for alignment testing.
 * Shows a mix of context lines (no background), removals (red), and additions (green).
 * Verifies padding alignment works for the most common diff pattern.
 */
const MODIFICATION_DIFF = `diff --git a/src/config.ts b/src/config.ts
index aaa1111..bbb2222 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,7 +1,9 @@
 export const config = {
-  timeout: 1000,
-  retries: 3,
+  timeout: 5000,
+  retries: 5,
+  maxConnections: 10,
   debug: false,
+  verbose: true,
 };
`;

const MODIFICATION_NUMSTAT = `4\t2\tsrc/config.ts`;

/**
 * Review tab with modification diff (context + additions + removals).
 * Tests padding alignment when the first line is context (neutral) and
 * the diff contains mixed line types.
 */
export const DiffPaddingAlignmentModification: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("review"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "700");
        localStorage.removeItem(getRightSidebarLayoutKey("ws-diff-modification"));

        const client = setupSimpleChatStory({
          workspaceId: "ws-diff-modification",
          workspaceName: "feature/config-update",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Update config values", { historySequence: 1 }),
            createAssistantMessage("msg-2", "Updated config.", { historySequence: 2 }),
          ],
          gitDiff: {
            diffOutput: MODIFICATION_DIFF,
            numstatOutput: MODIFICATION_NUMSTAT,
          },
        });
        expandRightSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Ensure Review tab is active.
    const expandButtons = canvas.queryAllByRole("button", { name: "Expand sidebar" });
    if (expandButtons.length > 0) {
      await userEvent.click(expandButtons[expandButtons.length - 1]);
    }

    const reviewTab = await canvas.findByRole("tab", { name: /^review/i }, { timeout: 10_000 });
    await userEvent.click(reviewTab);

    // Wait for diff content to render
    await waitFor(
      () => {
        canvas.getByText(/export const config/i);
      },
      { timeout: 10_000 }
    );

    // Visual verification for mixed diff types
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// READ-MORE CONTEXT EXPANSION STORIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sample file content for read-more feature testing.
 * This simulates a longer file where only a portion is shown in the diff.
 */
const BUTTON_FILE_CONTENT = [
  "// Button component with variants",
  "// Created for the design system",
  "//",
  "// Supports: primary, secondary variants",
  "// Accessible by default",
  "",
  "import React from 'react';",
  "",
  "interface ButtonProps {",
  "  children: React.ReactNode;",
  "  variant?: 'primary' | 'secondary';",
  "  onClick?: () => void;",
  "}",
  "",
  "export const Button: React.FC<ButtonProps> = ({ children, variant = 'primary', onClick }) => {",
  "  return (",
  "    <button className={`btn btn-${variant}`} onClick={onClick}>",
  "      {children}",
  "    </button>",
  "  );",
  "};",
  "",
  "// Default export for convenience",
  "export default Button;",
];

/**
 * Diff that only shows lines 7-21 of the Button file.
 * The read-more feature should be able to expand to show lines 1-6 above
 * and lines 22-24 below.
 */
const READ_MORE_DIFF_OUTPUT = `diff --git a/src/components/Button.tsx b/src/components/Button.tsx
index def5678..ghi9012 100644
--- a/src/components/Button.tsx
+++ b/src/components/Button.tsx
@@ -7,8 +7,15 @@ import React from 'react';
 
-export const Button = ({ children }) => {
+interface ButtonProps {
+  children: React.ReactNode;
+  variant?: 'primary' | 'secondary';
+  onClick?: () => void;
+}
+
+export const Button: React.FC<ButtonProps> = ({ children, variant = 'primary', onClick }) => {
   return (
-    <button className="btn">
+    <button className={\`btn btn-\${variant}\`} onClick={onClick}>
       {children}
     </button>
   );
`;

const READ_MORE_NUMSTAT_OUTPUT = `10\t3\tsrc/components/Button.tsx`;

/**
 * Review tab with read-more feature to expand context above/below hunks.
 * Click ▲ to show more context above, ▼ to show more context below.
 */
export const ReviewTabReadMore: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("review"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "700");
        const workspaceId = "ws-read-more";
        localStorage.removeItem(getRightSidebarLayoutKey(workspaceId));

        const client = setupSimpleChatStory({
          workspaceId,
          workspaceName: "feature/button-types",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Add TypeScript types to Button", { historySequence: 1 }),
            createAssistantMessage("msg-2", "Done! Added ButtonProps interface.", {
              historySequence: 2,
            }),
          ],
          gitDiff: {
            diffOutput: READ_MORE_DIFF_OUTPUT,
            numstatOutput: READ_MORE_NUMSTAT_OUTPUT,
            fileContents: new Map([["src/components/Button.tsx", BUTTON_FILE_CONTENT]]),
          },
        });
        expandRightSidebar();
        return client;
      }}
    />
  ),
  // No play function - interaction testing covered by tests/ui/readMore.integration.test.ts
};

/**
 * Review tab testing boundary behavior (BOF/EOF).
 * Uses a small file where expanding quickly reaches file boundaries.
 */
const SMALL_FILE_CONTENT = [
  "// Tiny utility",
  "export const add = (a: number, b: number) => a + b;",
  "export const sub = (a: number, b: number) => a - b;",
];

const SMALL_FILE_DIFF_OUTPUT = `diff --git a/src/utils/math.ts b/src/utils/math.ts
index aaa1111..bbb2222 100644
--- a/src/utils/math.ts
+++ b/src/utils/math.ts
@@ -1,2 +1,3 @@
 // Tiny utility
 export const add = (a: number, b: number) => a + b;
+export const sub = (a: number, b: number) => a - b;
`;

const SMALL_FILE_NUMSTAT_OUTPUT = `1\t0\tsrc/utils/math.ts`;

/**
 * Review tab with file filter active - shows the filter indicator prominently
 * User has clicked on a file in the tree to filter hunks to just that file.
 */
export const ReviewTabWithFileFilter: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("review"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "700");

        const workspaceId = "ws-review-file-filter";

        // Set active file filter - this would be set when user clicks a file in tree
        localStorage.setItem(
          `review-file-filter:${workspaceId}`,
          JSON.stringify("src/components/Button.tsx")
        );

        const client = setupSimpleChatStory({
          workspaceId,
          workspaceName: "feature/file-filter",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Refactor button component", { historySequence: 1 }),
            createAssistantMessage("msg-2", "Updated Button.tsx with proper types.", {
              historySequence: 2,
            }),
          ],
          gitDiff: {
            diffOutput: SAMPLE_DIFF_OUTPUT,
            numstatOutput: SAMPLE_NUMSTAT_OUTPUT,
          },
        });
        expandRightSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Ensure Review tab is active.
    const expandButtons = canvas.queryAllByRole("button", { name: "Expand sidebar" });
    if (expandButtons.length > 0) {
      await userEvent.click(expandButtons[expandButtons.length - 1]);
    }

    const reviewTab = await canvas.findByRole("tab", { name: /^review/i }, { timeout: 10_000 });
    await userEvent.click(reviewTab);

    await waitFor(
      () => {
        canvas.getByRole("tab", { name: /^review/i, selected: true });
      },
      { timeout: 10_000 }
    );

    // Wait for file tree to load
    await waitFor(
      () => {
        canvas.getByText("Files");
      },
      { timeout: 3000 }
    );

    // Verify file filter indicator is visible in the header (has clear button with ✕)
    await waitFor(
      async () => {
        // Look for the filter indicator button by its title attribute which includes "Filtering:"
        const filterIndicator = canvasElement.querySelector('button[title^="Filtering:"]');
        await expect(filterIndicator).toBeInTheDocument();
        await expect(filterIndicator).toHaveTextContent("Button.tsx");
      },
      { timeout: 3000 }
    );
  },
};

export const ReviewTabReadMoreBoundaries: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("review"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "700");
        const workspaceId = "ws-read-more-boundaries";
        localStorage.removeItem(getRightSidebarLayoutKey(workspaceId));

        const client = setupSimpleChatStory({
          workspaceId,
          workspaceName: "feature/math-utils",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Add subtraction utility", { historySequence: 1 }),
            createAssistantMessage("msg-2", "Added sub function.", {
              historySequence: 2,
            }),
          ],
          gitDiff: {
            diffOutput: SMALL_FILE_DIFF_OUTPUT,
            numstatOutput: SMALL_FILE_NUMSTAT_OUTPUT,
            fileContents: new Map([["src/utils/math.ts", SMALL_FILE_CONTENT]]),
          },
        });
        expandRightSidebar();
        return client;
      }}
    />
  ),
  // No play function - interaction testing covered by tests/ui/readMore.integration.test.ts
};

/**
 * Review tab with untracked files banner shown prominently above hunks.
 * The banner is collapsible and shows a "Track All Files" button when expanded.
 */
export const ReviewTabWithUntrackedFiles: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("review"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "700");
        const workspaceId = "ws-untracked";
        localStorage.removeItem(getRightSidebarLayoutKey(workspaceId));

        const client = setupSimpleChatStory({
          workspaceId,
          workspaceName: "feature/new-feature",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Add new utilities", { historySequence: 1 }),
            createAssistantMessage("msg-2", "Added new files and utilities.", {
              historySequence: 2,
            }),
          ],
          gitDiff: {
            diffOutput: SAMPLE_DIFF_OUTPUT,
            numstatOutput: SAMPLE_NUMSTAT_OUTPUT,
            untrackedFiles: [
              "src/utils/newHelper.ts",
              "src/components/NewComponent.tsx",
              "tests/newHelper.test.ts",
            ],
          },
        });
        expandRightSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Ensure Review tab is active
    const expandButtons = canvas.queryAllByRole("button", { name: "Expand sidebar" });
    if (expandButtons.length > 0) {
      await userEvent.click(expandButtons[expandButtons.length - 1]);
    }

    const reviewTab = await canvas.findByRole("tab", { name: /^review/i }, { timeout: 10_000 });
    await userEvent.click(reviewTab);

    await waitFor(
      () => {
        canvas.getByRole("tab", { name: /^review/i, selected: true });
      },
      { timeout: 10_000 }
    );

    // Wait for the untracked files banner to appear
    await waitFor(
      () => {
        canvas.getByText(/3 untracked files/i);
      },
      { timeout: 5000 }
    );

    // Expand the banner to show file list and Track All button
    const bannerButton = canvas.getByText(/untracked files/i);
    await userEvent.click(bannerButton);

    // Wait for expanded content
    await waitFor(() => {
      canvas.getByText("src/utils/newHelper.ts");
      canvas.getByText("Track All Files");
    });

    // Double-RAF for scroll stabilization after banner expansion changes layout
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    // Blur focus for clean screenshot
    blurActiveElement();
  },
};

/**
 * Many tabs at a narrow sidebar width should wrap into multiple rows.
 */
export const ManyTabsWrap: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-many-tabs";
        updatePersistedState(RIGHT_SIDEBAR_WIDTH_KEY, 280);
        updatePersistedState(getRightSidebarLayoutKey(workspaceId), {
          version: 1,
          nextId: 2,
          focusedTabsetId: "tabset-1",
          root: {
            type: "tabset",
            id: "tabset-1",
            tabs: [
              "costs",
              "review",
              "explorer",
              "stats",
              ...Array.from(
                { length: 12 },
                (_v, i) => `file:src/components/ThisIsAReallyLongFileName${i + 1}.tsx`
              ),
            ],
            activeTab: "review",
          },
        });

        const client = setupSimpleChatStory({
          workspaceId,
          workspaceName: "feature/many-tabs",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Open a lot of tabs", { historySequence: 1 }),
            createAssistantMessage("msg-2", "Ok.", { historySequence: 2 }),
          ],
        });
        expandRightSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const tablist = await canvas.findByRole(
      "tablist",
      { name: /sidebar views/i },
      { timeout: 10_000 }
    );

    await waitFor(async () => {
      const tabs = within(tablist).getAllByRole("tab");
      const rowTops = new Set(tabs.map((tab) => Math.round(tab.getBoundingClientRect().top)));
      await expect(rowTops.size).toBeGreaterThan(1);
    });

    blurActiveElement();
  },
};
