/**
 * README screenshot stories.
 *
 * Each story here is intended to match a screenshot embedded in README.md (docs/img/*.webp).
 * The goal is to keep these UI states reproducible and data-rich so we can refresh README
 * images from a named Storybook story.
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import {
  NOW,
  STABLE_TIMESTAMP,
  createWorkspace,
  createSSHWorkspace,
  groupWorkspacesByProject,
  createUserMessage,
  createAssistantMessage,
  createProposePlanTool,
  createStatusTool,
  createFileReadTool,
  createFileEditTool,
  createBashTool,
  createWebSearchTool,
  createStaticChatHandler,
  type GitStatusFixture,
} from "./mockFactory";
import {
  createOnChatAdapter,
  createGitStatusExecutor,
  expandProjects,
  selectWorkspace,
  expandRightSidebar,
  collapseRightSidebar,
} from "./storyHelpers";
import {
  createMockORPCClient,
  type MockSessionUsage,
  type MockTerminalSession,
} from "./mocks/orpc";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  GIT_STATUS_INDICATOR_MODE_KEY,
  LEFT_SIDEBAR_COLLAPSED_KEY,
  RIGHT_SIDEBAR_TAB_KEY,
  RIGHT_SIDEBAR_WIDTH_KEY,
  getRightSidebarLayoutKey,
} from "@/common/constants/storage";
import type { RightSidebarLayoutState } from "@/browser/utils/rightSidebarLayout";
import { within, userEvent, waitFor, expect } from "@storybook/test";

export default {
  ...appMeta,
  title: "Docs/README Screenshots",
  decorators: [
    (Story: () => JSX.Element) => (
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
        // README screenshots are taken in dark mode.
        dark: { theme: "dark", viewport: 1600 },
      },
    },
  },
};

const README_PROJECT_NAME = "mux";
const README_PROJECT_PATH = "/home/user/projects/mux";

const SAMPLE_DIFF_OUTPUT = `diff --git a/src/browser/components/WorkspaceShell.tsx b/src/browser/components/WorkspaceShell.tsx
index aaa1111..bbb2222 100644
--- a/src/browser/components/WorkspaceShell.tsx
+++ b/src/browser/components/WorkspaceShell.tsx
@@ -1,8 +1,14 @@
 import React from 'react';
 
 export function WorkspaceShell() {
-  return <div className="shell" />;
+  return (
+    <div className="shell">
+      <header className="shell-header">Mux</header>
+      <main className="shell-content" />
+    </div>
+  );
 }

diff --git a/src/browser/utils/layout.ts b/src/browser/utils/layout.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/browser/utils/layout.ts
@@ -0,0 +1,12 @@
+export function clamp(n: number, min: number, max: number) {
+  return Math.max(min, Math.min(max, n));
+}
+
+export function px(value: number) {
+  return value + "px";
+}
`;

const SAMPLE_NUMSTAT_OUTPUT = `14\t2\tsrc/browser/components/WorkspaceShell.tsx
12\t0\tsrc/browser/utils/layout.ts`;

const HERO_TERMINAL_SCREEN_STATE = [
  "\u001b[2J\u001b[H", // clear + home
  "\u001b[1;36m❯\u001b[0m bun test",
  "",
  " \u001b[32m✓\u001b[0m tests/ui/sidebar.test.tsx \u001b[90m(12 tests)\u001b[0m",
  " \u001b[32m✓\u001b[0m tests/ui/rightSidebar.test.tsx \u001b[90m(8 tests)\u001b[0m",
  " \u001b[32m✓\u001b[0m tests/ui/chat.test.tsx \u001b[90m(15 tests)\u001b[0m",
  " \u001b[32m✓\u001b[0m tests/ui/workspaceStore.test.tsx \u001b[90m(7 tests)\u001b[0m",
  "",
  " \u001b[1;32mTest Suites:\u001b[0m 4 passed, 4 total",
  " \u001b[1;32mTests:\u001b[0m       42 passed, 42 total",
  " \u001b[90mTime:\u001b[0m        4.21s",
  "",
  "\u001b[1;36m❯\u001b[0m make lint",
  "\u001b[32m✔\u001b[0m No lint errors found",
  "",
  "\u001b[1;36m❯\u001b[0m make typecheck",
  "\u001b[90mChecking 284 files...\u001b[0m",
  "\u001b[32m✔\u001b[0m No type errors found",
  "",
  "\u001b[1;36m❯\u001b[0m \u001b[7m \u001b[0m",
].join("\r\n");

function createMultiModelSessionUsage(totalUsd: number): MockSessionUsage {
  // Split cost into model rows to make the Costs tab look realistic (cached + cacheCreate present).
  const primary = totalUsd * 0.75;
  const secondary = totalUsd * 0.25;

  const modelA = "anthropic:claude-sonnet-4-20250514";
  const modelB = "openai:gpt-4.1-mini";

  return {
    byModel: {
      [modelA]: {
        input: { tokens: 64_000, cost_usd: primary * 0.55 },
        cached: { tokens: 220_000, cost_usd: primary * 0.08 },
        cacheCreate: { tokens: 160_000, cost_usd: primary * 0.22 },
        output: { tokens: 18_000, cost_usd: primary * 0.12 },
        reasoning: { tokens: 0, cost_usd: primary * 0.03 },
        model: modelA,
      },
      [modelB]: {
        input: { tokens: 22_000, cost_usd: secondary * 0.6 },
        cached: { tokens: 0, cost_usd: 0 },
        cacheCreate: { tokens: 0, cost_usd: 0 },
        output: { tokens: 8_000, cost_usd: secondary * 0.4 },
        reasoning: { tokens: 0, cost_usd: 0 },
        model: modelB,
      },
    },
    lastRequest: {
      model: modelA,
      usage: {
        input: { tokens: 12_000, cost_usd: 0.03 },
        cached: { tokens: 0, cost_usd: 0 },
        cacheCreate: { tokens: 0, cost_usd: 0 },
        output: { tokens: 3_200, cost_usd: 0.012 },
        reasoning: { tokens: 0, cost_usd: 0 },
        model: modelA,
      },
      timestamp: 0,
    },
    version: 1,
  };
}

// README: docs/img/product-hero.webp
export const ProductHero: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        window.localStorage.setItem(GIT_STATUS_INDICATOR_MODE_KEY, JSON.stringify("line-delta"));
        window.localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "520");

        const workspaceId = "ws-hero";
        const terminalSessionId = "term-hero";

        const TERMINAL_BENCH_PROJECT_NAME = "terminal-bench";
        const TERMINAL_BENCH_PROJECT_PATH = `/home/user/projects/${TERMINAL_BENCH_PROJECT_NAME}`;
        const DOCS_PROJECT_NAME = "mux-docs";
        const DOCS_PROJECT_PATH = `/home/user/projects/${DOCS_PROJECT_NAME}`;
        const INFRA_PROJECT_NAME = "mux-infra";
        const INFRA_PROJECT_PATH = `/home/user/projects/${INFRA_PROJECT_NAME}`;

        const SECTION_FEATURES = "f00dbabe";
        const SECTION_REFACTORS = "c0ffeec0";
        const SECTION_DEPLOY = "d15ea5ed";

        const wsHero = createWorkspace({
          id: workspaceId,
          name: "readme/product-hero",
          projectName: README_PROJECT_NAME,
          projectPath: README_PROJECT_PATH,
          createdAt: new Date(NOW - 30 * 60_000).toISOString(),
        });

        const wsReview = createWorkspace({
          id: "ws-review",
          name: "feature/right-sidebar",
          projectName: README_PROJECT_NAME,
          projectPath: README_PROJECT_PATH,
          createdAt: new Date(NOW - 2 * 60 * 60_000).toISOString(),
        });
        wsReview.sectionId = SECTION_FEATURES;

        const wsAhead = createWorkspace({
          id: "ws-ahead",
          name: "feature/tooling",
          projectName: README_PROJECT_NAME,
          projectPath: README_PROJECT_PATH,
          createdAt: new Date(NOW - 3 * 60 * 60_000).toISOString(),
        });
        wsAhead.sectionId = SECTION_FEATURES;

        const wsDirty = createWorkspace({
          id: "ws-dirty",
          name: "bugfix/sidebar-scroll",
          projectName: README_PROJECT_NAME,
          projectPath: README_PROJECT_PATH,
          createdAt: new Date(NOW - 4 * 60 * 60_000).toISOString(),
        });
        wsDirty.sectionId = SECTION_FEATURES;

        const wsDiverged = createWorkspace({
          id: "ws-diverged",
          name: "refactor/workspace-store",
          projectName: README_PROJECT_NAME,
          projectPath: README_PROJECT_PATH,
          createdAt: new Date(NOW - 5 * 60 * 60_000).toISOString(),
        });
        wsDiverged.sectionId = SECTION_REFACTORS;

        const wsSsh = createSSHWorkspace({
          id: "ws-ssh",
          name: "deploy/staging",
          projectName: README_PROJECT_NAME,
          projectPath: README_PROJECT_PATH,
          host: "staging.example.com",
          createdAt: new Date(NOW - 6 * 60 * 60_000).toISOString(),
        });
        wsSsh.sectionId = SECTION_DEPLOY;

        const wsClean = createWorkspace({
          id: "ws-clean",
          name: "main",
          projectName: README_PROJECT_NAME,
          projectPath: README_PROJECT_PATH,
          createdAt: new Date(NOW - 7 * 60 * 60_000).toISOString(),
        });

        const terminalBenchWorkspaces = [
          createWorkspace({
            id: "ws-tb-main",
            name: "main",
            projectName: TERMINAL_BENCH_PROJECT_NAME,
            projectPath: TERMINAL_BENCH_PROJECT_PATH,
            createdAt: new Date(NOW - 8 * 60 * 60_000).toISOString(),
          }),
          createWorkspace({
            id: "ws-tb-flakes",
            name: "bugfix/flakes",
            projectName: TERMINAL_BENCH_PROJECT_NAME,
            projectPath: TERMINAL_BENCH_PROJECT_PATH,
            createdAt: new Date(NOW - 9 * 60 * 60_000).toISOString(),
          }),
          createWorkspace({
            id: "ws-tb-profiles",
            name: "perf/profiles",
            projectName: TERMINAL_BENCH_PROJECT_NAME,
            projectPath: TERMINAL_BENCH_PROJECT_PATH,
            createdAt: new Date(NOW - 10 * 60 * 60_000).toISOString(),
          }),
          createWorkspace({
            id: "ws-tb-ci",
            name: "chore/ci",
            projectName: TERMINAL_BENCH_PROJECT_NAME,
            projectPath: TERMINAL_BENCH_PROJECT_PATH,
            createdAt: new Date(NOW - 11 * 60 * 60_000).toISOString(),
          }),
        ];

        const docsWorkspaces = [
          createWorkspace({
            id: "ws-docs-main",
            name: "main",
            projectName: DOCS_PROJECT_NAME,
            projectPath: DOCS_PROJECT_PATH,
            createdAt: new Date(NOW - 12 * 60 * 60_000).toISOString(),
          }),
          createWorkspace({
            id: "ws-docs-readme",
            name: "docs/readme-refresh",
            projectName: DOCS_PROJECT_NAME,
            projectPath: DOCS_PROJECT_PATH,
            createdAt: new Date(NOW - 13 * 60 * 60_000).toISOString(),
          }),
          createWorkspace({
            id: "ws-docs-site",
            name: "feature/site-nav",
            projectName: DOCS_PROJECT_NAME,
            projectPath: DOCS_PROJECT_PATH,
            createdAt: new Date(NOW - 14 * 60 * 60_000).toISOString(),
          }),
        ];

        const infraWorkspaces = [
          createWorkspace({
            id: "ws-infra-main",
            name: "main",
            projectName: INFRA_PROJECT_NAME,
            projectPath: INFRA_PROJECT_PATH,
            createdAt: new Date(NOW - 15 * 60 * 60_000).toISOString(),
          }),
          createWorkspace({
            id: "ws-infra-terraform",
            name: "feature/terraform",
            projectName: INFRA_PROJECT_NAME,
            projectPath: INFRA_PROJECT_PATH,
            createdAt: new Date(NOW - 16 * 60 * 60_000).toISOString(),
          }),
          createWorkspace({
            id: "ws-infra-alerts",
            name: "chore/alerts",
            projectName: INFRA_PROJECT_NAME,
            projectPath: INFRA_PROJECT_PATH,
            createdAt: new Date(NOW - 17 * 60 * 60_000).toISOString(),
          }),
        ];

        const workspaces = [
          wsHero,
          wsReview,
          wsAhead,
          wsDirty,
          wsDiverged,
          wsSsh,
          wsClean,
          ...terminalBenchWorkspaces,
          ...docsWorkspaces,
          ...infraWorkspaces,
        ];

        const projects = groupWorkspacesByProject(workspaces);
        const muxConfig = projects.get(README_PROJECT_PATH);
        if (muxConfig) {
          projects.set(README_PROJECT_PATH, {
            ...muxConfig,
            sections: [
              {
                id: SECTION_FEATURES,
                name: "Features",
                color: "#4dabf7",
                nextId: SECTION_REFACTORS,
              },
              {
                id: SECTION_REFACTORS,
                name: "Refactors",
                color: "#ff6b6b",
                nextId: SECTION_DEPLOY,
              },
              {
                id: SECTION_DEPLOY,
                name: "Deploy",
                color: "#51cf66",
                nextId: null,
              },
            ],
          });
        }

        const gitStatus = new Map<string, GitStatusFixture>([
          [workspaceId, { dirty: 2, outgoingAdditions: 420, outgoingDeletions: 18 }],
          ["ws-review", { ahead: 1, outgoingAdditions: 120, outgoingDeletions: 12 }],
          ["ws-ahead", { ahead: 3, outgoingAdditions: 911, outgoingDeletions: 74 }],
          ["ws-dirty", { dirty: 6, outgoingAdditions: 64, outgoingDeletions: 9 }],
          [
            "ws-diverged",
            { ahead: 2, behind: 1, dirty: 1, outgoingAdditions: 1520, outgoingDeletions: 180 },
          ],
          ["ws-ssh", { behind: 4, originCommit: "Update deployment" }],
          ["ws-clean", {}],

          // Extra workspaces/projects for a busier sidebar.
          ["ws-tb-flakes", { dirty: 3 }],
          ["ws-tb-profiles", { ahead: 2, dirty: 1 }],
          ["ws-docs-readme", { ahead: 1, dirty: 1 }],
          ["ws-infra-terraform", { behind: 2 }],
        ]);

        const gitDiff = new Map([
          [
            workspaceId,
            {
              diffOutput: SAMPLE_DIFF_OUTPUT,
              numstatOutput: SAMPLE_NUMSTAT_OUTPUT,
            },
          ],
        ]);

        const chatHandlers = new Map([
          [
            workspaceId,
            createStaticChatHandler([
              createUserMessage(
                "msg-1",
                "Add a right sidebar split layout showing both the review diff and terminal output.",
                {
                  historySequence: 1,
                  timestamp: STABLE_TIMESTAMP - 50_000,
                }
              ),
              createAssistantMessage("msg-2", "Let me check the current layout implementation.", {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 40_000,
                toolCalls: [
                  createFileReadTool(
                    "call-read-1",
                    "src/browser/utils/rightSidebarLayout.ts",
                    'export type SplitDirection = "horizontal" | "vertical";\nexport interface RightSidebarLayoutState {\n  version: number;\n  root: LayoutNode;\n}'
                  ),
                ],
              }),
              createAssistantMessage(
                "msg-3",
                "I've updated the layout to support vertical splits. Running tests now.",
                {
                  historySequence: 3,
                  timestamp: STABLE_TIMESTAMP - 30_000,
                  toolCalls: [
                    createFileEditTool(
                      "call-edit-1",
                      "src/browser/utils/rightSidebarLayout.ts",
                      '@@ -12,6 +12,8 @@\n+  sizes: [0.62, 0.38],\n+  children: [{ type: "tabset", tabs: ["review"] }, { type: "tabset", tabs: ["terminal"] }]'
                    ),
                    createBashTool(
                      "call-bash-1",
                      "bun test -- rightSidebarLayout",
                      "✓ 4 tests passed"
                    ),
                  ],
                }
              ),
              createUserMessage(
                "msg-4",
                "Looks good, now make sure the terminal shows the test output.",
                {
                  historySequence: 4,
                  timestamp: STABLE_TIMESTAMP - 20_000,
                }
              ),
              createAssistantMessage(
                "msg-5",
                "Done! The terminal now shows test results by default when the split layout is active.",
                {
                  historySequence: 5,
                  timestamp: STABLE_TIMESTAMP - 10_000,
                  toolCalls: [createStatusTool("call-status-1", "✅", "Tests passing")],
                }
              ),
            ]),
          ],
          // Agent statuses on other workspaces to show sidebar activity indicators.
          [
            "ws-review",
            createStaticChatHandler([
              createAssistantMessage("msg-1", "Reviewing sidebar component performance.", {
                historySequence: 1,
                timestamp: STABLE_TIMESTAMP - 20_000,
                toolCalls: [createStatusTool("call-1", "🔍", "Reviewing perf regressions")],
              }),
            ]),
          ],
          [
            "ws-ahead",
            createStaticChatHandler([
              createAssistantMessage("msg-1", "Running integration tests.", {
                historySequence: 1,
                timestamp: STABLE_TIMESTAMP - 15_000,
                toolCalls: [createStatusTool("call-1", "🧪", "Running test suite")],
              }),
            ]),
          ],
          [
            "ws-dirty",
            createStaticChatHandler([
              createAssistantMessage("msg-1", "Fixing scroll position restoration.", {
                historySequence: 1,
                timestamp: STABLE_TIMESTAMP - 12_000,
                toolCalls: [createStatusTool("call-1", "📝", "Editing scroll logic")],
              }),
            ]),
          ],
          [
            "ws-diverged",
            createStaticChatHandler([
              createAssistantMessage("msg-1", "Refactoring store subscriptions.", {
                historySequence: 1,
                timestamp: STABLE_TIMESTAMP - 10_000,
                toolCalls: [createStatusTool("call-1", "🔄", "Cleaning up state")],
              }),
            ]),
          ],
          [
            "ws-ssh",
            createStaticChatHandler([
              createAssistantMessage("msg-1", "Deploying staging.", {
                historySequence: 1,
                timestamp: STABLE_TIMESTAMP - 8_000,
                toolCalls: [createStatusTool("call-1", "🚀", "Deploying to staging")],
              }),
            ]),
          ],
          [
            "ws-tb-flakes",
            createStaticChatHandler([
              createAssistantMessage("msg-1", "Investigating flaky tests.", {
                historySequence: 1,
                timestamp: STABLE_TIMESTAMP - 6_000,
                toolCalls: [createStatusTool("call-1", "🧪", "Reproducing flakes")],
              }),
            ]),
          ],
          [
            "ws-docs-readme",
            createStaticChatHandler([
              createAssistantMessage("msg-1", "Updating README screenshots.", {
                historySequence: 1,
                timestamp: STABLE_TIMESTAMP - 4_000,
                toolCalls: [createStatusTool("call-1", "📝", "Refreshing docs")],
              }),
            ]),
          ],
        ]);

        // Make the sidebar look expanded/busy, matching the README hero composition.
        // Expand all projects so the sidebar is densely populated with workspaces.
        expandProjects([
          README_PROJECT_PATH,
          TERMINAL_BENCH_PROJECT_PATH,
          DOCS_PROJECT_PATH,
          INFRA_PROJECT_PATH,
        ]);
        selectWorkspace(wsHero);

        // Force a split layout: Review (top) + Terminal (bottom).
        const layout: RightSidebarLayoutState = {
          version: 1,
          nextId: 3,
          focusedTabsetId: "tabset-1",
          root: {
            type: "split",
            id: "split-1",
            direction: "vertical",
            sizes: [0.62, 0.38],
            children: [
              {
                type: "tabset",
                id: "tabset-1",
                tabs: ["review", "costs", "explorer"],
                activeTab: "review",
              },
              {
                type: "tabset",
                id: "tabset-2",
                tabs: [`terminal:${terminalSessionId}`],
                activeTab: `terminal:${terminalSessionId}`,
              },
            ],
          },
        };

        window.localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("review"));
        updatePersistedState(getRightSidebarLayoutKey(workspaceId), layout);
        expandRightSidebar();

        const terminalSessions: MockTerminalSession[] = [
          {
            sessionId: terminalSessionId,
            workspaceId,
            cols: 80,
            rows: 24,
            screenState: HERO_TERMINAL_SCREEN_STATE,
          },
        ];

        return createMockORPCClient({
          projects,
          workspaces,
          onChat: createOnChatAdapter(chatHandlers),
          executeBash: createGitStatusExecutor(gitStatus, gitDiff),
          terminalSessions,
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for the Review panel hunks to render (diff data is fetched async).
    await waitFor(
      () => {
        canvas.getAllByText(/WorkspaceShell\.tsx/i);
      },
      { timeout: 10_000 }
    );
  },
};

// README: docs/img/code-review.webp
// Left sidebar collapsed, 50/50 split between chat and review pane, rich multi-turn chat.
export const CodeReview: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-code-review";

        const workspace = createWorkspace({
          id: workspaceId,
          name: "feature/code-review",
          projectName: README_PROJECT_NAME,
          projectPath: README_PROJECT_PATH,
        });

        // Collapse left sidebar to maximize space for chat + review.
        window.localStorage.setItem(LEFT_SIDEBAR_COLLAPSED_KEY, JSON.stringify(true));

        // 50/50 split: 800px review pane out of 1600px viewport.
        window.localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("review"));
        window.localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "800");
        window.localStorage.removeItem(getRightSidebarLayoutKey(workspaceId));

        const REVIEW_DIFF = `diff --git a/src/browser/components/WorkspaceShell.tsx b/src/browser/components/WorkspaceShell.tsx
index aaa1111..bbb2222 100644
--- a/src/browser/components/WorkspaceShell.tsx
+++ b/src/browser/components/WorkspaceShell.tsx
@@ -1,8 +1,18 @@
 import React from 'react';
+import { useRightSidebarLayout } from '../hooks/useRightSidebarLayout';
+import { clamp } from '../utils/layout';
 
-export function WorkspaceShell() {
-  return <div className="shell" />;
+export function WorkspaceShell(props: WorkspaceShellProps) {
+  const layout = useRightSidebarLayout(props.workspaceId);
+  const sidebarWidth = clamp(layout.width, 200, 800);
+
+  return (
+    <div className="shell">
+      <header className="shell-header" aria-label="Workspace">Mux</header>
+      <main className="shell-content" style={{ marginRight: sidebarWidth }} />
+      <aside className="shell-sidebar" style={{ width: sidebarWidth }} />
+    </div>
+  );
 }

diff --git a/src/browser/utils/layout.ts b/src/browser/utils/layout.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/browser/utils/layout.ts
@@ -0,0 +1,12 @@
+export function clamp(n: number, min: number, max: number) {
+  return Math.max(min, Math.min(max, n));
+}
+
+export function px(value: number) {
+  return value + "px";
+}

diff --git a/src/browser/hooks/useRightSidebarLayout.ts b/src/browser/hooks/useRightSidebarLayout.ts
new file mode 100644
index 0000000..def5678
--- /dev/null
+++ b/src/browser/hooks/useRightSidebarLayout.ts
@@ -0,0 +1,18 @@
+import { usePersistedState } from './usePersistedState';
+import { getRightSidebarLayoutKey } from '@/common/constants/storage';
+
+export function useRightSidebarLayout(workspaceId: string) {
+  const [layout] = usePersistedState(
+    getRightSidebarLayoutKey(workspaceId),
+    { width: 400, collapsed: false }
+  );
+  return layout;
+}`;

        const REVIEW_NUMSTAT = `10\t2\tsrc/browser/components/WorkspaceShell.tsx
12\t0\tsrc/browser/utils/layout.ts
18\t0\tsrc/browser/hooks/useRightSidebarLayout.ts`;

        const client = createMockORPCClient({
          projects: groupWorkspacesByProject([workspace]),
          workspaces: [workspace],
          onChat: createOnChatAdapter(
            new Map([
              [
                workspaceId,
                createStaticChatHandler([
                  createUserMessage(
                    "msg-1",
                    "Review this PR — focus on the layout changes and flag anything risky. The PR adds a right sidebar layout system to WorkspaceShell.",
                    {
                      historySequence: 1,
                      timestamp: STABLE_TIMESTAMP - 90_000,
                    }
                  ),
                  createAssistantMessage("msg-2", "I'll start by reading the changed files.", {
                    historySequence: 2,
                    timestamp: STABLE_TIMESTAMP - 80_000,
                    toolCalls: [
                      createFileReadTool(
                        "call-read-1",
                        "src/browser/components/WorkspaceShell.tsx",
                        'import React from \'react\';\nimport { useRightSidebarLayout } from \'../hooks/useRightSidebarLayout\';\nimport { clamp } from \'../utils/layout\';\n\nexport function WorkspaceShell(props: WorkspaceShellProps) {\n  const layout = useRightSidebarLayout(props.workspaceId);\n  const sidebarWidth = clamp(layout.width, 200, 800);\n  return (\n    <div className="shell">\n      <header className="shell-header" aria-label="Workspace">Mux</header>\n      <main className="shell-content" style={{ marginRight: sidebarWidth }} />\n      <aside className="shell-sidebar" style={{ width: sidebarWidth }} />\n    </div>\n  );\n}'
                      ),
                      createFileReadTool(
                        "call-read-2",
                        "src/browser/utils/layout.ts",
                        'export function clamp(n: number, min: number, max: number) {\n  return Math.max(min, Math.min(max, n));\n}\n\nexport function px(value: number) {\n  return value + "px";\n}'
                      ),
                      createFileReadTool(
                        "call-read-3",
                        "src/browser/hooks/useRightSidebarLayout.ts",
                        "import { usePersistedState } from './usePersistedState';\nimport { getRightSidebarLayoutKey } from '@/common/constants/storage';\n\nexport function useRightSidebarLayout(workspaceId: string) {\n  const [layout] = usePersistedState(\n    getRightSidebarLayoutKey(workspaceId),\n    { width: 400, collapsed: false }\n  );\n  return layout;\n}"
                      ),
                    ],
                  }),
                  createAssistantMessage(
                    "msg-3",
                    "The layout hook looks clean. Let me check for type safety and run the tests.",
                    {
                      historySequence: 3,
                      timestamp: STABLE_TIMESTAMP - 60_000,
                      toolCalls: [
                        createBashTool(
                          "call-bash-1",
                          "bun run typecheck",
                          "src/browser/utils/layout.ts:2:14 - warning: 'n' could be NaN\n\nFound 0 errors, 1 warning."
                        ),
                        createBashTool(
                          "call-bash-2",
                          "bun test -- WorkspaceShell useRightSidebarLayout layout",
                          "PASS  tests/ui/WorkspaceShell.test.tsx (6 tests)\nPASS  tests/ui/useRightSidebarLayout.test.tsx (4 tests)\nPASS  tests/ui/layout.test.tsx (3 tests)\n\nTest Suites: 3 passed, 3 total\nTests:       13 passed, 13 total\nTime:        1.84s"
                        ),
                      ],
                    }
                  ),
                  createAssistantMessage(
                    "msg-4",
                    "I also looked at how this integrates with the existing resize handle.",
                    {
                      historySequence: 4,
                      timestamp: STABLE_TIMESTAMP - 40_000,
                      toolCalls: [
                        createWebSearchTool(
                          "call-web-1",
                          "react resize observer sidebar layout pattern"
                        ),
                        createFileReadTool(
                          "call-read-4",
                          "src/browser/components/ResizeHandle.tsx",
                          'export function ResizeHandle(props: ResizeHandleProps) {\n  const onMouseDown = useCallback((e: React.MouseEvent) => {\n    e.preventDefault();\n    const startX = e.clientX;\n    // ...\n  }, []);\n  return <div className="resize-handle" onMouseDown={onMouseDown} />;\n}'
                        ),
                      ],
                    }
                  ),
                  createAssistantMessage(
                    "msg-5",
                    `**PR Summary**

**3 files changed** (+40, −2)

**Changes:**
- \`WorkspaceShell.tsx\` — Restructured to accept \`workspaceId\` prop and integrate the new sidebar layout hook. Added \`aria-label\` for accessibility.
- \`layout.ts\` — New \`clamp()\` and \`px()\` utilities.
- \`useRightSidebarLayout.ts\` — New hook that reads persisted layout state.

**Findings:**
1. ⚠️ \`clamp()\` doesn't guard against \`NaN\` — \`Math.max(NaN, min)\` returns \`NaN\`. Add a runtime check or default.
2. ⚠️ The sidebar width range (200–800) is hardcoded. Consider extracting to constants.
3. ✅ The \`aria-label\` on the header is a good accessibility addition.
4. ✅ Tests are comprehensive — 13 passing across 3 suites.

**Verdict:** Low risk, mostly additive. Fix the NaN guard before merging.`,
                    {
                      historySequence: 5,
                      timestamp: STABLE_TIMESTAMP - 20_000,
                    }
                  ),
                  createUserMessage("msg-6", "Good catch on the NaN issue. Fix it and ship.", {
                    historySequence: 6,
                    timestamp: STABLE_TIMESTAMP - 15_000,
                  }),
                  createAssistantMessage("msg-7", "Fixed and pushed.", {
                    historySequence: 7,
                    timestamp: STABLE_TIMESTAMP - 10_000,
                    toolCalls: [
                      createFileEditTool(
                        "call-edit-1",
                        "src/browser/utils/layout.ts",
                        "@@ -1,3 +1,4 @@\n export function clamp(n: number, min: number, max: number) {\n+  if (Number.isNaN(n)) return min;\n   return Math.max(min, Math.min(max, n));\n }"
                      ),
                      createBashTool(
                        "call-bash-3",
                        "bun test -- layout",
                        "PASS  tests/ui/layout.test.tsx (4 tests)\n\nTests: 4 passed, 4 total\nTime: 0.42s"
                      ),
                      createStatusTool(
                        "call-status-1",
                        "🚀",
                        "PR ready",
                        "https://github.com/coder/mux/pull/2035"
                      ),
                    ],
                  }),
                ]),
              ],
            ])
          ),
          executeBash: createGitStatusExecutor(
            new Map([
              [workspaceId, { ahead: 2, dirty: 0, outgoingAdditions: 40, outgoingDeletions: 2 }],
            ]),
            new Map([
              [
                workspaceId,
                {
                  diffOutput: REVIEW_DIFF,
                  numstatOutput: REVIEW_NUMSTAT,
                },
              ],
            ])
          ),
        });

        expandProjects([README_PROJECT_PATH]);
        selectWorkspace(workspace);

        expandRightSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for the Review tab to be selected and diff content to render.
    await waitFor(
      () => {
        canvas.getByRole("tab", { name: /^review/i, selected: true });
        canvas.getAllByText(/WorkspaceShell\.tsx/i);
      },
      { timeout: 10_000 }
    );
  },
};

// README: docs/img/agent-status.webp
// This story renders the full app. The screenshot is produced by Playwright
// clipping the left sidebar region and then upscaling to 1600×1171 with sharp.
export const AgentStatusSidebar: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaces = [
          createWorkspace({
            id: "ws-status-1",
            name: "feature/docs",
            projectName: README_PROJECT_NAME,
            projectPath: README_PROJECT_PATH,
          }),
          createWorkspace({
            id: "ws-status-2",
            name: "feature/sidebar",
            projectName: README_PROJECT_NAME,
            projectPath: README_PROJECT_PATH,
          }),
          createWorkspace({
            id: "ws-status-3",
            name: "bugfix/stream",
            projectName: README_PROJECT_NAME,
            projectPath: README_PROJECT_PATH,
          }),
          createWorkspace({
            id: "ws-status-4",
            name: "refactor/store",
            projectName: README_PROJECT_NAME,
            projectPath: README_PROJECT_PATH,
          }),
          createWorkspace({
            id: "ws-status-5",
            name: "feature/right-sidebar",
            projectName: README_PROJECT_NAME,
            projectPath: README_PROJECT_PATH,
          }),
          createSSHWorkspace({
            id: "ws-status-ssh",
            name: "deploy/prod",
            projectName: README_PROJECT_NAME,
            projectPath: README_PROJECT_PATH,
            host: "prod.example.com",
          }),
          createWorkspace({
            id: "ws-status-6",
            name: "release/v1.0.0",
            projectName: README_PROJECT_NAME,
            projectPath: README_PROJECT_PATH,
          }),
          createWorkspace({
            id: "ws-status-7",
            name: "main",
            projectName: README_PROJECT_NAME,
            projectPath: README_PROJECT_PATH,
          }),
        ];

        const chatHandlers = new Map([
          [
            "ws-status-1",
            createStaticChatHandler([
              createAssistantMessage("msg-1", "Working on README screenshot stories.", {
                historySequence: 1,
                timestamp: STABLE_TIMESTAMP - 100_000,
                toolCalls: [createStatusTool("call-1", "📝", "Building Storybook states")],
              }),
            ]),
          ],
          [
            "ws-status-2",
            createStaticChatHandler([
              createAssistantMessage("msg-1", "Tuning sidebar virtualization.", {
                historySequence: 1,
                timestamp: STABLE_TIMESTAMP - 95_000,
                toolCalls: [createStatusTool("call-1", "🔍", "Reviewing perf regressions")],
              }),
            ]),
          ],
          [
            "ws-status-3",
            createStaticChatHandler([
              createAssistantMessage("msg-1", "Investigating stream stalls.", {
                historySequence: 1,
                timestamp: STABLE_TIMESTAMP - 90_000,
                toolCalls: [createStatusTool("call-1", "🧪", "Reproducing with Playwright")],
              }),
            ]),
          ],
          [
            "ws-status-4",
            createStaticChatHandler([
              createAssistantMessage("msg-1", "Refactoring WorkspaceStore subscriptions.", {
                historySequence: 1,
                timestamp: STABLE_TIMESTAMP - 85_000,
                toolCalls: [createStatusTool("call-1", "🔄", "Cleaning up state")],
              }),
            ]),
          ],
          [
            "ws-status-5",
            createStaticChatHandler([
              createAssistantMessage("msg-1", "Adding split pane layout fixtures.", {
                historySequence: 1,
                timestamp: STABLE_TIMESTAMP - 80_000,
                toolCalls: [
                  createStatusTool(
                    "call-1",
                    "🚀",
                    "PR ready for review",
                    "https://github.com/mux/cmux/pull/1234"
                  ),
                ],
              }),
            ]),
          ],
          [
            "ws-status-ssh",
            createStaticChatHandler([
              createAssistantMessage("msg-1", "Deploying staging.", {
                historySequence: 1,
                timestamp: STABLE_TIMESTAMP - 70_000,
                toolCalls: [createStatusTool("call-1", "⏳", "Waiting for CI")],
              }),
            ]),
          ],
          [
            "ws-status-6",
            createStaticChatHandler([
              createAssistantMessage("msg-1", "Preparing release notes.", {
                historySequence: 1,
                timestamp: STABLE_TIMESTAMP - 65_000,
                toolCalls: [createStatusTool("call-1", "📝", "Drafting changelog")],
              }),
            ]),
          ],
          ["ws-status-7", createStaticChatHandler([])],
        ]);

        expandProjects([README_PROJECT_PATH]);
        selectWorkspace(workspaces[0]);
        collapseRightSidebar();

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
          onChat: createOnChatAdapter(chatHandlers),
        });
      }}
    />
  ),
};

// README: docs/img/git-status.webp
// The play function opens a Radix portaled tooltip which is unreliable in
// the headless test-runner. The capture script replicates the interaction via
// Playwright, so we skip this story in test-storybook.
export const GitStatusPopover: AppStory = {
  tags: ["!test"],
  render: () => (
    <AppWithMocks
      setup={() => {
        window.localStorage.setItem(GIT_STATUS_INDICATOR_MODE_KEY, JSON.stringify("line-delta"));

        const workspaces = [
          createWorkspace({
            id: "ws-clean",
            name: "main",
            projectName: README_PROJECT_NAME,
            projectPath: README_PROJECT_PATH,
            createdAt: new Date(NOW - 60_000).toISOString(),
          }),
          createWorkspace({
            id: "ws-diverged",
            name: "refactor/db",
            projectName: README_PROJECT_NAME,
            projectPath: README_PROJECT_PATH,
            createdAt: new Date(NOW - 2 * 60_000).toISOString(),
          }),
          createWorkspace({
            id: "ws-dirty",
            name: "bugfix/crash",
            projectName: README_PROJECT_NAME,
            projectPath: README_PROJECT_PATH,
            createdAt: new Date(NOW - 3 * 60_000).toISOString(),
          }),
        ];

        const gitStatus = new Map<string, GitStatusFixture>([
          ["ws-clean", {}],
          [
            "ws-diverged",
            { ahead: 3, behind: 2, dirty: 5, outgoingAdditions: 12_313, outgoingDeletions: 1_231 },
          ],
          ["ws-dirty", { dirty: 3, outgoingAdditions: 42, outgoingDeletions: 8 }],
        ]);

        expandProjects([README_PROJECT_PATH]);
        selectWorkspace(workspaces[0]);

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
          executeBash: createGitStatusExecutor(gitStatus),
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    // Wait for git status to render (fetched async via GitStatusStore polling)
    await waitFor(
      () => {
        const row = canvasElement.querySelector<HTMLElement>('[data-workspace-id="ws-diverged"]');
        if (!row) throw new Error("ws-diverged row not found");
        within(row).getByText("+12.3k");
      },
      { timeout: 10_000 }
    );

    const row = canvasElement.querySelector<HTMLElement>('[data-workspace-id="ws-diverged"]')!;
    const plus = within(row).getByText("+12.3k");

    // Hover to open tooltip
    await userEvent.hover(plus);

    const getVisibleTooltip = () =>
      document.body.querySelector<HTMLElement>('.bg-modal-bg[data-state="open"]');

    // Wait for tooltip (portaled) and toggle to commits mode
    await waitFor(
      () => {
        const tooltip = getVisibleTooltip();
        if (!tooltip) throw new Error("git status tooltip not visible");
        within(tooltip).getByText("Commits");
      },
      { timeout: 10_000 }
    );

    const tooltip = getVisibleTooltip()!;
    await userEvent.click(within(tooltip).getByText("Commits"));

    // Verify indicator switches to divergence view for the same workspace row
    await waitFor(
      () => {
        const updatedRow = canvasElement.querySelector<HTMLElement>(
          '[data-workspace-id="ws-diverged"]'
        );
        if (!updatedRow) throw new Error("ws-diverged row not found");
        within(updatedRow).getByText("↑3");
        within(updatedRow).getByText("↓2");
      },
      { timeout: 5_000 }
    );
  },
};

// README: docs/img/plan-mermaid.webp
export const PlanMermaidWithCosts: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-plan-with-costs";

        const workspace = createWorkspace({
          id: workspaceId,
          name: "feature/plan",
          projectName: README_PROJECT_NAME,
          projectPath: README_PROJECT_PATH,
        });

        window.localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("costs"));
        window.localStorage.setItem("costsTab:viewMode", JSON.stringify("session"));
        window.localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "420");
        window.localStorage.removeItem(getRightSidebarLayoutKey(workspaceId));

        expandProjects([README_PROJECT_PATH]);
        selectWorkspace(workspace);
        expandRightSidebar();

        const sessionUsage = new Map([[workspaceId, createMultiModelSessionUsage(1.84)]]);

        return createMockORPCClient({
          projects: groupWorkspacesByProject([workspace]),
          workspaces: [workspace],
          onChat: createOnChatAdapter(
            new Map([
              [
                workspaceId,
                createStaticChatHandler([
                  createUserMessage(
                    "msg-1",
                    "Plan out the storybook screenshot work — I need a diagram showing the order.",
                    {
                      historySequence: 1,
                      timestamp: STABLE_TIMESTAMP - 40_000,
                    }
                  ),
                  createAssistantMessage("msg-2", "Let me explore what we have first.", {
                    historySequence: 2,
                    timestamp: STABLE_TIMESTAMP - 30_000,
                    toolCalls: [
                      createBashTool(
                        "call-bash-1",
                        "ls src/browser/stories/*.stories.tsx",
                        "src/browser/stories/App.readmeScreenshots.stories.tsx\nsrc/browser/stories/ChatPane.stories.tsx\nsrc/browser/stories/Sidebar.stories.tsx"
                      ),
                    ],
                  }),
                  createAssistantMessage(
                    "msg-3",
                    "Here's a plan with an implementation order diagram.",
                    {
                      historySequence: 3,
                      timestamp: STABLE_TIMESTAMP - 20_000,
                      toolCalls: [
                        createProposePlanTool(
                          "call-plan-1",
                          `# README Screenshot Stories

## Goals

- Make each README screenshot reproducible via a named Storybook story
- Keep fixtures deterministic so Chromatic snapshots are stable

## Implementation

1. Add a dedicated story module under \`Docs/README Screenshots\`
2. Seed rich fixtures (multi-file diffs, multi-model costs, many workspaces)
3. Add a terminal mock that yields an initial \`screenState\`

\`\`\`mermaid
graph TD
  A[Create story module] --> B[Seed fixtures]
  B --> C[Add terminal screenState]
  C --> D[Verify in Chromatic]
\`\`\`

## Done when

- 8 stories exist (one per README image)
- Stories match screenshot composition + feel “lived in”`
                        ),
                      ],
                    }
                  ),
                  createUserMessage("msg-4", "Accepted. Start with the hero screenshot.", {
                    historySequence: 4,
                    timestamp: STABLE_TIMESTAMP - 10_000,
                  }),
                  createAssistantMessage("msg-5", "Starting implementation now.", {
                    historySequence: 5,
                    timestamp: STABLE_TIMESTAMP - 5_000,
                    toolCalls: [
                      createStatusTool("call-status-1", "📝", "Building ProductHero story"),
                    ],
                  }),
                ]),
              ],
            ])
          ),
          sessionUsage,
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for costs to load (fetched async via WorkspaceStore).
    await waitFor(
      () => {
        canvas.getByRole("tab", { name: /^costs/i });
        canvas.getByText(/cache create/i);
      },
      { timeout: 15_000 }
    );
  },
};

// README: docs/img/project-secrets.webp
// The secrets button is opacity-0 behind a Radix Tooltip wrapper, which conflicts
// with the headless test-runner. The capture script handles modal opening via
// Playwright, so we skip this story in test-storybook.
export const ProjectSecretsModal: AppStory = {
  tags: ["!test"],
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-secrets";

        const workspaces = [
          createWorkspace({
            id: workspaceId,
            name: "feature/secrets",
            projectName: README_PROJECT_NAME,
            projectPath: README_PROJECT_PATH,
          }),
        ];

        expandProjects([README_PROJECT_PATH]);
        selectWorkspace(workspaces[0]);

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
          projectSecrets: new Map([
            [
              README_PROJECT_PATH,
              [
                { key: "GITHUB_TOKEN", value: "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
                { key: "OPENAI_API_KEY", value: "sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
                { key: "ANTHROPIC_API_KEY", value: "sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
                { key: "SENTRY_DSN", value: "https://examplePublicKey@o0.ingest.sentry.io/0" },
              ],
            ],
          ]),
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    // NOTE: Opening the secrets modal requires clicking an opacity-0 button inside
    // a Radix Tooltip, which conflicts with the headless test runner (scroll lock +
    // pointer-events: none). The capture script handles the modal interaction directly
    // via Playwright. Here we just verify the sidebar rendered with the project row.
    await waitFor(
      () => {
        const row = canvasElement.querySelector<HTMLElement>(
          `[data-project-path="${README_PROJECT_PATH}"]`
        );
        if (!row) throw new Error("project row not found");
      },
      { timeout: 10_000 }
    );
  },
};

// README: docs/img/costs-tab.webp
export const CostsTabRich: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-costs-rich";

        const workspace = createWorkspace({
          id: workspaceId,
          name: "feature/costs",
          projectName: README_PROJECT_NAME,
          projectPath: README_PROJECT_PATH,
        });

        window.localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("costs"));
        window.localStorage.setItem("costsTab:viewMode", JSON.stringify("session"));
        window.localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "420");
        window.localStorage.removeItem(getRightSidebarLayoutKey(workspaceId));

        expandProjects([README_PROJECT_PATH]);
        selectWorkspace(workspace);
        expandRightSidebar();

        return createMockORPCClient({
          projects: groupWorkspacesByProject([workspace]),
          workspaces: [workspace],
          onChat: createOnChatAdapter(
            new Map([
              [
                workspaceId,
                createStaticChatHandler([
                  createUserMessage(
                    "msg-1",
                    "Refactor the session tracking to break down costs by model.",
                    {
                      historySequence: 1,
                      timestamp: STABLE_TIMESTAMP - 50_000,
                    }
                  ),
                  createAssistantMessage(
                    "msg-2",
                    "Reading the current cost tracking implementation.",
                    {
                      historySequence: 2,
                      timestamp: STABLE_TIMESTAMP - 40_000,
                      toolCalls: [
                        createFileReadTool(
                          "call-read-1",
                          "src/common/types/costs.ts",
                          "export interface SessionUsage {\n  totalCost: number;\n  breakdown: UsageLine[];\n}"
                        ),
                      ],
                    }
                  ),
                  createAssistantMessage(
                    "msg-3",
                    "Updated the type to include per-model breakdown.",
                    {
                      historySequence: 3,
                      timestamp: STABLE_TIMESTAMP - 30_000,
                      toolCalls: [
                        createFileEditTool(
                          "call-edit-1",
                          "src/common/types/costs.ts",
                          "@@ -5,3 +5,5 @@\n+  modelId: string;\n+  modelCost: number;"
                        ),
                      ],
                    }
                  ),
                  createAssistantMessage("msg-4", "Tests pass.", {
                    historySequence: 4,
                    timestamp: STABLE_TIMESTAMP - 20_000,
                    toolCalls: [
                      createBashTool("call-bash-1", "make test", "✓ 12 tests passed (2.1s)"),
                    ],
                  }),
                  createUserMessage("msg-5", "Ship it.", {
                    historySequence: 5,
                    timestamp: STABLE_TIMESTAMP - 10_000,
                  }),
                  createAssistantMessage("msg-6", "Done — PR opened.", {
                    historySequence: 6,
                    timestamp: STABLE_TIMESTAMP - 5_000,
                    toolCalls: [
                      createStatusTool(
                        "call-status-1",
                        "🚀",
                        "PR #427 opened",
                        "https://github.com/mux/mux/pull/427"
                      ),
                    ],
                  }),
                ]),
              ],
            ])
          ),
          sessionUsage: new Map([[workspaceId, createMultiModelSessionUsage(2.31)]]),
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Ensure the Costs tab is selected and has rendered rows.
    await waitFor(
      () => {
        canvas.getByRole("tab", { name: /^costs/i, selected: true });
        canvas.getByText(/cache create/i);
        canvas.getByText(/cache read/i);
      },
      { timeout: 15_000 }
    );
  },
};

// README: docs/img/opportunistic-compaction.webp
export const OpportunisticCompactionTooltip: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-compaction";

        const workspace = createWorkspace({
          id: workspaceId,
          name: "feature/compaction",
          projectName: README_PROJECT_NAME,
          projectPath: README_PROJECT_PATH,
        });

        window.localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("costs"));
        window.localStorage.setItem("costsTab:viewMode", JSON.stringify("session"));
        window.localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "420");
        window.localStorage.removeItem(getRightSidebarLayoutKey(workspaceId));

        expandProjects([README_PROJECT_PATH]);
        selectWorkspace(workspace);
        expandRightSidebar();

        return createMockORPCClient({
          projects: groupWorkspacesByProject([workspace]),
          workspaces: [workspace],
          onChat: createOnChatAdapter(
            new Map([
              [
                workspaceId,
                createStaticChatHandler([
                  createUserMessage(
                    "msg-1",
                    "We’ve been working for a while, can you clean up the context?",
                    {
                      historySequence: 1,
                      timestamp: STABLE_TIMESTAMP - 60_000,
                    }
                  ),
                  createAssistantMessage("msg-2", "Let me check the workspace state first.", {
                    historySequence: 2,
                    timestamp: STABLE_TIMESTAMP - 50_000,
                    toolCalls: [
                      createBashTool(
                        "call-bash-1",
                        "git status --short",
                        " M src/browser/stories/App.readmeScreenshots.stories.tsx\n M src/browser/stories/mockFactory.ts\n?? src/browser/stories/fixtures/"
                      ),
                    ],
                  }),
                  createAssistantMessage("msg-3", "I’ve committed the in-progress work.", {
                    historySequence: 3,
                    timestamp: STABLE_TIMESTAMP - 40_000,
                    toolCalls: [
                      createFileEditTool(
                        "call-edit-1",
                        "src/browser/stories/App.readmeScreenshots.stories.tsx",
                        "@@ -1,4 +1,6 @@\n+// Committed checkpoint: story fixtures seeded"
                      ),
                    ],
                  }),
                  createUserMessage("msg-4", "Good. Now compact — keep what matters.", {
                    historySequence: 4,
                    timestamp: STABLE_TIMESTAMP - 30_000,
                  }),
                  createAssistantMessage(
                    "msg-5",
                    "I’ll compact and preserve the key context: the storybook fixture patterns, the capture pipeline design, and the current PR state.",
                    {
                      historySequence: 5,
                      timestamp: STABLE_TIMESTAMP - 20_000,
                    }
                  ),
                  createAssistantMessage(
                    "msg-6",
                    "Replace all chat history with this message\n\n- Keep: README screenshot mapping + terminal mock plan\n- Drop: exploratory discussion\n- Next: run make storybook-build + test-storybook",
                    {
                      historySequence: 6,
                      timestamp: STABLE_TIMESTAMP - 10_000,
                    }
                  ),
                ]),
              ],
            ])
          ),
          sessionUsage: new Map([[workspaceId, createMultiModelSessionUsage(1.02)]]),
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Ensure Costs is visible (the screenshot shows costs + Start Here tooltip).
    await waitFor(
      () => {
        canvas.getByText(/cache create/i);
      },
      { timeout: 15_000 }
    );

    // Hover the Start Here button on the final assistant message.
    // Multiple assistant messages each have a "Start Here" button; grab the last one.
    const startHereButtons = await canvas.findAllByRole("button", { name: "Start Here" });
    const startHereButton = startHereButtons[startHereButtons.length - 1];
    await userEvent.hover(startHereButton);

    await waitFor(
      () => {
        within(document.body).getByText("Replace all chat history with this message");
      },
      { timeout: 10_000 }
    );

    await expect(within(document.body).getByText(/Replace all chat history/i)).toBeVisible();
  },
};
