/**
 * Sidebar & project navigation stories
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import {
  NOW,
  createWorkspace,
  createSSHWorkspace,
  groupWorkspacesByProject,
  createMockAPI,
  installMockAPI,
  type GitStatusFixture,
} from "./mockFactory";

export default {
  ...appMeta,
  title: "App/Sidebar",
};

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

        installMockAPI(
          createMockAPI({
            projects: groupWorkspacesByProject(workspaces),
            workspaces,
          })
        );
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

        installMockAPI(
          createMockAPI({
            projects: groupWorkspacesByProject(workspaces),
            workspaces,
          })
        );
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

        installMockAPI(
          createMockAPI({
            projects: groupWorkspacesByProject(workspaces),
            workspaces,
          })
        );
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

        installMockAPI(
          createMockAPI({
            projects: groupWorkspacesByProject(workspaces),
            workspaces,
            gitStatus,
          })
        );
      }}
    />
  ),
};
