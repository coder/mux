/**
 * Sidebar & project navigation stories
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import {
  NOW,
  STABLE_TIMESTAMP,
  createWorkspace,
  createSSHWorkspace,
  createLocalWorkspace,
  createUserMessage,
  createStreamingChatHandler,
  groupWorkspacesByProject,
  createGitStatusOutput,
  type GitStatusFixture,
} from "./mockFactory";
import {
  clearWorkspaceSelection,
  createOnChatAdapter,
  type ChatHandler,
  expandProjects,
} from "./storyHelpers";
import { GIT_STATUS_INDICATOR_MODE_KEY } from "@/common/constants/storage";
import { within, userEvent, waitFor } from "@storybook/test";

import { createMockORPCClient } from "../../../.storybook/mocks/orpc";

export default {
  ...appMeta,
  title: "App/Sidebar",
  decorators: [
    (Story: () => JSX.Element) => {
      // Sidebar stories are about list organization; keep the main panel unselected.
      clearWorkspaceSelection();
      return <Story />;
    },
  ],
};

/**
 * Creates an executeBash function that returns deterministic git outputs for Storybook.
 *
 * NOTE: This is only used in full-app stories to make GitStatusIndicator + tooltip stable.
 */
function createGitStatusExecutor(gitStatus?: Map<string, GitStatusFixture>) {
  const buildBranchDetailsOutput = (status: GitStatusFixture): string => {
    const ahead = status.ahead ?? 0;
    const behind = status.behind ?? 0;
    const dirtyCount = status.dirty ?? 0;
    const headCommit = status.headCommit ?? "Latest commit";
    const originCommit = status.originCommit ?? "Latest commit";

    let hashIndex = 0;
    const nextHash = () => {
      hashIndex++;
      return hashIndex.toString(16).padStart(7, "0");
    };

    const commitHashes: string[] = [];

    const showBranchLines: string[] = [];
    showBranchLines.push(`! [HEAD] ${headCommit}`);
    showBranchLines.push(` ! [origin/main] ${originCommit}`);
    showBranchLines.push("--");

    for (let i = 0; i < ahead; i++) {
      const hash = nextHash();
      commitHashes.push(hash);
      showBranchLines.push(`+  [${hash}] Local commit ${i + 1}`);
    }

    for (let i = 0; i < behind; i++) {
      const hash = nextHash();
      commitHashes.push(hash);
      showBranchLines.push(` + [${hash}] Origin commit ${i + 1}`);
    }

    // Always include at least one shared commit so the tooltip has stable structure.
    const sharedHash = nextHash();
    commitHashes.push(sharedHash);
    showBranchLines.push(`++ [${sharedHash}] Shared commit`);

    const dates = commitHashes
      .map((hash, index) => `${hash}|Nov 14 0${(index % 9) + 1}:0${index % 6} PM`)
      .join("\n");

    const dirtyFiles =
      dirtyCount > 0
        ? [" M src/App.tsx", " M src/browser/components/GitStatusIndicatorView.tsx"].join("\n")
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
    const status = gitStatus?.get(workspaceId) ?? {};

    // useGitBranchDetails consolidated script (tooltip content)
    if (script.includes("__MUX_BRANCH_DATA__BEGIN_SHOW_BRANCH__")) {
      const output = buildBranchDetailsOutput(status);
      return Promise.resolve({ success: true as const, output, exitCode: 0, wall_duration_ms: 50 });
    }

    // GitStatusStore consolidated status script
    if (script.includes("PRIMARY_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD")) {
      const output = createGitStatusOutput(status);
      return Promise.resolve({ success: true as const, output, exitCode: 0, wall_duration_ms: 50 });
    }

    return Promise.resolve({
      success: true as const,
      output: "",
      exitCode: 0,
      wall_duration_ms: 0,
    });
  };
}

/** Single project with multiple workspaces including SSH */
export const SingleProject: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaces = [
          createWorkspace({ id: "ws-1", name: "main", projectName: "my-app" }),
          createSSHWorkspace({
            id: "ws-2",
            name: "feature/auth",
            projectName: "my-app",
            host: "dev-server.example.com",
          }),
          createWorkspace({ id: "ws-3", name: "bugfix/memory-leak", projectName: "my-app" }),
        ];

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
        });
      }}
    />
  ),
};

/** Multiple projects showing sidebar organization */
export const MultipleProjects: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaces = [
          createWorkspace({ id: "ws-1", name: "main", projectName: "frontend" }),
          createWorkspace({ id: "ws-2", name: "redesign", projectName: "frontend" }),
          createWorkspace({ id: "ws-3", name: "main", projectName: "backend" }),
          createWorkspace({ id: "ws-4", name: "api-v2", projectName: "backend" }),
          createSSHWorkspace({
            id: "ws-5",
            name: "db-migration",
            projectName: "backend",
            host: "staging.example.com",
          }),
          createWorkspace({ id: "ws-6", name: "main", projectName: "mobile" }),
        ];

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
        });
      }}
    />
  ),
};

