/**
 * PR link badge and links dropdown stories
 *
 * Shows various PR status states in the workspace header.
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import {
  NOW,
  STABLE_TIMESTAMP,
  createWorkspace,
  createUserMessage,
  createAssistantMessage,
  createStaticChatHandler,
  groupWorkspacesByProject,
} from "./mockFactory";
import { createOnChatAdapter, selectWorkspace as selectWorkspaceHelper } from "./storyHelpers";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";

export default {
  ...appMeta,
  title: "App/Links",
};

/**
 * PR status fixture for mocking gh pr view output
 */
interface PRStatusFixture {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus:
    | "CLEAN"
    | "BLOCKED"
    | "BEHIND"
    | "DIRTY"
    | "UNSTABLE"
    | "HAS_HOOKS"
    | "DRAFT"
    | "UNKNOWN";
  title: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  statusCheckRollup?: Array<{ status?: string; conclusion?: string | null }>;
}

/**
 * Creates an executeBash function that returns PR status for gh pr view commands.
 */
function createPRStatusExecutor(prStatuses: Map<string, PRStatusFixture | "no_pr" | "error">) {
  return (workspaceId: string, script: string) => {
    // Handle gh pr view commands
    if (script.includes("gh pr view")) {
      const status = prStatuses.get(workspaceId);

      if (!status || status === "error") {
        return Promise.resolve({
          success: true as const,
          output: '{"no_pr":true}',
          exitCode: 0,
          wall_duration_ms: 50,
        });
      }

      if (status === "no_pr") {
        return Promise.resolve({
          success: true as const,
          output: '{"no_pr":true}',
          exitCode: 0,
          wall_duration_ms: 50,
        });
      }

      return Promise.resolve({
        success: true as const,
        output: JSON.stringify(status),
        exitCode: 0,
        wall_duration_ms: 50,
      });
    }

    // Default: return empty success
    return Promise.resolve({
      success: true as const,
      output: "",
      exitCode: 0,
      wall_duration_ms: 50,
    });
  };
}

/**
 * Shows all PR status badge variants:
 * - Ready to merge (green checkmark)
 * - Checks pending (yellow)
 * - Checks failing (red)
 * - Behind base branch (yellow)
 * - Draft PR (muted)
 * - Merged (purple)
 * - Closed (red)
 * - No PR for branch
 */
