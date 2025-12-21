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
  const MINUTE = 60000;
  const HOUR = 3600000;
  const DAY = 86400000;

  // Intentionally large set to exercise ProjectPage scrolling + bulk selection UX.
  // Keep timestamps deterministic (based on NOW constant).
  const result = Array.from({ length: 34 }, (_, i) => {
    const n = i + 1;

    // Mix timeframes:
    // - first ~6: today (minutes/hours)
    // - next ~8: last week
    // - next ~10: last month
    // - remaining: older (spans multiple month/year buckets)
    let archivedDeltaMs: number;
    if (n <= 3) {
      archivedDeltaMs = n * 15 * MINUTE;
    } else if (n <= 6) {
      archivedDeltaMs = n * 2 * HOUR;
    } else if (n <= 14) {
      archivedDeltaMs = n * DAY;
    } else if (n <= 24) {
      archivedDeltaMs = n * 3 * DAY;
    } else {
      // Older: jump further back to create multiple month/year group headers
      archivedDeltaMs = (n - 10) * 15 * DAY;
    }

    const kind = n % 6;
    const name =
      kind === 0
        ? `feature/batch-${n}`
        : kind === 1
          ? `bugfix/issue-${n}`
          : kind === 2
            ? `refactor/cleanup-${n}`
            : kind === 3
              ? `chore/deps-${n}`
              : kind === 4
                ? `feature/ui-${n}`
                : `bugfix/regression-${n}`;

    return createArchivedWorkspace({
      id: `archived-${n}`,
      name,
      projectName,
      projectPath,
      archivedAt: new Date(NOW - archivedDeltaMs).toISOString(),
    });
  });

  return result;
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
