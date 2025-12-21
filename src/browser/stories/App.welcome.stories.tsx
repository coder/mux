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

/** Helper to generate archived workspaces for bulk operation stories */
function generateArchivedWorkspaces(count: number, projectPath: string, projectName: string) {
  const DAY = 86400000;
  const names = [
    "feature/new-ui",
    "bugfix/login-issue",
    "feature/dark-mode",
    "refactor/cleanup",
    "feature/api-v2",
    "bugfix/memory-leak",
    "feature/notifications",
    "refactor/database",
    "feature/search",
    "bugfix/auth-flow",
  ];
  return Array.from({ length: count }, (_, i) =>
    createArchivedWorkspace({
      id: `archived-${i + 1}`,
      name: names[i % names.length],
      projectName,
      projectPath,
      archivedAt: new Date(NOW - (i + 1) * DAY).toISOString(),
    })
  );
}

/** Creation view with archived workspaces - shows timeline grouped archived section */
export const CreateWorkspaceWithArchived: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/my-project"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/my-project")]),
          workspaces: generateArchivedWorkspaces(5, "/Users/dev/my-project", "my-project"),
        });
      }}
    />
  ),
};

/** Archived workspaces with bulk selection - click checkboxes to select multiple */
export const ArchivedWorkspacesBulkSelection: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/my-project"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/my-project")]),
          workspaces: generateArchivedWorkspaces(8, "/Users/dev/my-project", "my-project"),
        });
      }}
    />
  ),
};