/** Many workspaces testing sidebar scroll behavior */
export const ManyWorkspaces: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const names = [
          "main",
          "develop",
          "staging",
          "feature/authentication",
          "feature/dashboard",
          "feature/notifications",
          "feature/search",
          "bugfix/memory-leak",
          "bugfix/login-redirect",
          "refactor/components",
          "experiment/new-ui",
          "release/v1.2.0",
        ];

        const workspaces = names.map((name, i) =>
          createWorkspace({ id: `ws-${i}`, name, projectName: "big-app" })
        );

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
        });
      }}
    />
  ),
};

/** Long workspace names - tests truncation and prevents horizontal scroll regression */
export const LongWorkspaceNames: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaces = [
          createWorkspace({
            id: "ws-short",
            name: "main",
            projectName: "my-app",
          }),
          createWorkspace({
            id: "ws-medium",
            name: "feature/user-authentication",
            projectName: "my-app",
          }),
          createWorkspace({
            id: "ws-long",
            name: "feature/implement-oauth2-authentication-with-google-provider",
            projectName: "my-app",
          }),
          createWorkspace({
            id: "ws-very-long",
            name: "bugfix/fix-critical-memory-leak-in-websocket-connection-handler-that-causes-oom",
            projectName: "my-app",
          }),
          createSSHWorkspace({
            id: "ws-ssh-long",
            name: "deploy/production-kubernetes-cluster-rolling-update-with-zero-downtime",
            projectName: "my-app",
            host: "very-long-hostname.internal.company-infrastructure.example.com",
          }),
        ];

        // Set up git status to verify GitStatusIndicator remains visible
        const gitStatus = new Map<string, GitStatusFixture>([
          ["ws-short", { ahead: 1 }],
          ["ws-medium", { dirty: 3 }],
          ["ws-long", { ahead: 2, behind: 1 }],
          ["ws-very-long", { dirty: 5, ahead: 3 }],
          ["ws-ssh-long", { behind: 2 }],
        ]);

        expandProjects(["/home/user/projects/my-app"]);

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
          executeBash: createGitStatusExecutor(gitStatus),
        });
      }}
    />
  ),
};

/**
 * Git status indicator variations showing line deltas and commit divergence.
 * Demonstrates both modes (toggle in tooltip) with various states:
 * - Clean: no changes
 * - Ahead: local commits with line additions
 * - Behind: only behind remote (shows muted ↓N in line-delta mode)
 * - Dirty: uncommitted changes
 * - Diverged: ahead, behind, and dirty with large line counts (tests abbreviation)
 */
export const GitStatusVariations: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        window.localStorage.setItem(GIT_STATUS_INDICATOR_MODE_KEY, JSON.stringify("line-delta"));

        const workspaces = [
          createWorkspace({
            id: "ws-clean",
            name: "main",
            projectName: "my-app",
            createdAt: new Date(NOW - 3600000).toISOString(),
          }),
          createWorkspace({
            id: "ws-ahead",
            name: "feature/new-ui",
            projectName: "my-app",
            createdAt: new Date(NOW - 7200000).toISOString(),
          }),
          createWorkspace({
            id: "ws-behind",
            name: "feature/api",
            projectName: "my-app",
            createdAt: new Date(NOW - 10800000).toISOString(),
          }),
          createWorkspace({
            id: "ws-dirty",
            name: "bugfix/crash",
            projectName: "my-app",
            createdAt: new Date(NOW - 14400000).toISOString(),
          }),
          createWorkspace({
            id: "ws-diverged",
            name: "refactor/db",
            projectName: "my-app",
            createdAt: new Date(NOW - 18000000).toISOString(),
          }),
          createSSHWorkspace({
            id: "ws-ssh",
            name: "deploy/prod",
            projectName: "my-app",
            host: "prod.example.com",
            createdAt: new Date(NOW - 21600000).toISOString(),
          }),
        ];

        // Line deltas show in line-delta mode; ahead/behind show in divergence mode
        const gitStatus = new Map<string, GitStatusFixture>([
          ["ws-clean", {}],
          [
            "ws-ahead",
            {
              ahead: 2,
              outgoingAdditions: 150,
              outgoingDeletions: 30,
              headCommit: "Add new dashboard",
            },
          ],
          ["ws-behind", { behind: 5, originCommit: "Latest API changes" }],
          ["ws-dirty", { dirty: 7, outgoingAdditions: 42, outgoingDeletions: 8 }],
          [
            "ws-diverged",
            { ahead: 3, behind: 2, dirty: 5, outgoingAdditions: 12313, outgoingDeletions: 1231 },
          ],
          ["ws-ssh", { ahead: 1, outgoingAdditions: 25 }],
        ]);

        expandProjects(["/home/user/projects/my-app"]);

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
          executeBash: createGitStatusExecutor(gitStatus),
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    // Wait for git status to render (fetched async via GitStatusStore polling)
    await waitFor(
      () => {
        const row = canvasElement.querySelector<HTMLElement>('[data-workspace-id="ws-diverged"]');
        if (!row) throw new Error("ws-diverged row not found");
        within(row).getByText("+12.3k");
      },
      { timeout: 5000 }
    );

    const row = canvasElement.querySelector<HTMLElement>('[data-workspace-id="ws-diverged"]')!;
    const plus = within(row).getByText("+12.3k");

    // Hover to open tooltip
    await userEvent.hover(plus);

    // HoverCard content is portaled with data-state="open" when visible
    const getVisibleTooltip = () =>
      document.body.querySelector<HTMLElement>('.bg-modal-bg[data-state="open"]');

    // Wait for tooltip (portaled) and toggle to commits mode
    await waitFor(
      () => {
        const tooltip = getVisibleTooltip();
        if (!tooltip) throw new Error("git status tooltip not visible");
        within(tooltip).getByText("Commits");
      },
      { timeout: 5000 }
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
      { timeout: 2000 }
    );
  },
};

