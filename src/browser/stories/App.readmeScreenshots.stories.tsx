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
import { createMockORPCClient, type MockSessionUsage } from "./mocks/orpc";
import {
  GIT_STATUS_INDICATOR_MODE_KEY,
  LEFT_SIDEBAR_COLLAPSED_KEY,
  RIGHT_SIDEBAR_TAB_KEY,
  RIGHT_SIDEBAR_WIDTH_KEY,
  getAgentIdKey,
  getModelKey,
  getProjectScopeId,
  getRightSidebarLayoutKey,
  getStatusStateKey,
  getThinkingLevelKey,
} from "@/common/constants/storage";

export default {
  ...appMeta,
  title: "Docs/README Screenshots",
  // README screenshot stories are validated by the dedicated Playwright capture script.
  // Skip Storybook interaction tests here to avoid portal/hover flake in cloud browsers.
  tags: ["!test"],
  decorators: [
    (Story: () => JSX.Element) => (
      <div style={{ width: 1900, height: "100dvh", position: "relative" }}>
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
        dark: { theme: "dark", viewport: 1900 },
      },
    },
  },
};

const README_PROJECT_NAME = "mux";
const README_PROJECT_PATH = "/home/user/projects/mux";

const IPHONE_17_PRO_MAX = {
  // Source: https://ios-resolution.info/ (logical resolution)
  width: 440,
  height: 956,
} as const;

function createMultiModelSessionUsage(totalUsd: number): MockSessionUsage {
  // Split cost into model rows to make the Costs tab look realistic (cached + cacheCreate present).
  const primary = totalUsd * 0.62;
  const secondary = totalUsd * 0.26;
  const tertiary = totalUsd * 0.12;

  const modelA = "anthropic:claude-sonnet-4-20250514";
  const modelB = "openai:gpt-4.1-mini";
  const modelC = "google:gemini-2.5-flash";

  return {
    byModel: {
      [modelA]: {
        input: { tokens: 180_000, cost_usd: primary * 0.55 },
        cached: { tokens: 640_000, cost_usd: primary * 0.1 },
        cacheCreate: { tokens: 320_000, cost_usd: primary * 0.21 },
        output: { tokens: 42_000, cost_usd: primary * 0.11 },
        reasoning: { tokens: 9_000, cost_usd: primary * 0.03 },
        model: modelA,
      },
      [modelB]: {
        input: { tokens: 58_000, cost_usd: secondary * 0.6 },
        cached: { tokens: 110_000, cost_usd: secondary * 0.08 },
        cacheCreate: { tokens: 48_000, cost_usd: secondary * 0.12 },
        output: { tokens: 13_500, cost_usd: secondary * 0.2 },
        reasoning: { tokens: 0, cost_usd: 0 },
        model: modelB,
      },
      [modelC]: {
        input: { tokens: 16_000, cost_usd: tertiary * 0.62 },
        cached: { tokens: 24_000, cost_usd: tertiary * 0.08 },
        cacheCreate: { tokens: 8_000, cost_usd: tertiary * 0.1 },
        output: { tokens: 4_200, cost_usd: tertiary * 0.2 },
        reasoning: { tokens: 0, cost_usd: 0 },
        model: modelC,
      },
    },
    lastRequest: {
      model: modelA,
      usage: {
        input: { tokens: 24_000, cost_usd: 0.07 },
        cached: { tokens: 8_500, cost_usd: 0.002 },
        cacheCreate: { tokens: 0, cost_usd: 0 },
        output: { tokens: 5_400, cost_usd: 0.02 },
        reasoning: { tokens: 0, cost_usd: 0 },
        model: modelA,
      },
      timestamp: 0,
    },
    version: 1,
  };
}

