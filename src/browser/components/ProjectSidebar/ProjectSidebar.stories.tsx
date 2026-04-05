import { fireEvent, userEvent, waitFor } from "@storybook/test";
import type { AppStory } from "@/browser/stories/meta.js";
import { CHROMATIC_SMOKE_MODES, appMeta, AppWithMocks } from "@/browser/stories/meta.js";
import { expandProjects } from "@/browser/stories/helpers/uiState";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { createWorkspace, groupWorkspacesByProject } from "@/browser/stories/mocks/workspaces";

const meta = {
  ...appMeta,
  title: "Components/ProjectSidebar",
};

export default meta;

// Integration: story renders full app to test project removal confirmation flow via sidebar context menu.
export const ProjectRemovalDisabled: AppStory = {
  parameters: {
    chromatic: { modes: CHROMATIC_SMOKE_MODES },
  },
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaces = [
          createWorkspace({ id: "ws-1", name: "main", projectName: "my-app" }),
          createWorkspace({ id: "ws-2", name: "feature/auth", projectName: "my-app" }),
        ];
        expandProjects(["/home/user/projects/my-app"]);
        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const projectOptionsButton = await waitFor(() => {
      const button = canvasElement.querySelector<HTMLButtonElement>(
        'button[aria-label="Project options for my-app"]'
      );
      if (!button) throw new Error("Project options button not found");
      return button;
    });

    // Action buttons are hidden (pointer-events: none) until row hover.
    // CSS :hover can't be triggered by testing-library's userEvent.hover(),
    // so use fireEvent.click which bypasses the pointer-events check.
    await fireEvent.click(projectOptionsButton);

    await waitFor(() => {
      const menuIsVisible = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).some(
        (button) => button.textContent?.trim() === "Delete..."
      );
      if (!menuIsVisible) throw new Error("Project options menu did not open");
    });

    const deleteMenuItem = await waitFor(() => {
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
        (candidate) => candidate.textContent?.trim() === "Delete..."
      );
      if (!button) throw new Error("Delete menu item not found");
      return button;
    });

    await userEvent.click(deleteMenuItem);

    await waitFor(
      () => {
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) throw new Error("Confirmation modal not found");
        if (!dialog.textContent?.includes("my-app")) {
          throw new Error("Modal should reference the project name");
        }
      },
      { timeout: 2000 }
    );
  },
};
