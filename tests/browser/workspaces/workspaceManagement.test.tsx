/**
 * UI integration tests for workspace management.
 */

import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { shouldRunIntegrationTests } from "../../testUtils";
import {
  renderWithBackend,
  createTempGitRepo,
  cleanupTempGitRepo,
  waitForAppLoad,
  addProjectViaUI,
  ensureProjectExpanded,
  createWorkspaceViaUI,
  selectWorkspaceById,
  removeWorkspaceById,
  clickNewChat,
  getProjectName,
} from "../harness";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("Workspaces", () => {
  describe("Workspace Display", () => {
    test("displays workspace under project when expanded", async () => {
      const user = userEvent.setup();
      const gitRepo = await createTempGitRepo();
      const { cleanup, ...queries } = await renderWithBackend();
      try {
        await waitForAppLoad(queries);

        await addProjectViaUI(user, queries, gitRepo);
        const projectName = getProjectName(gitRepo);

        const ws = await createWorkspaceViaUI(user, queries, projectName, {
          workspaceName: "test-branch",
        });

        await ensureProjectExpanded(user, queries, projectName);

        expect(
          document.querySelector(`button[data-workspace-id="${ws.workspaceId}"]`)
        ).toBeTruthy();
      } finally {
        await cleanupTempGitRepo(gitRepo);
        await cleanup();
      }
    });

    test("displays multiple workspaces under same project", async () => {
      const user = userEvent.setup();
      const gitRepo = await createTempGitRepo();
      const { cleanup, ...queries } = await renderWithBackend();
      try {
        await waitForAppLoad(queries);

        await addProjectViaUI(user, queries, gitRepo);
        const projectName = getProjectName(gitRepo);

        const ws1 = await createWorkspaceViaUI(user, queries, projectName, {
          workspaceName: "feature-1",
        });
        const ws2 = await createWorkspaceViaUI(user, queries, projectName, {
          workspaceName: "feature-2",
        });

        await ensureProjectExpanded(user, queries, projectName);

        expect(
          document.querySelector(`button[data-workspace-id="${ws1.workspaceId}"]`)
        ).toBeTruthy();
        expect(
          document.querySelector(`button[data-workspace-id="${ws2.workspaceId}"]`)
        ).toBeTruthy();
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
      const { cleanup, ...queries } = await renderWithBackend();
      try {
        await waitForAppLoad(queries);

        await addProjectViaUI(user, queries, gitRepo);
        const projectName = getProjectName(gitRepo);

        const ws = await createWorkspaceViaUI(user, queries, projectName, {
          workspaceName: "test-branch",
        });

        await selectWorkspaceById(user, ws.workspaceId);

        expect(
          await queries.findByPlaceholderText(/type a message/i)
        ).toBeInTheDocument();
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
      const { cleanup, ...queries } = await renderWithBackend();
      try {
        await waitForAppLoad(queries);

        await addProjectViaUI(user, queries, gitRepo);
        const projectName = getProjectName(gitRepo);

        const ws = await createWorkspaceViaUI(user, queries, projectName, {
          workspaceName: "test-branch",
        });

        await removeWorkspaceById(user, queries, ws.workspaceId);

        expect(
          document.querySelector(`button[data-workspace-id="${ws.workspaceId}"]`)
        ).toBeNull();
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

        await addProjectViaUI(user, queries, gitRepo);
        const projectName = getProjectName(gitRepo);

        await clickNewChat(user, queries, projectName);

        const chatInput = await queries.findByPlaceholderText(
          /type your first message to create a workspace/i
        );
        expect(chatInput).toBeInTheDocument();
      } finally {
        await cleanupTempGitRepo(gitRepo);
        await cleanup();
      }
    });
  });
});
