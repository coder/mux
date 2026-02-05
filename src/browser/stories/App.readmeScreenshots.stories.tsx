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
  "mux-dev (exec mode)   ────────────────────────────────────────────────────────────────",
  "$ bun test",
  "",
  " PASS  tests/ui/sidebar.test.tsx",
  " PASS  tests/ui/rightSidebar.test.tsx",
  " PASS  tests/ui/chat.test.tsx",
  "",
  "Test Suites: 3 passed, 3 total",
  "Tests:       42 passed, 42 total",
  "Time:        4.21s",
  "",
  "$ make static-check",
  "…",
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
              createUserMessage("msg-1", "Make the README screenshots reproducible in Storybook.", {
                historySequence: 1,
                timestamp: STABLE_TIMESTAMP - 300_000,
              }),
              createAssistantMessage(
                "msg-2",
                "I'll add a dedicated story module with one story per README image. I'll also seed the right sidebar with a split Review + Terminal layout so the hero state looks lived-in.",
                {
                  historySequence: 2,
                  timestamp: STABLE_TIMESTAMP - 290_000,
                }
              ),
            ]),
          ],
        ]);

        // Make the sidebar look expanded/busy, matching the README hero composition.
        expandProjects([README_PROJECT_PATH, TERMINAL_BENCH_PROJECT_PATH]);
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

        window.localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("review"));
        window.localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "700");
        window.localStorage.removeItem(getRightSidebarLayoutKey(workspaceId));

        const client = createMockORPCClient({
          projects: groupWorkspacesByProject([workspace]),
          workspaces: [workspace],
          onChat: createOnChatAdapter(
            new Map([
              [
                workspaceId,
                createStaticChatHandler([
                  createUserMessage("msg-1", "Summarize the PR and highlight risky changes.", {
                    historySequence: 1,
                    timestamp: STABLE_TIMESTAMP - 120_000,
                  }),
                  createAssistantMessage(
                    "msg-2",
                    "PR summary: Adds layout helpers and improves WorkspaceShell composition. Risk: layout helpers affect sizing; verify they don't break small viewports.",
                    {
                      historySequence: 2,
                      timestamp: STABLE_TIMESTAMP - 110_000,
                    }
                  ),
                ]),
              ],
            ])
          ),
          executeBash: createGitStatusExecutor(
            new Map([[workspaceId, { dirty: 3 }]]),
            new Map([
              [
                workspaceId,
                {
                  diffOutput: SAMPLE_DIFF_OUTPUT,
                  numstatOutput: SAMPLE_NUMSTAT_OUTPUT,
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
export const GitStatusPopover: AppStory = {
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
                  createUserMessage("msg-1", "Draft a plan and include a diagram.", {
                    historySequence: 1,
                    timestamp: STABLE_TIMESTAMP - 200_000,
                  }),
                  createAssistantMessage(
                    "msg-2",
                    "Here's a plan with an implementation order diagram.",
                    {
                      historySequence: 2,
                      timestamp: STABLE_TIMESTAMP - 190_000,
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
export const ProjectSecretsModal: AppStory = {
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
    // The manage-secrets button is hidden (opacity-0) until the project row is hovered.
    const projectRow = canvasElement.querySelector<HTMLElement>(
      `[data-project-path="${README_PROJECT_PATH}"]`
    );
    if (!projectRow) {
      throw new Error("project row not found");
    }

    await userEvent.hover(projectRow);

    const manageSecretsButton = within(projectRow).getByRole("button", {
      name: new RegExp(`Manage secrets for ${README_PROJECT_NAME}`, "i"),
    });

    await userEvent.click(manageSecretsButton);

    await waitFor(
      () => {
        within(document.body).getByText(/Manage Secrets/i);
        within(document.body).getByText(/GITHUB_TOKEN/i);
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
                  createUserMessage("msg-1", "Show me where the money is going.", {
                    historySequence: 1,
                    timestamp: STABLE_TIMESTAMP - 60_000,
                  }),
                  createAssistantMessage(
                    "msg-2",
                    "Costs are tracked per session and per model. This run used a cached-heavy call (cache create) plus a smaller follow-up request.",
                    {
                      historySequence: 2,
                      timestamp: STABLE_TIMESTAMP - 55_000,
                      toolCalls: [
                        createStatusTool(
                          "call-1",
                          "📦",
                          "Costs tab updated with multi-model breakdown"
                        ),
                      ],
                    }
                  ),
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
                  createUserMessage("msg-1", "We’re near the context limit; compact if it helps.", {
                    historySequence: 1,
                    timestamp: STABLE_TIMESTAMP - 80_000,
                  }),
                  createAssistantMessage(
                    "msg-2",
                    "I can opportunistically compact now and keep a clean starting point for the rest of the work.",
                    {
                      historySequence: 2,
                      timestamp: STABLE_TIMESTAMP - 70_000,
                    }
                  ),
                  createAssistantMessage(
                    "msg-3",
                    "Replace all chat history with this message\n\n- Keep: README screenshot mapping + terminal mock plan\n- Drop: exploratory discussion\n- Next: run make storybook-build + test-storybook",
                    {
                      historySequence: 3,
                      timestamp: STABLE_TIMESTAMP - 60_000,
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
    const startHereButton = await canvas.findByRole("button", { name: "Start Here" });
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