function createReadmeGitDivergenceExecutor(gitStatus: Map<string, GitStatusFixture>) {
  const baseExecutor = createGitStatusExecutor(gitStatus);

  const buildBranchDetailsOutput = (status: GitStatusFixture): string => {
    const ahead = status.ahead ?? 0;
    const behind = status.behind ?? 0;
    const dirtyCount = status.dirty ?? 0;
    const headCommit = status.headCommit ?? "refactor(db): split migration planner from executor";
    const originCommit = status.originCommit ?? "fix(db): rollback after partial apply";

    let hashIndex = 0;
    const nextHash = () => {
      hashIndex++;
      return hashIndex.toString(16).padStart(7, "0");
    };

    const localSummaries = [
      "refactor(db): split migration planner from executor",
      "perf(db): cache schema snapshots during migration planning",
      "fix(db): keep lock handle alive while dry-run checks execute",
      "feat(db): add migration preview summary for review mode",
      "chore(db): collapse duplicate migration warning paths",
      "test(db): add coverage for conflicting column drops",
    ];
    const originSummaries = [
      "fix(db): rollback after partial apply",
      "feat(metrics): emit advisory lock wait timing",
      "refactor(ci): run migration smoke tests post-merge",
      "docs(db): add zero-downtime migration checklist",
      "fix(db): preserve default values in enum backfills",
      "chore(db): update migration template comments",
    ];
    const sharedSummaries = [
      "merge-base: stabilize migration state machine",
      "feat(db): add explicit transaction boundaries",
      "fix(db): guard against stale migration snapshots",
      "refactor(db): isolate schema diff serialization",
      "test(db): assert lock release on interrupt",
      "docs(db): clarify manual recovery steps",
      "chore(db): normalize migration log formatting",
      "perf(db): avoid redundant query planner warmups",
    ];

    const showBranchLines: string[] = [
      `! [HEAD] ${headCommit}`,
      ` ! [origin/main] ${originCommit}`,
      "--",
    ];
    const commitHashes: string[] = [];

    for (let i = 0; i < ahead; i++) {
      const hash = nextHash();
      commitHashes.push(hash);
      const summary = localSummaries[i] ?? `local commit ${i + 1}`;
      showBranchLines.push(`+  [${hash}] ${summary}`);
    }

    for (let i = 0; i < behind; i++) {
      const hash = nextHash();
      commitHashes.push(hash);
      const summary = originSummaries[i] ?? `origin commit ${i + 1}`;
      showBranchLines.push(` + [${hash}] ${summary}`);
    }

    const sharedCount = Math.max(5, Math.min(8, ahead + behind + 1));
    for (let i = 0; i < sharedCount; i++) {
      const hash = nextHash();
      commitHashes.push(hash);
      const summary = sharedSummaries[i] ?? `shared commit ${i + 1}`;
      showBranchLines.push(`++ [${hash}] ${summary}`);
    }

    const dates = commitHashes
      .map(
        (hash, index) =>
          `${hash}|Nov 14 ${String((index % 11) + 1).padStart(2, "0")}:${String((index % 6) * 10).padStart(2, "0")} PM`
      )
      .join("\n");

    const dirtyFileCandidates = [
      " M src/node/services/migrations/runner.ts",
      " M src/node/services/migrations/planner.ts",
      " M src/node/services/migrations/lock.ts",
      " M src/common/utils/migrations/formatDiff.ts",
      " M tests/ipc/migrations.integration.test.ts",
      "?? docs/migrations/rollback-playbook.md",
    ];
    const dirtyFiles =
      dirtyCount > 0
        ? dirtyFileCandidates
            .slice(0, Math.max(2, Math.min(dirtyCount + 1, dirtyFileCandidates.length)))
            .join("\n")
        : "";

    return [
      "__MUX_BRANCH_DATA__BEGIN_SHOW_BRANCH__",
      showBranchLines.join("\n"),
      "__MUX_BRANCH_DATA__END_SHOW_BRANCH__",
      "__MUX_BRANCH_DATA__BEGIN_DATES__",
      dates,
      "__MUX_BRANCH_DATA__END_DATES__",
      "__MUX_BRANCH_DATA__BEGIN_DIRTY_FILES__",
      dirtyFiles,
      "__MUX_BRANCH_DATA__END_DIRTY_FILES__",
    ].join("\n");
  };

  return (workspaceId: string, script: string) => {
    if (script.includes("__MUX_BRANCH_DATA__BEGIN_SHOW_BRANCH__")) {
      const output = buildBranchDetailsOutput(gitStatus.get(workspaceId) ?? {});
      return Promise.resolve({ success: true as const, output, exitCode: 0, wall_duration_ms: 50 });
    }

    return baseExecutor(workspaceId, script);
  };
}

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

        // 50/50 split: 950px review pane out of 1900px viewport.
        window.localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("review"));
        window.localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "950");
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
};