export const PRStatusBadges: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaces = [
          // Ready to merge
          createWorkspace({
            id: "ws-ready",
            name: "feature/ready-to-merge",
            projectName: "my-app",
            createdAt: new Date(NOW - 3600000).toISOString(),
          }),
          // Checks pending
          createWorkspace({
            id: "ws-blocked",
            name: "feature/checks-pending",
            projectName: "my-app",
            createdAt: new Date(NOW - 7200000).toISOString(),
          }),
          // Checks failing
          createWorkspace({
            id: "ws-failed-checks",
            name: "feature/checks-failing",
            projectName: "my-app",
            createdAt: new Date(NOW - 9000000).toISOString(),
          }),
          // Behind base branch
          createWorkspace({
            id: "ws-behind",
            name: "feature/needs-rebase",
            projectName: "my-app",
            createdAt: new Date(NOW - 10800000).toISOString(),
          }),
          // Has conflicts
          createWorkspace({
            id: "ws-conflicts",
            name: "feature/has-conflicts",
            projectName: "my-app",
            createdAt: new Date(NOW - 14400000).toISOString(),
          }),
          // Draft PR
          createWorkspace({
            id: "ws-draft",
            name: "feature/work-in-progress",
            projectName: "my-app",
            createdAt: new Date(NOW - 18000000).toISOString(),
          }),
          // Merged
          createWorkspace({
            id: "ws-merged",
            name: "feature/already-merged",
            projectName: "my-app",
            createdAt: new Date(NOW - 21600000).toISOString(),
          }),
          // Closed
          createWorkspace({
            id: "ws-closed",
            name: "feature/abandoned",
            projectName: "my-app",
            createdAt: new Date(NOW - 25200000).toISOString(),
          }),
          // No PR
          createWorkspace({
            id: "ws-no-pr",
            name: "main",
            projectName: "my-app",
            createdAt: new Date(NOW - 28800000).toISOString(),
          }),
        ];

        const prStatuses = new Map<string, PRStatusFixture | "no_pr">([
          [
            "ws-ready",
            {
              number: 1623,
              url: "https://github.com/coder/mux/pull/1623",
              state: "OPEN",
              mergeable: "MERGEABLE",
              mergeStateStatus: "CLEAN",
              title: "feat: add first-class link support",
              isDraft: false,
              headRefName: "feature/ready-to-merge",
              baseRefName: "main",
            },
          ],
          [
            "ws-blocked",
            {
              number: 1624,
              url: "https://github.com/coder/mux/pull/1624",
              state: "OPEN",
              mergeable: "MERGEABLE",
              mergeStateStatus: "BLOCKED",
              title: "fix: resolve flaky test",
              isDraft: false,
              headRefName: "feature/checks-pending",
              baseRefName: "main",
              statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: null }],
            },
          ],
          [
            "ws-failed-checks",
            {
              number: 1628,
              url: "https://github.com/coder/mux/pull/1628",
              state: "OPEN",
              mergeable: "MERGEABLE",
              mergeStateStatus: "BLOCKED",
              title: "fix: failing checks",
              isDraft: false,
              headRefName: "feature/checks-failing",
              baseRefName: "main",
              statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
            },
          ],
          [
            "ws-behind",
            {
              number: 1625,
              url: "https://github.com/coder/mux/pull/1625",
              state: "OPEN",
              mergeable: "MERGEABLE",
              mergeStateStatus: "BEHIND",
              title: "docs: update README",
              isDraft: false,
              headRefName: "feature/needs-rebase",
              baseRefName: "main",
            },
          ],
          [
            "ws-conflicts",
            {
              number: 1626,
              url: "https://github.com/coder/mux/pull/1626",
              state: "OPEN",
              mergeable: "CONFLICTING",
              mergeStateStatus: "DIRTY",
              title: "refactor: rename utils",
              isDraft: false,
              headRefName: "feature/has-conflicts",
              baseRefName: "main",
            },
          ],
          [
            "ws-draft",
            {
              number: 1627,
              url: "https://github.com/coder/mux/pull/1627",
              state: "OPEN",
              mergeable: "UNKNOWN",
              mergeStateStatus: "UNKNOWN",
              title: "WIP: experimental feature",
              isDraft: true,
              headRefName: "feature/work-in-progress",
              baseRefName: "main",
            },
          ],
          [
            "ws-merged",
            {
              number: 1620,
              url: "https://github.com/coder/mux/pull/1620",
              state: "MERGED",
              mergeable: "UNKNOWN",
              mergeStateStatus: "UNKNOWN",
              title: "feat: previous feature",
              isDraft: false,
              headRefName: "feature/already-merged",
              baseRefName: "main",
            },
          ],
          [
            "ws-closed",
            {
              number: 1618,
              url: "https://github.com/coder/mux/pull/1618",
              state: "CLOSED",
              mergeable: "UNKNOWN",
              mergeStateStatus: "UNKNOWN",
              title: "feat: abandoned approach",
              isDraft: false,
              headRefName: "feature/abandoned",
              baseRefName: "main",
            },
          ],
          ["ws-no-pr", "no_pr"],
        ]);

        // Simple chat handler - just show messages
        const chatHandlers = new Map<string, ReturnType<typeof createStaticChatHandler>>();
        for (const ws of workspaces) {
          chatHandlers.set(
            ws.id,
            createStaticChatHandler([
              createUserMessage("msg-1", "Show PR status", {
                historySequence: 1,
                timestamp: STABLE_TIMESTAMP - 60000,
              }),
              createAssistantMessage("msg-2", "Here's the PR status for this workspace.", {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP,
              }),
            ])
          );
        }

        // Select the first workspace
        selectWorkspaceHelper(workspaces[0]);

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
          onChat: createOnChatAdapter(chatHandlers),
          executeBash: createPRStatusExecutor(prStatuses),
        });
      }}
    />
  ),
};

/**
 * Shows links dropdown with various URLs extracted from chat.
 */
export const LinksDropdown: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaces = [
          createWorkspace({
            id: "ws-with-links",
            name: "feature/links",
            projectName: "my-app",
            createdAt: new Date(NOW - 3600000).toISOString(),
          }),
        ];

        const prStatuses = new Map<string, PRStatusFixture>([
          [
            "ws-with-links",
            {
              number: 1623,
              url: "https://github.com/coder/mux/pull/1623",
              state: "OPEN",
              mergeable: "MERGEABLE",
              mergeStateStatus: "CLEAN",
              title: "feat: add link support",
              isDraft: false,
              headRefName: "feature/links",
              baseRefName: "main",
            },
          ],
        ]);

        // Chat with various links
        const chatHandlers = new Map<string, ReturnType<typeof createStaticChatHandler>>();
        chatHandlers.set(
          "ws-with-links",
          createStaticChatHandler([
            createUserMessage("msg-1", "Add link support", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 120000,
            }),
            createAssistantMessage(
              "msg-2",
              `I'll help you add link support. Here are some relevant resources:

- Documentation: https://docs.example.com/links
- API Reference: https://api.example.com/v1/docs
- Related issue: https://github.com/coder/mux/issues/1500

Let me check the implementation at https://github.com/coder/mux/blob/main/src/links.ts`,
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 60000,
              }
            ),
            createUserMessage("msg-3", "Also check the tests", {
              historySequence: 3,
              timestamp: STABLE_TIMESTAMP - 30000,
            }),
            createAssistantMessage(
              "msg-4",
              `Found the tests at https://github.com/coder/mux/blob/main/src/links.test.ts

Also see the CI workflow: https://github.com/coder/mux/actions/runs/12345`,
              {
                historySequence: 4,
                timestamp: STABLE_TIMESTAMP,
              }
            ),
          ])
        );

        selectWorkspaceHelper(workspaces[0]);

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
          onChat: createOnChatAdapter(chatHandlers),
          executeBash: createPRStatusExecutor(prStatuses),
        });
      }}
    />
  ),
};