/**
 * All runtime badge variations showing different runtime types.
 * Each type has distinct colors:
 * - SSH: blue theme
 * - Worktree: purple theme
 * - Local: gray theme
 *
 * The streaming workspaces show the "working" state with pulse animation.
 */
export const RuntimeBadgeVariations: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        // Idle workspaces (one of each type)
        const sshIdle = createSSHWorkspace({
          id: "ws-ssh-idle",
          name: "ssh-idle",
          projectName: "runtime-demo",
          host: "dev.example.com",
          createdAt: new Date(NOW - 3600000).toISOString(),
        });
        const worktreeIdle = createWorkspace({
          id: "ws-worktree-idle",
          name: "worktree-idle",
          projectName: "runtime-demo",
          createdAt: new Date(NOW - 7200000).toISOString(),
        });
        const localIdle = createLocalWorkspace({
          id: "ws-local-idle",
          name: "local-idle",
          projectName: "runtime-demo",
          createdAt: new Date(NOW - 10800000).toISOString(),
        });

        // Working workspaces (streaming - shows pulse animation)
        const sshWorking = createSSHWorkspace({
          id: "ws-ssh-working",
          name: "ssh-working",
          projectName: "runtime-demo",
          host: "prod.example.com",
          createdAt: new Date(NOW - 1800000).toISOString(),
        });
        const worktreeWorking = createWorkspace({
          id: "ws-worktree-working",
          name: "worktree-working",
          projectName: "runtime-demo",
          createdAt: new Date(NOW - 900000).toISOString(),
        });
        const localWorking = createLocalWorkspace({
          id: "ws-local-working",
          name: "local-working",
          projectName: "runtime-demo",
          createdAt: new Date(NOW - 300000).toISOString(),
        });

        const workspaces = [
          sshIdle,
          worktreeIdle,
          localIdle,
          sshWorking,
          worktreeWorking,
          localWorking,
        ];

        // Create streaming handlers for working workspaces
        const workingMessage = createUserMessage("msg-1", "Working on task...", {
          historySequence: 1,
          timestamp: STABLE_TIMESTAMP,
        });

        const chatHandlers = new Map<string, ChatHandler>([
          [
            "ws-ssh-working",
            createStreamingChatHandler({
              messages: [workingMessage],
              streamingMessageId: "stream-ssh",
              model: "claude-sonnet-4-20250514",
              historySequence: 2,
              streamText: "Processing SSH task...",
            }),
          ],
          [
            "ws-worktree-working",
            createStreamingChatHandler({
              messages: [workingMessage],
              streamingMessageId: "stream-worktree",
              model: "claude-sonnet-4-20250514",
              historySequence: 2,
              streamText: "Processing worktree task...",
            }),
          ],
          [
            "ws-local-working",
            createStreamingChatHandler({
              messages: [workingMessage],
              streamingMessageId: "stream-local",
              model: "claude-sonnet-4-20250514",
              historySequence: 2,
              streamText: "Processing local task...",
            }),
          ],
        ]);

        // Expand the project so badges are visible
        expandProjects(["/home/user/projects/runtime-demo"]);

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
          onChat: createOnChatAdapter(chatHandlers),
        });
      }}
    />
  ),
};
