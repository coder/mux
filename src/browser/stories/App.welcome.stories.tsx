/**
 * Welcome/Empty state and workspace creation stories
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { createMockORPCClient } from "../../../.storybook/mocks/orpc";
import { expandProjects } from "./storyHelpers";
import { createArchivedWorkspace } from "./mockFactory";
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

/** Creation view with archived workspaces - shows archived section at bottom */
export const CreateWorkspaceWithArchived: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/my-project"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/my-project")]),
          workspaces: [
            createArchivedWorkspace({
              id: "archived-1",
              name: "feature/old-feature",
              projectName: "my-project",
              projectPath: "/Users/dev/my-project",
            }),
            createArchivedWorkspace({
              id: "archived-2",
              name: "bugfix/resolved-issue",
              projectName: "my-project",
              projectPath: "/Users/dev/my-project",
            }),
          ],
        });
      }}
    />
  ),
};
