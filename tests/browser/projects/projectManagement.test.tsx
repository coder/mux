/**
 * UI integration tests for project management.
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
  expandProject,
  collapseProject,
  removeProjectViaUI,
  getProjectName,
} from "../harness";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("Projects", () => {
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
