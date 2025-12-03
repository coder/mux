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
import { expandProjects } from "./storyHelpers";
import { createMockORPCClient } from "../../../.storybook/mocks/orpc";
import type { WorkspaceChatMessage } from "@/common/orpc/types";

export default {
  ...appMeta,
  title: "App/Sidebar",
};

type ChatHandler = (callback: (event: WorkspaceChatMessage) => void) => () => void;

/** Adapts callback-based chat handlers to ORPC onChat format */
function createOnChatAdapter(chatHandlers: Map<string, ChatHandler>) {
  return (workspaceId: string, emit: (msg: WorkspaceChatMessage) => void) => {
    const handler = chatHandlers.get(workspaceId);
    if (handler) {
      return handler(emit);
    }
    queueMicrotask(() => emit({ type: "caught-up" }));
    return undefined;
  };
}

/** Creates an executeBash function that returns git status output for workspaces */
function createGitStatusExecutor(gitStatus?: Map<string, GitStatusFixture>) {
  return (workspaceId: string, script: string) => {
    if (script.includes("git status") || script.includes("git show-branch")) {
      const status = gitStatus?.get(workspaceId) ?? {};
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

/** All git status indicator variations */
export const GitStatusVariations: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
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

        const gitStatus = new Map<string, GitStatusFixture>([
          ["ws-clean", {}],
          ["ws-ahead", { ahead: 2, headCommit: "Add new dashboard" }],
          ["ws-behind", { behind: 3, originCommit: "Latest API changes" }],
          ["ws-dirty", { dirty: 7 }],
          ["ws-diverged", { ahead: 2, behind: 1, dirty: 5 }],
          ["ws-ssh", { ahead: 1 }],
        ]);

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
