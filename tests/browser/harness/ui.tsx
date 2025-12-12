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
  | "queryByPlaceholderText"
  | "queryByRole"
  | "queryByText"
  | "getByRole"
>;

function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
 * Ensure a project is expanded in the sidebar (no-op if already expanded).
 */
export async function ensureProjectExpanded(
  user: UserEvent,
  queries: Queries,
  projectName: string
): Promise<void> {
  const expandLabel = `Expand project ${projectName}`;
  const collapseLabel = `Collapse project ${projectName}`;

  if (queries.queryByRole("button", { name: collapseLabel })) {
    return;
  }

  const expandButton = queries.queryByRole("button", { name: expandLabel });
  if (expandButton) {
    await user.click(expandButton);
  }

  await waitFor(
    () => {
      expect(queries.queryByRole("button", { name: collapseLabel })).toBeTruthy();
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

  // Wait for the workspace to be ready (not in "creating" state).
  await waitFor(
    () => {
      expect(
        queries.queryByRole("button", {
          name: `Select workspace ${workspaceName}`,
        })
      ).toBeTruthy();
    },
    { timeout: 30000 }
  );

  const workspaceButton = queries.getByRole("button", {
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

  await waitFor(
    () => {
      expect(
        queries.queryByRole("button", {
          name: `Remove workspace ${workspaceName}`,
        })
      ).toBeTruthy();
    },
    { timeout: 30000 }
  );

  const removeButton = queries.getByRole("button", {
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

  const workspaceLabel = new RegExp(
    `^(select|creating|deleting) workspace ${escapeForRegex(workspaceName)}$`,
    "i"
  );

  // Wait for workspace to disappear
  await waitFor(
    () => {
      expect(queries.queryByRole("button", { name: workspaceLabel })).toBeNull();
    },
    { timeout: 30000 }
  );
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
 * A workspace created through the UI.
 */
export type CreatedWorkspace = {
  workspaceId: string;
  workspaceTitle: string;
};

function getWorkspaceButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll("button[data-workspace-id]")).filter(
    (button): button is HTMLButtonElement => {
      const label = button.getAttribute("aria-label") ?? "";
      return /^(select|creating) workspace /i.test(label);
    }
  );
}

function getWorkspaceTitleFromAriaLabel(label: string): string {
  return label.replace(/^(select|creating) workspace\s+/i, "");
}

/**
 * Create a workspace via the UI by opening the creation view, setting the workspace
 * name manually (to avoid requiring name-generation), and sending the first message.
 */
const DEFAULT_WORKSPACE_CREATION_PROMPTS = [
  "What's in README.md?",
  "What files are in the current directory?",
  "Explain quicksort algorithm step by step",
  "Create a file called test.txt with 'hello' in it",
  "Now read that file",
  "What did it contain?",
  "Let's summarize the current branches.",
] as const;

let defaultWorkspacePromptIndex = 0;

function getDefaultWorkspaceCreationPrompt(): string {
  const prompt =
    DEFAULT_WORKSPACE_CREATION_PROMPTS[
      defaultWorkspacePromptIndex % DEFAULT_WORKSPACE_CREATION_PROMPTS.length
    ];
  defaultWorkspacePromptIndex += 1;
  return prompt;
}

export async function createWorkspaceViaUI(
  user: UserEvent,
  queries: Queries,
  projectName: string,
  options: {
    workspaceName: string;
    firstMessage?: string;
  }
): Promise<CreatedWorkspace> {
  const firstMessage = options.firstMessage ?? getDefaultWorkspaceCreationPrompt();

  const previousHash = window.location.hash;

  // Open creation UI
  await clickNewChat(user, queries, projectName);

  // Disable auto-naming by focusing the name input.
  const nameInput = await queries.findByPlaceholderText(/workspace-name/i);
  await user.click(nameInput);
  await user.clear(nameInput);
  await user.type(nameInput, options.workspaceName);

  // Send the first message (this triggers workspace creation).
  const messageInput = await queries.findByPlaceholderText(
    /type your first message to create a workspace/i
  );
  await user.click(messageInput);
  await user.type(messageInput, firstMessage);

  const sendButton = await queries.findByRole("button", { name: "Send message" });
  await user.click(sendButton);

  await waitFor(
    () => {
      expect(window.location.hash).toMatch(/^#workspace=/);
      expect(window.location.hash).not.toBe(previousHash);
    },
    { timeout: 30000 }
  );

  const match = window.location.hash.match(/^#workspace=(.*)$/);
  if (!match) {
    throw new Error(`Expected workspace hash, got: ${window.location.hash}`);
  }

  const workspaceId = decodeURIComponent(match[1]);

  // Wait for the stream to fully settle so the test doesn't leak async work into
  // subsequent tests (MockScenarioPlayer schedules delayed events).
  await waitFor(
    () => {
      const input = queries.queryByPlaceholderText(/type a message/i);
      expect(input).toBeTruthy();
      const placeholder = input?.getAttribute("placeholder")?.toLowerCase() ?? "";
      expect(placeholder).toContain("to send");
    },
    { timeout: 30000 }
  );

  return {
    workspaceId,
    workspaceTitle: document.title.split(" - ")[0] ?? "",
  };

}

export async function selectWorkspaceById(
  user: UserEvent,
  workspaceId: string
): Promise<void> {
  await waitFor(
    () => {
      const button = document.querySelector(
        `[data-workspace-id="${workspaceId}"][aria-label^="Select workspace"]`
      );
      expect(button).toBeTruthy();
    },
    { timeout: 30000 }
  );

  const button = document.querySelector(
    `[data-workspace-id="${workspaceId}"][aria-label^="Select workspace"]`
  ) as HTMLElement;
  await user.click(button);
}

export async function removeWorkspaceById(
  user: UserEvent,
  queries: Queries,
  workspaceId: string
): Promise<void> {
  await waitFor(
    () => {
      const removeButton = document.querySelector(
        `button[data-workspace-id="${workspaceId}"][aria-label^="Remove workspace"]`
      );
      expect(removeButton).toBeTruthy();
    },
    { timeout: 30000 }
  );

  const removeButton = document.querySelector(
    `button[data-workspace-id="${workspaceId}"][aria-label^="Remove workspace"]`
  ) as HTMLButtonElement;
  await user.click(removeButton);

  // If a force delete confirmation modal appears, click it.
  try {
    const modal = await queries.findByRole("dialog");
    if (modal.textContent?.includes("Force delete")) {
      const forceDeleteButton = within(modal).getByRole("button", {
        name: /force delete/i,
      });
      await user.click(forceDeleteButton);
    }
  } catch {
    // No modal, continue
  }

  await waitFor(
    () => {
      expect(
        document.querySelector(`button[data-workspace-id="${workspaceId}"]`)
      ).toBeNull();
    },
    { timeout: 30000 }
  );
}

/**
 * Get the project name from a full path.
 */
export function getProjectName(projectPath: string): string {
  return projectPath.split("/").pop()!;
}