// README: docs/img/agent-status.webp
// This story keeps the left sidebar expanded and seeds varied status_set tool calls
// so workspace rows show realistic in-progress agent activity.
export const AgentStatusSidebar: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        // This screenshot should explicitly show the expanded projects sidebar.
        window.localStorage.setItem(LEFT_SIDEBAR_COLLAPSED_KEY, JSON.stringify(false));

        const workspaceFixtures = [
          {
            id: "ws-status-1",
            name: "feature/docs",
            assistantText:
              "Capture run is active. I widened the viewport and I am checking the git divergence + agent status stories for regressions.",
            statusEmoji: "🔍",
            statusMessage: "Comparing refreshed screenshots",
            statusUrl: "https://github.com/coder/mux/pull/2035",
          },
          {
            id: "ws-status-2",
            name: "feature/sidebar",
            assistantText: "Profiling workspace row rendering and hover interactions.",
            statusEmoji: "🔍",
            statusMessage: "Profiling sidebar rendering",
          },
          {
            id: "ws-status-3",
            name: "bugfix/stream",
            assistantText: "Collecting crash traces from interrupted stream retries.",
            statusEmoji: "🔍",
            statusMessage: "Reading stream crash logs",
          },
          {
            id: "ws-status-4",
            name: "feature/auth",
            assistantText: "Wiring shared auth checks into task launch paths.",
            statusEmoji: "🔧",
            statusMessage: "Implementing auth middleware",
          },
          {
            id: "ws-status-5",
            name: "tests/sidebar-regression",
            assistantText: "Expanding status indicator coverage with visual assertions.",
            statusEmoji: "🧪",
            statusMessage: "Running sidebar regression tests",
          },
          {
            id: "ws-status-ssh",
            name: "deploy/prod",
            runtime: "ssh" as const,
            host: "prod.example.com",
            assistantText: "Deploying staged patch to production canary nodes.",
            statusEmoji: "⏳",
            statusMessage: "Waiting for deploy health checks",
          },
          {
            id: "ws-status-6",
            name: "feature/web-research",
            assistantText: "Comparing provider docs for tool schema strictness changes.",
            statusEmoji: "🔍",
            statusMessage: "Searching web for API notes",
          },
          {
            id: "ws-status-7",
            name: "release/v1.0.0",
            assistantText: "Preparing release summary for this screenshot refresh.",
            statusEmoji: "📝",
            statusMessage: "Drafting release notes",
          },
          {
            id: "ws-status-8",
            name: "chore/static-check",
            assistantText: "Running formatter + static checks before posting updates.",
            statusEmoji: "🧪",
            statusMessage: "Running make static-check",
          },
          {
            id: "ws-status-9",
            name: "feature/costs-tab",
            assistantText: "Comparing token breakdown rows across models.",
            statusEmoji: "🔄",
            statusMessage: "Refreshing costs snapshots",
          },
          {
            id: "ws-status-10",
            name: "docs/readme",
            assistantText: "Regenerating docs assets and linking updated images.",
            statusEmoji: "📝",
            statusMessage: "Updating README screenshots",
          },
          {
            id: "ws-status-11",
            name: "refactor/task-runner",
            assistantText: "Splitting task lifecycle updates into smaller reducers.",
            statusEmoji: "🔧",
            statusMessage: "Refactoring task status flow",
          },
          {
            id: "ws-status-12",
            name: "main",
            assistantText: "Monitoring queue health while waiting for follow-up tasks.",
            statusEmoji: "⏳",
            statusMessage: "Waiting for next screenshot task",
          },
        ];

        // Seed persisted statusState for every workspace so the sidebar can show
        // many status examples without requiring each workspace's onChat stream
        // to be actively subscribed.
        for (const fixture of workspaceFixtures) {
          window.localStorage.setItem(
            getStatusStateKey(fixture.id),
            JSON.stringify({
              emoji: fixture.statusEmoji,
              message: fixture.statusMessage,
              ...(fixture.statusUrl ? { url: fixture.statusUrl } : {}),
            })
          );
        }

        const workspaces = workspaceFixtures.map((fixture, index) => {
          const createdAt = new Date(NOW - (index + 1) * 60_000).toISOString();
          if (fixture.runtime === "ssh") {
            return createSSHWorkspace({
              id: fixture.id,
              name: fixture.name,
              projectName: README_PROJECT_NAME,
              projectPath: README_PROJECT_PATH,
              host: fixture.host,
              createdAt,
            });
          }
          return createWorkspace({
            id: fixture.id,
            name: fixture.name,
            projectName: README_PROJECT_NAME,
            projectPath: README_PROJECT_PATH,
            createdAt,
          });
        });

        const primaryWorkspace = workspaceFixtures[0];

        const chatHandlers = new Map([
          [
            primaryWorkspace.id,
            createStaticChatHandler([
              createUserMessage(
                "msg-1",
                "Chromatic flagged Docs/README Screenshots differences. Can you regenerate the images and verify the sidebar + git divergence stories?",
                {
                  historySequence: 1,
                  timestamp: STABLE_TIMESTAMP - 120_000,
                }
              ),
              createAssistantMessage("msg-2", "On it. I am reproducing the visual diffs now.", {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 110_000,
                toolCalls: [
                  createStatusTool(
                    "call-1",
                    "🔧",
                    "Regenerating README screenshots and validating Chromatic diffs",
                    primaryWorkspace.statusUrl
                  ),
                ],
              }),
              createAssistantMessage("msg-3", primaryWorkspace.assistantText, {
                historySequence: 3,
                timestamp: STABLE_TIMESTAMP - 100_000,
                toolCalls: [
                  createStatusTool(
                    "call-2",
                    primaryWorkspace.statusEmoji,
                    primaryWorkspace.statusMessage,
                    primaryWorkspace.statusUrl
                  ),
                ],
              }),
            ]),
          ],
          ...workspaceFixtures.slice(1).map((fixture, index) => {
            return [
              fixture.id,
              createStaticChatHandler([
                createAssistantMessage("msg-1", fixture.assistantText, {
                  historySequence: 1,
                  timestamp: STABLE_TIMESTAMP - (95_000 - index * 4_000),
                  toolCalls: [
                    createStatusTool(
                      "call-1",
                      fixture.statusEmoji,
                      fixture.statusMessage,
                      fixture.statusUrl
                    ),
                  ],
                }),
              ]),
            ] as const;
          }),
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
// Git divergence details now open in a dialog (not hover tooltip). The capture
// script opens the dialog and switches modes to keep README output deterministic.
export const GitStatusPopover: AppStory = {
  tags: ["!test"],
  render: () => (
    <AppWithMocks
      setup={() => {
        window.localStorage.setItem(GIT_STATUS_INDICATOR_MODE_KEY, JSON.stringify("line-delta"));
        window.localStorage.setItem(LEFT_SIDEBAR_COLLAPSED_KEY, JSON.stringify(false));

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
            {
              ahead: 3,
              behind: 2,
              dirty: 5,
              outgoingAdditions: 12_313,
              outgoingDeletions: 1_231,
              headCommit: "refactor(db): split migration planner from executor",
              originCommit: "fix(db): rollback after partial apply",
            },
          ],
          ["ws-dirty", { dirty: 3, outgoingAdditions: 42, outgoingDeletions: 8 }],
        ]);

        const remoteLog = `* 4fb13bc (origin/main) fix(db): rollback after partial apply
* d0a9a44 feat(metrics): emit advisory lock wait timing
* b4f71de refactor(ci): run migration smoke tests post-merge
* 7e3ab22 docs(db): add zero-downtime migration checklist
* 331af90 fix(db): preserve default values in enum backfills
* 21db5cb chore(db): update migration template comments
* 09cc2ad perf(db): speed up migration status snapshots`;

        const localLog = `* e8b2f47 (HEAD -> refactor/db) refactor(db): split migration planner from executor
* c49dbf1 perf(db): cache schema snapshots during migration planning
* a1f27de fix(db): keep lock handle alive while dry-run checks execute
* 8e6c12b feat(db): add migration preview summary for review mode
* 7a97ed5 chore(db): collapse duplicate migration warning paths
* 5c1130d test(db): add coverage for conflicting column drops
* 2dbf2a1 refactor(db): isolate schema diff serialization
* 0f44a89 docs(db): clarify manual recovery steps`;

        const chatHandlers = new Map([
          [
            "ws-diverged",
            createStaticChatHandler([
              createUserMessage(
                "msg-1",
                "Can you investigate why refactor/db diverged from origin/main and tell me whether we should rebase or merge?",
                {
                  historySequence: 1,
                  timestamp: STABLE_TIMESTAMP - 140_000,
                }
              ),
              createAssistantMessage("msg-2", "Checking branch divergence now.", {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 130_000,
                toolCalls: [
                  createStatusTool(
                    "call-status-1",
                    "🔍",
                    "Inspecting local vs origin commits to prepare a safe rebase plan"
                  ),
                ],
              }),
              createAssistantMessage("msg-3", "Fetched latest remote refs.", {
                historySequence: 3,
                timestamp: STABLE_TIMESTAMP - 120_000,
                toolCalls: [
                  createBashTool(
                    "call-bash-1",
                    "git fetch --prune origin",
                    "From github.com:coder/mux\n   18f2a3d..4fb13bc  main       -> origin/main"
                  ),
                ],
              }),
              createAssistantMessage("msg-4", "Remote-only commits:", {
                historySequence: 4,
                timestamp: STABLE_TIMESTAMP - 110_000,
                toolCalls: [
                  createBashTool(
                    "call-bash-2",
                    "git log --graph --oneline --decorate HEAD..origin/main",
                    remoteLog
                  ),
                ],
              }),
              createAssistantMessage("msg-5", "Local-only commits:", {
                historySequence: 5,
                timestamp: STABLE_TIMESTAMP - 100_000,
                toolCalls: [
                  createBashTool(
                    "call-bash-3",
                    "git log --graph --oneline --decorate origin/main..HEAD",
                    localLog
                  ),
                ],
              }),
              createAssistantMessage("msg-6", "Dirty working tree summary:", {
                historySequence: 6,
                timestamp: STABLE_TIMESTAMP - 90_000,
                toolCalls: [
                  createBashTool(
                    "call-bash-4",
                    "git status --short",
                    " M src/node/services/migrations/runner.ts\n M src/node/services/migrations/planner.ts\n M src/node/services/migrations/lock.ts\n M src/common/utils/migrations/formatDiff.ts\n M tests/ipc/migrations.integration.test.ts\n?? docs/migrations/rollback-playbook.md"
                  ),
                ],
              }),
              createAssistantMessage(
                "msg-7",
                "Recommendation: stash dirty files, rebase refactor/db onto origin/main, resolve migration planner conflicts, then replay local commits in order.",
                {
                  historySequence: 7,
                  timestamp: STABLE_TIMESTAMP - 80_000,
                }
              ),
            ]),
          ],
        ]);

        expandProjects([README_PROJECT_PATH]);
        selectWorkspace(workspaces[1]);
        collapseRightSidebar();

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
          onChat: createOnChatAdapter(chatHandlers),
          executeBash: createReadmeGitDivergenceExecutor(gitStatus),
        });
      }}
    />
  ),
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
        window.localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "500");
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
                      createStatusTool("call-status-1", "📝", "Building README screenshot stories"),
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
};

