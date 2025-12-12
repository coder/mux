/**
 * UI integration tests for project and workspace management.
 *
 * These tests simulate real user flows through the UI using @testing-library/react.
 * The backend is real (ServiceContainer + oRPC) but all interactions go through
 * the DOM via UI helpers. Direct oRPC calls are only used when absolutely necessary
 * (e.g., workspace creation which has no UI flow in tests).
 */

import { waitFor } from "@testing-library/react";
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
  collapseProject,
  removeProjectViaUI,
  selectWorkspace,
  removeWorkspaceViaUI,
  clickNewChat,
  getProjectName,
} from "./harness";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("Project Management UI", () => {
  describe("Adding Projects", () => {
    test("can add a project via the UI", async () => {
      const user = userEvent.setup();
      const gitRepo = await createTempGitRepo();
      const { cleanup, ...queries } = await renderWithBackend();
      try {
        await waitForAppLoad(queries);

        // Add project through the UI (opens modal, types path, submits)
        await addProjectViaUI(user, queries, gitRepo);

        // Project should now appear in sidebar
        const projectName = getProjectName(gitRepo);
        const expandButton = await queries.findByRole("button", {
          name: `Expand project ${projectName}`,
        });
        expect(expandButton).toBeInTheDocument();
      } finally {
        await cleanupTempGitRepo(gitRepo);
        await cleanup();
      }
    });

    test("can open add project modal from sidebar when project exists", async () => {
      const user = userEvent.setup();
      const gitRepo = await createTempGitRepo();
      const { cleanup, ...queries } = await renderWithBackend();
      try {
        await waitForAppLoad(queries);

        // First add a project via UI
        await addProjectViaUI(user, queries, gitRepo);

        // Now click the header "Add project" button to add another
        const addButton = await queries.findByRole("button", { name: /add project/i });
        await user.click(addButton);

        // Modal should open
        const modal = await queries.findByRole("dialog");
        expect(modal).toBeInTheDocument();
      } finally {
        await cleanupTempGitRepo(gitRepo);
        await cleanup();
      }
    });
  });

  describe("Project Display", () => {
    test("displays project name in sidebar after adding", async () => {
      const user = userEvent.setup();
      const gitRepo = await createTempGitRepo();
      const { cleanup, ...queries } = await renderWithBackend();
      try {
        await waitForAppLoad(queries);

        // Add project via UI
        await addProjectViaUI(user, queries, gitRepo);

        // Project should appear with expand button
        const projectName = getProjectName(gitRepo);
        const expandButton = await queries.findByRole("button", {
          name: `Expand project ${projectName}`,
        });
        expect(expandButton).toBeInTheDocument();
      } finally {
        await cleanupTempGitRepo(gitRepo);
        await cleanup();
      }
    });

    test("can expand and collapse project", async () => {
      const user = userEvent.setup();
      const gitRepo = await createTempGitRepo();
      const { cleanup, ...queries } = await renderWithBackend();
      try {
        await waitForAppLoad(queries);

        // Add project via UI
        await addProjectViaUI(user, queries, gitRepo);
        const projectName = getProjectName(gitRepo);

        // Expand via helper
        await expandProject(user, queries, projectName);

        // Collapse via helper
        await collapseProject(user, queries, projectName);

        // Should be back to collapsed state
        const expandButton = await queries.findByRole("button", {
          name: `Expand project ${projectName}`,
        });
        expect(expandButton).toBeInTheDocument();
      } finally {
        await cleanupTempGitRepo(gitRepo);
        await cleanup();
      }
    });
  });

  describe("Removing Projects", () => {
    test("can remove project via UI", async () => {
      const user = userEvent.setup();
      const gitRepo = await createTempGitRepo();
      const { cleanup, ...queries } = await renderWithBackend();
      try {
        await waitForAppLoad(queries);

        // Add project via UI
        await addProjectViaUI(user, queries, gitRepo);
        const projectName = getProjectName(gitRepo);

        // Remove via helper
        await removeProjectViaUI(user, queries, projectName);

        // Should show empty state
        const emptyState = await queries.findByText("No projects");
        expect(emptyState).toBeInTheDocument();
      } finally {
        await cleanupTempGitRepo(gitRepo);
        await cleanup();
      }
    });
  });
});

