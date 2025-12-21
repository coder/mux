/**
 * Welcome/Empty state and workspace creation stories
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { createMockORPCClient } from "../../../.storybook/mocks/orpc";
import { expandProjects } from "./storyHelpers";
import { createArchivedWorkspace, NOW } from "./mockFactory";
import type { ProjectConfig } from "@/node/config";

export default {
  ...appMeta,
  title: "App/Welcome",
};

/** Welcome screen shown when no projects exist */
export const WelcomeScreen: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        createMockORPCClient({
          projects: new Map(),
          workspaces: [],
        })
      }
    />
  ),
};

/** Helper to create a project config for a path with no workspaces */
function projectWithNoWorkspaces(path: string): [string, ProjectConfig] {
  return [path, { workspaces: [] }];
}

/** Creation view - shown when a project exists but no workspace is selected */
export const CreateWorkspace: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/my-project"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/my-project")]),
          workspaces: [],
        });
      }}
    />
  ),
};

/** Creation view with multiple projects - shows sidebar with projects */
export const CreateWorkspaceMultipleProjects: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects([
          "/Users/dev/frontend-app",
          "/Users/dev/backend-api",
          "/Users/dev/mobile-client",
        ]);
        return createMockORPCClient({
          projects: new Map([
            projectWithNoWorkspaces("/Users/dev/frontend-app"),
            projectWithNoWorkspaces("/Users/dev/backend-api"),
            projectWithNoWorkspaces("/Users/dev/mobile-client"),
          ]),
          workspaces: [],
        });
      }}
    />
  ),
};

/** Helper to generate archived workspaces with varied dates for timeline grouping */
function generateArchivedWorkspaces(projectPath: string, projectName: string) {
  const DAY = 86400000;
  const HOUR = 3600000;
  // Generate enough workspaces to show: search bar (>3), bulk selection, timeline grouping
  return [
    // Today
    createArchivedWorkspace({
      id: "archived-1",
      name: "feature/new-ui",
      projectName,
      projectPath,
      archivedAt: new Date(NOW - 2 * HOUR).toISOString(),
    }),
    createArchivedWorkspace({
      id: "archived-2",
      name: "bugfix/login-issue",
      projectName,
      projectPath,
      archivedAt: new Date(NOW - 5 * HOUR).toISOString(),
    }),
    // Yesterday
    createArchivedWorkspace({
      id: "archived-3",
      name: "feature/dark-mode",
      projectName,
      projectPath,
      archivedAt: new Date(NOW - DAY - 3 * HOUR).toISOString(),
    }),
    // This week
    createArchivedWorkspace({
      id: "archived-4",
      name: "refactor/cleanup",
      projectName,
      projectPath,
      archivedAt: new Date(NOW - 3 * DAY).toISOString(),
    }),
    createArchivedWorkspace({
      id: "archived-5",
      name: "feature/api-v2",
      projectName,
      projectPath,
      archivedAt: new Date(NOW - 5 * DAY).toISOString(),
    }),
    // This month
    createArchivedWorkspace({
      id: "archived-6",
      name: "bugfix/memory-leak",
      projectName,
      projectPath,
      archivedAt: new Date(NOW - 12 * DAY).toISOString(),
    }),
    // Older
    createArchivedWorkspace({
      id: "archived-7",
      name: "feature/notifications",
      projectName,
      projectPath,
      archivedAt: new Date(NOW - 45 * DAY).toISOString(),
    }),
    createArchivedWorkspace({
      id: "archived-8",
      name: "refactor/database",
      projectName,
      projectPath,
      archivedAt: new Date(NOW - 60 * DAY).toISOString(),
    }),
  ];
}

/**
 * Project page with archived workspaces - demonstrates:
 * - Timeline grouping (Today, Yesterday, This Week, etc.)
 * - Search bar (visible with >3 workspaces)
 * - Bulk selection with checkboxes
 * - Select all checkbox
 * - Restore and delete actions
 */
export const ProjectPageWithArchivedWorkspaces: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/my-project"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/my-project")]),
          workspaces: generateArchivedWorkspaces("/Users/dev/my-project", "my-project"),
        });
      }}
    />
  ),
};
