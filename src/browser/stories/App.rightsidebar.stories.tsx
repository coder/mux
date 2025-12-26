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
import {
  RIGHT_SIDEBAR_TAB_KEY,
  RIGHT_SIDEBAR_COSTS_WIDTH_KEY,
  RIGHT_SIDEBAR_REVIEW_WIDTH_KEY,
} from "@/common/constants/storage";
import type { ComponentType } from "react";
import type { MockSessionUsage } from "../../../.storybook/mocks/orpc";

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
        // Set per-tab widths: costs at 350px, review at 700px
        localStorage.setItem(RIGHT_SIDEBAR_COSTS_WIDTH_KEY, "350");
        localStorage.setItem(RIGHT_SIDEBAR_REVIEW_WIDTH_KEY, "700");

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
        localStorage.setItem(RIGHT_SIDEBAR_COSTS_WIDTH_KEY, "350");

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
              "anthropic:claude-sonnet-4-20250514": {
                // Realistic Anthropic usage: heavy caching, cache create is expensive
                input: { tokens: 2000, cost_usd: 0.006 },
                cached: { tokens: 45000, cost_usd: 0.0045 }, // Cache read: cheap
                cacheCreate: { tokens: 30000, cost_usd: 0.1125 }, // Cache create: expensive!
                output: { tokens: 3000, cost_usd: 0.045 },
                reasoning: { tokens: 0, cost_usd: 0 },
                model: "anthropic:claude-sonnet-4-20250514",
              },
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

    // Wait for costs to render - cache create should be dominant cost
    await waitFor(
      () => {
        canvas.getByText("Cache Create");
        canvas.getByText("Cache Read");
      },
      { timeout: 5000 }
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
        // Set distinct widths per tab to verify switching behavior
        localStorage.setItem(RIGHT_SIDEBAR_COSTS_WIDTH_KEY, "350");
        localStorage.setItem(RIGHT_SIDEBAR_REVIEW_WIDTH_KEY, "700");

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
 * Stats tab when idle (no timing data) - shows placeholder message
 */
export const StatsTabIdle: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("stats"));

        const client = setupSimpleChatStory({
          workspaceId: "ws-stats-idle",
          workspaceName: "feature/stats",
          projectName: "my-app",
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
        localStorage.setItem(RIGHT_SIDEBAR_REVIEW_WIDTH_KEY, "700");

        const workspaceId = "ws-review-sort";
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

    // Wait for review tab to be selected and loaded
    await waitFor(
      () => {
        canvas.getByRole("tab", { name: /^review/i, selected: true });
      },
      { timeout: 5000 }
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
        localStorage.setItem(RIGHT_SIDEBAR_REVIEW_WIDTH_KEY, "700");

        const workspaceId = "ws-review-file-order";

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

    // Wait for review tab to be selected
    await waitFor(
      () => {
        canvas.getByRole("tab", { name: /^review/i, selected: true });
      },
      { timeout: 5000 }
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
        localStorage.setItem(RIGHT_SIDEBAR_REVIEW_WIDTH_KEY, "700");

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

    // Wait for review tab to be selected
    await waitFor(
      () => {
        canvas.getByRole("tab", { name: /^review/i, selected: true });
      },
      { timeout: 5000 }
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
        localStorage.setItem(RIGHT_SIDEBAR_REVIEW_WIDTH_KEY, "700");

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

    // Wait for diff content to render
    await waitFor(
      () => {
        canvas.getByText(/export const config/i);
      },
      { timeout: 5000 }
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
        localStorage.setItem(RIGHT_SIDEBAR_REVIEW_WIDTH_KEY, "700");

        const workspaceId = "ws-read-more";

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

export const ReviewTabReadMoreBoundaries: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("review"));
        localStorage.setItem(RIGHT_SIDEBAR_REVIEW_WIDTH_KEY, "700");

        const workspaceId = "ws-read-more-boundaries";

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
