/**
 * New Project modal stories
 *
 * Captures both tabs of the "Add Project" modal:
 * - "Local folder" (default) — path input + Browse button
 * - "Clone repo" — repo URL + clone location inputs
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { createWorkspace, groupWorkspacesByProject } from "./mockFactory";
import { selectWorkspace, expandProjects } from "./storyHelpers";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { within, userEvent, waitFor } from "@storybook/test";
import type { APIClient } from "@/browser/contexts/API";

export default {
  ...appMeta,
  title: "App/ProjectCreate",
};

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function setupProjectCreateStory(): APIClient {
  const workspaces = [createWorkspace({ id: "ws-1", name: "main", projectName: "my-app" })];
  selectWorkspace(workspaces[0]);
  expandProjects(["/mock/my-app"]);
  return createMockORPCClient({
    projects: groupWorkspacesByProject(workspaces),
    workspaces,
  });
}

/** Click "New Project" in the sidebar to open the Add Project modal. */
async function openNewProjectModal(canvasElement: HTMLElement): Promise<void> {
  const canvas = within(canvasElement);
  const body = within(canvasElement.ownerDocument.body);

  // Wait for the sidebar's "Add project" button to appear
  const addButton = await canvas.findByLabelText("Add project", {}, { timeout: 10000 });
  await userEvent.click(addButton);

  // Wait for the dialog portal to render
  await body.findByRole("dialog");
}

// ═══════════════════════════════════════════════════════════════════════════════
// STORIES
// ═══════════════════════════════════════════════════════════════════════════════

/** Default "Local folder" tab of the Add Project modal. */
export const LocalFolder: AppStory = {
  render: () => <AppWithMocks setup={setupProjectCreateStory} />,
  play: async ({ canvasElement }) => {
    await openNewProjectModal(canvasElement);
  },
};

/** "Clone repo" tab of the Add Project modal. */
export const CloneRepo: AppStory = {
  render: () => <AppWithMocks setup={setupProjectCreateStory} />,
  play: async ({ canvasElement }) => {
    await openNewProjectModal(canvasElement);

    const body = within(canvasElement.ownerDocument.body);

    // Switch to the "Clone repo" tab
    const cloneTab = await body.findByRole("radio", { name: /Clone repo/i });
    await userEvent.click(cloneTab);

    // Verify the clone form is visible
    await waitFor(() => body.getByText("Repo URL"));
  },
};