describeIntegration("Workspace Management UI", () => {
  // Note: Workspace creation via UI requires sending a chat message which triggers
  // an AI call. For test isolation, we use oRPC to create workspaces, but all
  // other interactions (expand, select, remove) go through the UI.

  describe("Workspace Display", () => {
    test("displays workspace under project when expanded", async () => {
      const user = userEvent.setup();
      const gitRepo = await createTempGitRepo();
      const { cleanup, env, ...queries } = await renderWithBackend();
      try {
        await waitForAppLoad(queries);

        // Add project via UI
        await addProjectViaUI(user, queries, gitRepo);
        const projectName = getProjectName(gitRepo);

        // Create workspace via oRPC (UI flow requires AI interaction)
        const result = await env.orpc.workspace.create({
          projectPath: gitRepo,
          branchName: "test-branch",
          trunkBranch: "main",
        });
        expect(result.success).toBe(true);
        if (!result.success) throw new Error("Workspace creation failed");

        // Expand project via UI helper
        await expandProject(user, queries, projectName);

        // Workspace should be visible
        const workspaceButton = await queries.findByRole("button", {
          name: `Select workspace ${result.metadata.name}`,
        });
        expect(workspaceButton).toBeInTheDocument();
      } finally {
        await cleanupTempGitRepo(gitRepo);
        await cleanup();
      }
    });

    test("displays multiple workspaces under same project", async () => {
      const user = userEvent.setup();
      const gitRepo = await createTempGitRepo();
      const { cleanup, env, ...queries } = await renderWithBackend();
      try {
        await waitForAppLoad(queries);

        // Add project via UI
        await addProjectViaUI(user, queries, gitRepo);
        const projectName = getProjectName(gitRepo);

        // Create workspaces via oRPC
        const ws1 = await env.orpc.workspace.create({
          projectPath: gitRepo,
          branchName: "feature-1",
          trunkBranch: "main",
        });
        const ws2 = await env.orpc.workspace.create({
          projectPath: gitRepo,
          branchName: "feature-2",
          trunkBranch: "main",
        });
        expect(ws1.success && ws2.success).toBe(true);
        if (!ws1.success || !ws2.success) throw new Error("Workspace creation failed");

        // Expand project via UI
        await expandProject(user, queries, projectName);

        // Both workspaces should be visible
        const workspace1 = await queries.findByRole("button", {
          name: `Select workspace ${ws1.metadata.name}`,
        });
        const workspace2 = await queries.findByRole("button", {
          name: `Select workspace ${ws2.metadata.name}`,
        });
        expect(workspace1).toBeInTheDocument();
        expect(workspace2).toBeInTheDocument();
      } finally {
        await cleanupTempGitRepo(gitRepo);
        await cleanup();
      }
    });
  });

  describe("Selecting Workspaces", () => {
    test("clicking workspace selects it", async () => {
      const user = userEvent.setup();
      const gitRepo = await createTempGitRepo();
      const { cleanup, env, ...queries } = await renderWithBackend();
      try {
        await waitForAppLoad(queries);

        // Add project via UI
        await addProjectViaUI(user, queries, gitRepo);
        const projectName = getProjectName(gitRepo);

        // Create workspace via oRPC
        const result = await env.orpc.workspace.create({
          projectPath: gitRepo,
          branchName: "test-branch",
          trunkBranch: "main",
        });
        expect(result.success).toBe(true);
        if (!result.success) throw new Error("Workspace creation failed");

        // Select workspace via UI helper
        await selectWorkspace(user, queries, projectName, result.metadata.name);

        // Workspace should still be visible after selection
        const workspaceButton = await queries.findByRole("button", {
          name: `Select workspace ${result.metadata.name}`,
        });
        expect(workspaceButton).toBeInTheDocument();
      } finally {
        await cleanupTempGitRepo(gitRepo);
        await cleanup();
      }
    });
  });

  describe("Removing Workspaces", () => {
    test("can remove workspace via UI", async () => {
      const user = userEvent.setup();
      const gitRepo = await createTempGitRepo();
      const { cleanup, env, ...queries } = await renderWithBackend();
      try {
        await waitForAppLoad(queries);

        // Add project via UI
        await addProjectViaUI(user, queries, gitRepo);
        const projectName = getProjectName(gitRepo);

        // Create workspace via oRPC
        const result = await env.orpc.workspace.create({
          projectPath: gitRepo,
          branchName: "test-branch",
          trunkBranch: "main",
        });
        expect(result.success).toBe(true);
        if (!result.success) throw new Error("Workspace creation failed");

        // Remove workspace via UI helper (handles force delete modal if needed)
        await removeWorkspaceViaUI(user, queries, projectName, result.metadata.name);

        // Workspace should no longer be visible
        expect(
          queries.queryByRole("button", { name: `Select workspace ${result.metadata.name}` })
        ).not.toBeInTheDocument();
      } finally {
        await cleanupTempGitRepo(gitRepo);
        await cleanup();
      }
    });
  });

  describe("Creating Workspaces via UI", () => {
    test("clicking + New Chat shows workspace creation UI", async () => {
      const user = userEvent.setup();
      const gitRepo = await createTempGitRepo();
      const { cleanup, ...queries } = await renderWithBackend();
      try {
        await waitForAppLoad(queries);

        // Add project via UI
        await addProjectViaUI(user, queries, gitRepo);
        const projectName = getProjectName(gitRepo);

        // Click "+ New Chat" via UI helper
        await clickNewChat(user, queries, projectName);

        // Should show chat input for new workspace creation
        const chatInput = await queries.findByPlaceholderText(/first message|create.*workspace/i);
        expect(chatInput).toBeInTheDocument();
      } finally {
        await cleanupTempGitRepo(gitRepo);
        await cleanup();
      }
    });
  });
});
