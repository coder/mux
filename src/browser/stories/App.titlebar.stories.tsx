/**
 * Workspace titlebar / header stories
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import {
  NOW,
  createWorkspace,
  groupWorkspacesByProject,
  type GitStatusFixture,
} from "./mockFactory";
import { createGitStatusExecutor, expandProjects, selectWorkspace } from "./storyHelpers";
import { GIT_STATUS_INDICATOR_MODE_KEY } from "@/common/constants/storage";
import { within, userEvent, waitFor } from "@storybook/test";

import { createMockORPCClient } from "../../../.storybook/mocks/orpc";

export default {
  ...appMeta,
  title: "App/Titlebar",
};

/**
 * Git status tooltip in workspace header - verifies alignment is near the indicator.
 * The header uses tooltipPosition="bottom" which requires align="start" to stay anchored.
 */
export const GitStatusTooltip: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        window.localStorage.setItem(GIT_STATUS_INDICATOR_MODE_KEY, JSON.stringify("line-delta"));

        const workspaces = [
          createWorkspace({
            id: "ws-active",
            name: "feature/tooltip-test",
            projectName: "my-app",
            createdAt: new Date(NOW - 3600000).toISOString(),
          }),
        ];

        const gitStatus = new Map<string, GitStatusFixture>([
          [
            "ws-active",
            {
              ahead: 3,
              behind: 2,
              dirty: 5,
              outgoingAdditions: 150,
              outgoingDeletions: 30,
              headCommit: "WIP: Testing tooltip alignment",
            },
          ],
        ]);

        // Select workspace so header is visible
        selectWorkspace(workspaces[0]);
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
    const canvas = within(canvasElement);

    // Wait for the workspace header to render with git status
    await waitFor(
      () => {
        canvas.getByTestId("workspace-header");
      },
      { timeout: 5000 }
    );

    // Wait for git status to appear in the header specifically
    const header = canvas.getByTestId("workspace-header");
    await waitFor(
      () => {
        within(header).getByText("+150");
      },
      { timeout: 5000 }
    );

    // Hover over the git status indicator in the header (not the sidebar)
    const plusIndicator = within(header).getByText("+150");
    await userEvent.hover(plusIndicator);

    // Wait for tooltip to appear with correct alignment (portaled with data-state="open")
    // The key fix: data-align="start" anchors tooltip near the indicator (not "center")
    await waitFor(
      () => {
        const tooltip = document.body.querySelector<HTMLElement>(
          '.bg-modal-bg[data-state="open"][data-align="start"]'
        );
        if (!tooltip) throw new Error("git status tooltip not visible with align=start");
        // Verify tooltip has expected structure
        within(tooltip).getByText("Divergence:");
      },
      { timeout: 5000 }
    );

    // Double-RAF to ensure layout is stable after async rendering
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  },
};
