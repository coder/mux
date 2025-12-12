/**
 * React DOM integration tests for AppLoader.
 *
 * These tests verify the initial app loading behavior and basic interactions.
 * All interactions go through the UI via helpers.
 */

import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { shouldRunIntegrationTests } from "../testUtils";
import {
  renderWithBackend,
  createTempGitRepo,
  cleanupTempGitRepo,
  waitForAppLoad,
  addProjectViaUI,
  expandProject,
  getProjectName,
} from "./harness";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("AppLoader React Integration", () => {
  describe("Initial Render", () => {
    test("shows loading screen initially then transitions to app", async () => {
      const { cleanup, getByText, ...queries } = await renderWithBackend();
      try {
        // Should show loading screen while fetching initial data
        expect(getByText(/loading workspaces/i)).toBeInTheDocument();

        // Wait for loading screen to disappear (app loaded from real backend)
        await waitForAppLoad(queries);
      } finally {
        await cleanup();
      }
    });

    test("shows empty state when no projects exist", async () => {
      const { cleanup, ...queries } = await renderWithBackend();
      try {
        await waitForAppLoad(queries);

        // With no projects, should show "No projects" text
        const emptyStateText = await queries.findByText("No projects");
        expect(emptyStateText).toBeInTheDocument();

        // And an "Add Project" button
        const addButton = await queries.findByText("Add Project");
        expect(addButton).toBeInTheDocument();
      } finally {
        await cleanup();
      }
    });
  });

  describe("Project and Workspace Display", () => {
    test("project added via UI appears in sidebar", async () => {
      const user = userEvent.setup();
      const gitRepo = await createTempGitRepo();
      const { cleanup, ...queries } = await renderWithBackend();
      try {
        await waitForAppLoad(queries);

        // Add a project via the UI
        await addProjectViaUI(user, queries, gitRepo);

        // The project should appear in the sidebar
        const projectName = getProjectName(gitRepo);
        const projectElement = await queries.findByRole("button", {
          name: `Expand project ${projectName}`,
        });
        expect(projectElement).toBeInTheDocument();
      } finally {
        await cleanupTempGitRepo(gitRepo);
        await cleanup();
      }
    });

    test("workspace appears under project when expanded", async () => {
      const user = userEvent.setup();
      const gitRepo = await createTempGitRepo();
      const { cleanup, env, ...queries } = await renderWithBackend();
      try {
        await waitForAppLoad(queries);

        // Add project via UI
        await addProjectViaUI(user, queries, gitRepo);
        const projectName = getProjectName(gitRepo);

        // Create workspace via oRPC (UI flow requires sending a chat message)
        const workspaceResult = await env.orpc.workspace.create({
          projectPath: gitRepo,
          branchName: "test-branch",
          trunkBranch: "main",
        });
        expect(workspaceResult.success).toBe(true);
        if (!workspaceResult.success) throw new Error("Workspace creation failed");

        // Expand project via UI
        await expandProject(user, queries, projectName);

        // Workspace should be visible
        const workspaceElement = await queries.findByRole("button", {
          name: `Select workspace ${workspaceResult.metadata.name}`,
        });
        expect(workspaceElement).toBeInTheDocument();
      } finally {
        await cleanupTempGitRepo(gitRepo);
        await cleanup();
      }
    });
  });

  describe("User Interactions", () => {
    test("clicking Add Project button opens modal", async () => {
      const user = userEvent.setup();
      const { cleanup, ...queries } = await renderWithBackend();
      try {
        await waitForAppLoad(queries);

        // Click the Add Project button
        const addButton = await queries.findByText("Add Project");
        await user.click(addButton);

        // Modal should appear
        const modal = await queries.findByRole("dialog");
        expect(modal).toBeInTheDocument();
      } finally {
        await cleanup();
      }
    });
  });
});