// README: docs/img/auto-mode.webp
// Zoomed-in creation view that highlights project-scoped defaults before first send:
// Auto agent mode, Claude Opus 4.6, and MAX thinking.
export const AutoModeAgentSwitching: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const projectScopeId = getProjectScopeId(README_PROJECT_PATH);

        // Seed creation-mode controls so the screenshot shows the exact requested defaults.
        window.localStorage.setItem(getAgentIdKey(projectScopeId), JSON.stringify("orchestrator"));
        window.localStorage.setItem(
          getModelKey(projectScopeId),
          JSON.stringify("anthropic:claude-opus-4-6")
        );
        window.localStorage.setItem(getThinkingLevelKey(projectScopeId), JSON.stringify("xhigh"));

        expandProjects([README_PROJECT_PATH]);
        collapseRightSidebar();

        return createMockORPCClient({
          projects: new Map([[README_PROJECT_PATH, { workspaces: [] }]]),
          workspaces: [],
          agentDefinitions: [
            {
              id: "exec",
              scope: "built-in",
              name: "Exec",
              description: "Implement changes in the repository",
              uiSelectable: true,
              subagentRunnable: true,
              uiColor: "var(--color-exec-mode)",
            },
            {
              id: "plan",
              scope: "built-in",
              name: "Plan",
              description: "Create a plan before coding",
              uiSelectable: true,
              subagentRunnable: false,
              base: "plan",
              uiColor: "var(--color-plan-mode)",
            },
            {
              id: "ask",
              scope: "built-in",
              name: "Ask",
              description: "Delegate questions to Explore sub-agents and synthesize an answer.",
              uiSelectable: true,
              subagentRunnable: false,
              base: "exec",
              uiColor: "var(--color-ask-mode)",
            },
            {
              id: "orchestrator",
              scope: "built-in",
              name: "Auto",
              description: "Intelligently switch agent types to provide the best results.",
              uiSelectable: true,
              subagentRunnable: false,
              base: "exec",
              uiColor: "var(--color-auto-mode)",
            },
            {
              id: "compact",
              scope: "built-in",
              name: "Compact",
              description: "History compaction (internal)",
              uiSelectable: false,
              subagentRunnable: false,
            },
            {
              id: "explore",
              scope: "built-in",
              name: "Explore",
              description: "Read-only repository exploration",
              uiSelectable: false,
              subagentRunnable: true,
              base: "exec",
            },
            {
              id: "mux",
              scope: "built-in",
              name: "Mux",
              description: "Configure mux global behavior (system workspace)",
              uiSelectable: false,
              subagentRunnable: false,
            },
          ],
        });
      }}
    />
  ),
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
        window.localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "500");
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
};

