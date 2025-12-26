/**
 * UI integration tests for project error handling.
 */

import { waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { shouldRunIntegrationTests } from "../../testUtils";
import {
  renderWithBackend,
  createTempGitRepo,
  cleanupTempGitRepo,
  waitForAppLoad,
  addProjectViaUI,
  createWorkspaceViaUI,
  getProjectName,
} from "../harness";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("Projects", () => {
  test("removing a project with active workspaces shows an error", async () => {
    const user = userEvent.setup();
    const gitRepo = await createTempGitRepo();

    const { cleanup, ...queries } = await renderWithBackend();
    try {
      await waitForAppLoad(queries);

      await addProjectViaUI(user, queries, gitRepo);
      const projectName = getProjectName(gitRepo);

      await createWorkspaceViaUI(user, queries, projectName, { workspaceName: "ws-1" });
      await createWorkspaceViaUI(user, queries, projectName, { workspaceName: "ws-2" });

      // The remove button is typically shown on hover.
      await waitFor(() => {
        const btn = document.querySelector(`button[aria-label="Remove project ${projectName}"]`);
        expect(btn).toBeTruthy();
      });

      const removeButton = document.querySelector(
        `button[aria-label="Remove project ${projectName}"]`
      ) as HTMLElement;
      const projectRow = removeButton.closest("[data-project-path]") as HTMLElement | null;
      expect(projectRow).toBeTruthy();

      await user.hover(projectRow!);
      await waitFor(() => {
        expect(removeButton).toBeVisible();
      });

      await user.click(removeButton);

      const alert = await queries.findByRole("alert");
      expect(alert).toHaveTextContent(
        /cannot remove project with active workspaces\. please remove all 2 workspace\(s\) first\./i
      );
    } finally {
      await cleanupTempGitRepo(gitRepo);
      await cleanup();
    }
  });
});
