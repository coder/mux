/**
 * Archived workspaces stories.
 */

import { within, userEvent, waitFor } from "@storybook/test";

import { createMockORPCClient } from "../../../.storybook/mocks/orpc";
import { clearWorkspaceSelection, expandProjects } from "./storyHelpers";
import { createArchivedWorkspace, NOW } from "./mockFactory";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import type { ProjectConfig } from "@/node/config";

export default {
  ...appMeta,
  title: "App/Archived Workspaces",
};

function projectWithNoWorkspaces(path: string): [string, ProjectConfig] {
  return [path, { workspaces: [] }];
}

/**
 * Regression test: archived workspaces with a custom title should still expose the git branch
 * name (workspace.name) in the runtime badge tooltip.
 */
export const BranchNameInRuntimeTooltip: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        clearWorkspaceSelection();

        const projectPath = "/Users/dev/my-project";
        const projectName = "my-project";

        expandProjects([projectPath]);

        const MINUTE = 60_000;
        const HOUR = 60 * MINUTE;

        const titledWorkspace = {
          ...createArchivedWorkspace({
            id: "archived-title-1",
            // Branch name is stored in workspace.name (and can include slashes)
            name: "bugfix/agent-report-rendering",
            projectName,
            projectPath,
            createdAt: new Date(NOW - 2 * HOUR).toISOString(),
            archivedAt: new Date(NOW - 15 * MINUTE).toISOString(),
          }),
          title: "Fix agent report rendering",
        };

        const workspaces = [
          titledWorkspace,
          createArchivedWorkspace({
            id: "archived-2",
            name: "feature/sub-agent-costs",
            projectName,
            projectPath,
            createdAt: new Date(NOW - 3 * HOUR).toISOString(),
            archivedAt: new Date(NOW - 30 * MINUTE).toISOString(),
          }),
          createArchivedWorkspace({
            id: "archived-3",
            name: "refactor/mcp-config",
            projectName,
            projectPath,
            createdAt: new Date(NOW - 4 * HOUR).toISOString(),
            archivedAt: new Date(NOW - 45 * MINUTE).toISOString(),
          }),
          createArchivedWorkspace({
            id: "archived-4",
            name: "chore/remove-truncation",
            projectName,
            projectPath,
            createdAt: new Date(NOW - 5 * HOUR).toISOString(),
            archivedAt: new Date(NOW - 60 * MINUTE).toISOString(),
          }),
        ];

        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces(projectPath)]),
          workspaces,
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    const canvas = within(storyRoot);

    // Wait for the archived list to load and scroll it into view (it's below the creation prompt).
    const archivedHeader = await canvas.findByText(/Archived Workspaces/i, {}, { timeout: 10000 });
    archivedHeader.scrollIntoView({ block: "start" });

    // Find the workspace row by its visible title.
    const checkbox = await canvas.findByLabelText(
      "Select Fix agent report rendering",
      {},
      {
        timeout: 10000,
      }
    );

    const row = checkbox.closest<HTMLDivElement>("div");
    if (!row) {
      throw new Error("Archived workspace row not found");
    }

    const runtimeIcon = row.querySelector("svg");
    if (!runtimeIcon) {
      throw new Error("Runtime icon not found");
    }

    const runtimeBadge = runtimeIcon.closest<HTMLElement>("span");
    if (!runtimeBadge) {
      throw new Error("Runtime badge trigger not found");
    }

    // Hover to open the tooltip and leave it visible for the visual snapshot.
    await userEvent.hover(runtimeBadge);

    // Wait for tooltip to fully appear (Radix has 200ms delay).
    await waitFor(
      () => {
        const tooltip = document.querySelector('[role="tooltip"]');
        if (!tooltip) {
          throw new Error("Tooltip not visible");
        }

        const tooltipWithin = within(tooltip as HTMLElement);
        tooltipWithin.getByText("Worktree: isolated git worktree");
        tooltipWithin.getByText("Branch:");
        tooltipWithin.getByText("bugfix/agent-report-rendering");
      },
      { timeout: 2000, interval: 50 }
    );
  },
  parameters: {
    docs: {
      description: {
        story:
          "Shows a ProjectPage with archived workspaces; hovering the worktree badge displays the stored branch name when a custom title is set.",
      },
    },
  },
};