// README: docs/img/context-management.webp
// Show the compaction/context management dialog opened from the context usage control.
export const ContextManagementDialog: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-context-management";

        const workspace = createWorkspace({
          id: workspaceId,
          name: "feature/context-management",
          projectName: README_PROJECT_NAME,
          projectPath: README_PROJECT_PATH,
        });

        expandProjects([README_PROJECT_PATH]);
        selectWorkspace(workspace);
        collapseRightSidebar();

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
                    "Can you tune our compaction setup so context stays healthy during long sessions?",
                    {
                      historySequence: 1,
                      timestamp: STABLE_TIMESTAMP - 60_000,
                    }
                  ),
                  createAssistantMessage(
                    "msg-2",
                    "Absolutely — I’ll review current usage and adjust compaction thresholds.",
                    {
                      historySequence: 2,
                      timestamp: STABLE_TIMESTAMP - 45_000,
                      contextUsage: {
                        inputTokens: 112_000,
                        outputTokens: 6_000,
                        totalTokens: 118_000,
                      },
                      toolCalls: [
                        createStatusTool(
                          "call-status-1",
                          "🔧",
                          "Reviewing context usage and idle compaction settings"
                        ),
                      ],
                    }
                  ),
                  createAssistantMessage(
                    "msg-3",
                    "Usage is nearing the threshold. Open compaction settings to tune the usage slider and idle timer before the next request.",
                    {
                      historySequence: 3,
                      timestamp: STABLE_TIMESTAMP - 30_000,
                      contextUsage: {
                        inputTokens: 129_000,
                        outputTokens: 3_200,
                        totalTokens: 132_200,
                      },
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
};

// README: docs/img/mobile-server-mode.webp
// iPhone 17 Pro Max-sized workspace view to document server-mode responsiveness.
export const MobileServerMode: AppStory = {
  decorators: [
    (Story: () => JSX.Element) => (
      <div
        style={{
          width: IPHONE_17_PRO_MAX.width,
          height: IPHONE_17_PRO_MAX.height,
          overflow: "hidden",
          position: "relative",
        }}
      >
        <Story />
      </div>
    ),
  ],
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-mobile-server";

        const workspace = createWorkspace({
          id: workspaceId,
          name: "feature/mobile-server",
          projectName: README_PROJECT_NAME,
          projectPath: README_PROJECT_PATH,
        });

        window.localStorage.setItem(LEFT_SIDEBAR_COLLAPSED_KEY, JSON.stringify(true));
        expandProjects([README_PROJECT_PATH]);
        selectWorkspace(workspace);
        collapseRightSidebar();

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
                    "Can I use mux server mode from my phone when I’m away from my laptop?",
                    {
                      historySequence: 1,
                      timestamp: STABLE_TIMESTAMP - 45_000,
                    }
                  ),
                  createAssistantMessage(
                    "msg-2",
                    "Yes — the workspace UI is responsive, so you can review progress and continue chats from mobile browsers.",
                    {
                      historySequence: 2,
                      timestamp: STABLE_TIMESTAMP - 30_000,
                      toolCalls: [
                        createStatusTool(
                          "call-status-1",
                          "🔧",
                          "Adapting the layout for mobile-sized viewport constraints"
                        ),
                      ],
                    }
                  ),
                  createAssistantMessage(
                    "msg-3",
                    "I kept controls compact so model, mode, and send actions remain accessible on narrow screens.",
                    {
                      historySequence: 3,
                      timestamp: STABLE_TIMESTAMP - 15_000,
                    }
                  ),
                ]),
              ],
            ])
          ),
        });
      }}
    />
  ),
};

