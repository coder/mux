/**
 * UI helper functions for integration tests.
 *
 * These helpers encapsulate common user flows, performing actions through
 * the DOM just like a real user would. They use @testing-library queries
 * and userEvent for realistic interactions.
 *
 * Use these instead of direct oRPC calls to keep tests UI-driven.
 */

import { waitFor, within, type RenderResult } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

type Queries = Pick<
  RenderResult,
  | "findByRole"
  | "findByText"
  | "findByTestId"
  | "findByPlaceholderText"
  | "queryByRole"
  | "queryByText"
  | "getByRole"
>;

/**
 * Wait for the app to finish loading (loading screen disappears).
 */
export async function waitForAppLoad(queries: Pick<Queries, "queryByText">) {
  await waitFor(
    () => {
      expect(queries.queryByText(/loading workspaces/i)).toBeNull();
    },
    { timeout: 5000 }
  );
}

/**
 * Open the Settings modal.
 *
 * Note: the Dialog is rendered in a portal; queries must search `document.body`.
 * RTL's render() uses `document.body` as baseElement by default, so RenderResult
 * queries work fine.
 */
export async function openSettingsModal(
  user: UserEvent,
  queries: Pick<Queries, "findByTestId" | "findByRole">
): Promise<HTMLElement> {
  const settingsButton = await queries.findByTestId("settings-button");
  await user.click(settingsButton);

  const modal = await queries.findByRole("dialog");
  expect(modal).toBeTruthy();
  return modal;
}

/**
 * Open the Settings modal and navigate to a particular section.
 */
export async function openSettingsToSection(
  user: UserEvent,
  queries: Pick<Queries, "findByTestId" | "findByRole">,
  sectionLabel: "General" | "Providers" | "Projects" | "Models"
): Promise<HTMLElement> {
  const modal = await openSettingsModal(user, queries);

  if (sectionLabel !== "General") {
    const sectionButton = within(modal).getByRole("button", {
      name: new RegExp(`^${sectionLabel}$`, "i"),
    });
    await user.click(sectionButton);
  }

  return modal;
}

/**
 * Add a project via the UI.
 *
 * Opens the Add Project modal, types the path, and submits.
 * Works from both empty state and with existing projects.
 */
export async function addProjectViaUI(
  user: UserEvent,
  queries: Queries,
  projectPath: string
): Promise<void> {
  // Try to find "Add Project" button (empty state) or header button
  let addButton: HTMLElement;
  try {
    addButton = await queries.findByText("Add Project");
  } catch {
    // Not in empty state, use header button
    addButton = await queries.findByRole("button", { name: /add project/i });
  }
  await user.click(addButton);

  // Wait for modal to open
  const modal = await queries.findByRole("dialog");
  expect(modal).toBeTruthy();

  // Type the project path in the input
  const pathInput = await queries.findByPlaceholderText(/home.*project|path/i);
  await user.clear(pathInput);
  await user.type(pathInput, projectPath);

  // Click the "Add Project" button in the modal footer
  const submitButton = await queries.findByRole("button", { name: /^add project$/i });
  await user.click(submitButton);

  // Wait for modal to close (success) or error to appear
  await waitFor(
    () => {
      // Modal should close on success
      expect(queries.queryByRole("dialog")).toBeNull();
    },
    { timeout: 5000 }
  );
}

/**
 * Expand a project in the sidebar to reveal its workspaces.
 */
export async function expandProject(
  user: UserEvent,
  queries: Queries,
  projectName: string
): Promise<void> {
  const expandButton = await queries.findByRole("button", {
    name: `Expand project ${projectName}`,
  });
  await user.click(expandButton);

  // Wait for collapse button to appear (confirms expansion)
  await queries.findByRole("button", {
    name: `Collapse project ${projectName}`,
  });
}

/**
 * Collapse a project in the sidebar.
 */
export async function collapseProject(
  user: UserEvent,
  queries: Queries,
  projectName: string
): Promise<void> {
  const collapseButton = await queries.findByRole("button", {
    name: `Collapse project ${projectName}`,
  });
  await user.click(collapseButton);

  // Wait for expand button to appear (confirms collapse)
  await queries.findByRole("button", {
    name: `Expand project ${projectName}`,
  });
}

/**
 * Remove a project via the UI.
 *
 * Expands the project first if needed, then clicks the remove button.
 */
export async function removeProjectViaUI(
  user: UserEvent,
  queries: Queries,
  projectName: string
): Promise<void> {
  // Try to expand first (might already be expanded)
  try {
    await expandProject(user, queries, projectName);
  } catch {
    // Already expanded, continue
  }

  // Click the remove button
  const removeButton = await queries.findByRole("button", {
    name: `Remove project ${projectName}`,
  });
  await user.click(removeButton);

  // Wait for project to disappear
  await waitFor(() => {
    expect(
      queries.queryByRole("button", { name: new RegExp(`project ${projectName}`, "i") })
    ).toBeNull();
  });
}

/**
 * Select a workspace in the sidebar.
 *
 * Expands the project first if needed, then clicks the workspace.
 */
export async function selectWorkspace(
  user: UserEvent,
  queries: Queries,
  projectName: string,
  workspaceName: string
): Promise<void> {
  // Try to expand first (might already be expanded)
  try {
    await expandProject(user, queries, projectName);
  } catch {
    // Already expanded, continue
  }

  // Click the workspace
  const workspaceButton = await queries.findByRole("button", {
    name: `Select workspace ${workspaceName}`,
  });
  await user.click(workspaceButton);
}

/**
 * Remove a workspace via the UI.
 *
 * Expands the project first if needed, then clicks the remove button.
 * Handles force delete modal if it appears.
 */
export async function removeWorkspaceViaUI(
  user: UserEvent,
  queries: Queries,
  projectName: string,
  workspaceName: string
): Promise<void> {
  // Try to expand first (might already be expanded)
  try {
    await expandProject(user, queries, projectName);
  } catch {
    // Already expanded, continue
  }

  // Click the remove button
  const removeButton = await queries.findByRole("button", {
    name: `Remove workspace ${workspaceName}`,
  });
  await user.click(removeButton);

  // Handle force delete modal if it appears
  try {
    const forceDeleteButton = await queries.findByRole("button", {
      name: /force delete|delete anyway|confirm/i,
    });
    await user.click(forceDeleteButton);
  } catch {
    // No modal appeared, removal was immediate
  }

  // Wait for workspace to disappear
  await waitFor(() => {
    expect(
      queries.queryByRole("button", { name: `Select workspace ${workspaceName}` })
    ).toBeNull();
  });
}

/**
 * Click the "+ New Chat" button for a project.
 *
 * Expands the project first if needed.
 */
export async function clickNewChat(
  user: UserEvent,
  queries: Queries,
  projectName: string
): Promise<void> {
  // Try to expand first (might already be expanded)
  try {
    await expandProject(user, queries, projectName);
  } catch {
    // Already expanded, continue
  }

  const newChatButton = await queries.findByRole("button", {
    name: `New chat in ${projectName}`,
  });
  await user.click(newChatButton);
}

/**
 * Get the project name from a full path.
 */
export function getProjectName(projectPath: string): string {
  return projectPath.split("/").pop()!;
}
