/**
 * Workspace switcher stories - tests visual hierarchy of title vs name
 *
 * Shows command palette with workspace entries where:
 * - Title (if set) is the primary label
 * - Name + project shown as subtitle
 * - Keywords enable matching by title, name, or project
 */

import { expect, userEvent, within } from "@storybook/test";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { NOW, createWorkspace, groupWorkspacesByProject } from "./mockFactory";
import { selectWorkspace, collapseRightSidebar, expandProjects } from "./storyHelpers";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";

export default {
  ...appMeta,
  title: "App/WorkspaceSwitcher",
};

/**
 * Command palette showing workspace switcher with title-first hierarchy.
 *
 * - Workspaces with titles show the title as primary label
 * - Workspaces without titles show the branch name as primary
 * - All entries show name · project as subtitle
 */
export const WithTitles: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaces = [
          // Workspace with a title - title should be primary
          createWorkspace({
            id: "ws-with-title",
            name: "fix/login-button",
            projectName: "my-app",
            title: "Fix login button styling issue",
            createdAt: new Date(NOW - 3600000).toISOString(),
          }),
          // Workspace without title - name should be primary
          createWorkspace({
            id: "ws-no-title",
            name: "feature/auth",
            projectName: "my-app",
            createdAt: new Date(NOW - 7200000).toISOString(),
          }),
          // Another workspace with a long title
          createWorkspace({
            id: "ws-long-title",
            name: "refactor/api-layer",
            projectName: "my-app",
            title: "Refactor API layer to use new error handling patterns",
            createdAt: new Date(NOW - 10800000).toISOString(),
          }),
          // Workspace in different project without title
          createWorkspace({
            id: "ws-other-project",
            name: "main",
            projectName: "other-project",
            createdAt: new Date(NOW - 14400000).toISOString(),
          }),
        ];

        const projects = groupWorkspacesByProject(workspaces);

        selectWorkspace(workspaces[0]);
        collapseRightSidebar();
        expandProjects([...projects.keys()]);

        return createMockORPCClient({
          projects,
          workspaces,
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for app to render
    await expect(
      canvas.findByText("Fix login button styling issue", {}, { timeout: 5000 })
    ).resolves.toBeTruthy();

    // Open command palette with keyboard shortcut
    await userEvent.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");

    // The command palette should now be visible with workspace entries
    // showing title as primary label
  },
};