// README: docs/img/orchestrate-agents.webp
// Parent workspace is selected in plan mode while six running child workspaces
// show nested status indicators in the expanded left sidebar.
export const OrchestrateAgents: AppStory = {
  // Override the module-level 1900px decorator so the app itself renders at 1200px,
  // matching the narrower capture viewport for a tighter orchestrator screenshot.
  decorators: [
    (Story: () => JSX.Element) => (
      <div style={{ width: 1200, height: "100dvh", position: "relative" }}>
        <Story />
      </div>
    ),
  ],
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-orchestrator";

        const parentWorkspace = createWorkspace({
          id: workspaceId,
          name: "feature/parallel-auth",
          projectName: README_PROJECT_NAME,
          projectPath: README_PROJECT_PATH,
        });

        const subtaskFixtures = [
          {
            id: "ws-sub-1",
            name: "auth-middleware",
            agentType: "exec" as const,
            title: "Implement auth middleware",
            statusEmoji: "🔧",
            statusMessage: "Implementing auth middleware",
            assistantMessage: "Wiring auth middleware into each service entrypoint.",
          },
          {
            id: "ws-sub-2",
            name: "token-service",
            agentType: "exec" as const,
            title: "Build token refresh service",
            statusEmoji: "🔍",
            statusMessage: "Reading token validation logic",
            assistantMessage: "Auditing refresh token validation before implementing rotation.",
          },
          {
            id: "ws-sub-3",
            name: "rbac-policies",
            agentType: "exec" as const,
            title: "Add RBAC policy engine",
            statusEmoji: "📝",
            statusMessage: "Writing policy evaluation tests",
            assistantMessage: "Building RBAC fixtures and policy matching assertions.",
          },
          {
            id: "ws-sub-4",
            name: "session-store",
            agentType: "exec" as const,
            title: "Migrate session storage to Redis",
            statusEmoji: "🚀",
            statusMessage: "Running integration tests",
            assistantMessage: "Running Redis-backed session integration coverage now.",
          },
          {
            id: "ws-sub-5",
            name: "api-gateway",
            agentType: "exec" as const,
            title: "Configure API gateway routes",
            statusEmoji: "🔧",
            statusMessage: "Wiring up rate limiting",
            assistantMessage: "Updating gateway route config with auth + throttling guards.",
          },
          {
            id: "ws-sub-6",
            name: "audit-logging",
            agentType: "explore" as const,
            title: "Investigate audit log schema",
            statusEmoji: "🔍",
            statusMessage: "Reviewing existing log entries",
            assistantMessage: "Inspecting current audit log rows to document schema constraints.",
          },
        ];

        const childWorkspaces = subtaskFixtures.map((fixture, index) => ({
          ...createWorkspace({
            id: fixture.id,
            name: fixture.name,
            projectName: README_PROJECT_NAME,
            projectPath: README_PROJECT_PATH,
            createdAt: new Date(NOW - (index + 1) * 2_000).toISOString(),
          }),
          parentWorkspaceId: workspaceId,
          agentType: fixture.agentType,
          taskStatus: "running" as const,
          title: fixture.title,
        }));

        const workspaces = [parentWorkspace, ...childWorkspaces];

        window.localStorage.setItem(LEFT_SIDEBAR_COLLAPSED_KEY, JSON.stringify(false));
        expandProjects([README_PROJECT_PATH]);
        selectWorkspace(parentWorkspace);
        collapseRightSidebar();

        const parentPlanMarkdown = `# Feature: Parallel Auth Orchestration

## Overview
Implement shared authentication across middleware, token refresh, RBAC policy checks, and audit logging.

## Tasks

### Task 1: Middleware integration
Implement shared auth middleware in every HTTP and RPC service boundary.

### Task 2: Token refresh service
Build refresh-token rotation with revocation checks and expiry validation.

### Task 3: RBAC policy engine
Add role-based policy evaluation with test coverage for allow/deny rules.

### Task 4: Session storage migration
Move session persistence from local files to Redis-backed storage.

### Task 5: API gateway route updates
Configure gateway auth guards, rate limits, and protected route wiring.

### Task 6: Audit logging baseline
Document and validate audit log schema requirements before rollout.
`;

        const chatHandlers = new Map<string, ReturnType<typeof createStaticChatHandler>>([
          [
            workspaceId,
            createStaticChatHandler([
              createUserMessage(
                "msg-orchestrator-1",
                "Implement auth across all services and split the work so multiple agents can run in parallel.",
                {
                  historySequence: 1,
                  timestamp: STABLE_TIMESTAMP - 60_000,
                }
              ),
              createAssistantMessage(
                "msg-orchestrator-2",
                "Here is a six-task execution plan. Start the orchestrator to launch subtasks.",
                {
                  historySequence: 2,
                  timestamp: STABLE_TIMESTAMP - 50_000,
                  toolCalls: [
                    createProposePlanTool("call-plan-orchestrator-1", parentPlanMarkdown),
                  ],
                }
              ),
            ]),
          ],
          ...subtaskFixtures.map(
            (fixture, index) =>
              [
                fixture.id,
                createStaticChatHandler([
                  createAssistantMessage(`msg-sub-${index + 1}`, fixture.assistantMessage, {
                    historySequence: 1,
                    timestamp: STABLE_TIMESTAMP - 45_000 + index * 1_000,
                    toolCalls: [
                      createStatusTool(
                        `call-status-sub-${index + 1}`,
                        fixture.statusEmoji,
                        fixture.statusMessage
                      ),
                    ],
                  }),
                ]),
              ] as const
          ),
        ]);

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
          onChat: createOnChatAdapter(chatHandlers),
        });
      }}
    />
  ),
};
