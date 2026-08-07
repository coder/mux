import "../dom";

import * as path from "node:path";
import { fireEvent, waitFor, within } from "@testing-library/react";

import {
  cleanupTestEnvironment,
  createTestEnvironment,
  preloadTestModules,
  setupProviders,
} from "../../ipc/setup";
import { cleanupTempGitRepo, createTempGitRepo, trustProject } from "../../ipc/helpers";
import { shouldRunIntegrationTests } from "../../testUtils";
import { addProjectViaUI, cleanupView } from "../helpers";
import { installDom } from "../dom";
import { renderApp } from "../renderReviewPanel";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("Project Chat (UI)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("new untrusted projects open Project Chat behind an inline trust gate", async () => {
    const env = await createTestEnvironment();
    const projectPath = await createTempGitRepo();
    await setupProviders(env, { anthropic: { apiKey: "project-chat-trust-test-key" } });
    const cleanupDom = installDom();
    const view = renderApp({ apiClient: env.orpc });

    try {
      await view.waitForReady();
      await addProjectViaUI(view, projectPath);

      const trustDialog = await waitFor(
        () => {
          if (window.location.search.includes("draft=")) {
            throw new Error("New project incorrectly entered the manual workspace draft route");
          }
          if (!view.container.querySelector('[data-testid="project-chat-trust-gate"]')) {
            throw new Error("Project Chat trust gate did not render");
          }
          const dialog = view.container.ownerDocument.body.querySelector('[role="dialog"]');
          if (!dialog || !dialog.textContent?.includes("Trust this project?")) {
            throw new Error("Project Chat trust confirmation did not render");
          }
          return dialog as HTMLElement;
        },
        { timeout: 10_000 }
      );

      fireEvent.click(within(trustDialog).getByRole("button", { name: /trust and continue/i }));
      await waitFor(
        () => {
          if (view.container.querySelector('[data-testid="project-chat-trust-gate"]')) {
            throw new Error("Project Chat remained behind the trust gate after confirmation");
          }
          if (!view.container.querySelector('[data-testid="project-chat-header"]')) {
            throw new Error("Project Chat did not open after trust confirmation");
          }
        },
        { timeout: 10_000 }
      );
    } finally {
      await cleanupView(view, cleanupDom);
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(projectPath);
    }
  }, 60_000);

  test("project row opens persistent Project Chat while plus opens a manual workspace draft", async () => {
    const env = await createTestEnvironment();
    const projectPath = await createTempGitRepo();
    await trustProject(env, projectPath);
    await setupProviders(env, { anthropic: { apiKey: "project-chat-ui-test-key" } });

    const projectChatResult = await env.orpc.projects.chat.getOrCreate({ projectPath });
    if (!projectChatResult.success) {
      throw new Error(projectChatResult.error);
    }
    const projectChatId = projectChatResult.data.sessionId;
    const projectName = path.basename(projectPath);

    const cleanupDom = installDom();
    const view = renderApp({ apiClient: env.orpc });

    try {
      await view.waitForReady();

      const projectRow = await waitFor(
        () => {
          const row = view.container.querySelector(
            `[data-project-path="${projectPath}"][aria-controls]`
          ) as HTMLElement | null;
          if (!row) throw new Error("Project row not found");
          return row;
        },
        { timeout: 10_000 }
      );
      fireEvent.click(projectRow);

      await waitFor(
        () => {
          if (!view.container.querySelector('[data-testid="project-chat-header"]')) {
            throw new Error("Project Chat did not render");
          }
          if (projectRow.getAttribute("aria-current") !== "page") {
            throw new Error("Project row is not selected");
          }
        },
        { timeout: 10_000 }
      );

      expect(view.container.querySelector(`[data-workspace-id="${projectChatId}"]`)).toBeNull();
      expect(view.container.querySelector('[data-testid="right-sidebar"]')).toBeNull();
      expect(view.container.querySelector('[data-testid="workspace-footer-bar"]')).toBeNull();
      expect(view.container.querySelector('[aria-label^="Workspace actions for"]')).toBeNull();

      const newWorkspaceButton = view.container.querySelector(
        `[aria-label="New workspace in ${projectName}"]`
      ) as HTMLElement | null;
      if (!newWorkspaceButton) {
        throw new Error("Manual workspace action not found");
      }
      fireEvent.click(newWorkspaceButton);

      await waitFor(
        () => {
          if (!window.location.search.includes("draft=")) {
            throw new Error("Manual workspace draft route did not open");
          }
          if (!view.container.querySelector("[data-component='WorkspaceNameGroup']")) {
            throw new Error("Manual workspace creation controls did not render");
          }
        },
        { timeout: 10_000 }
      );

      fireEvent.click(projectRow);
      await waitFor(
        () => {
          if (window.location.search.includes("draft=")) {
            throw new Error("Project row did not return to the base Project Chat route");
          }
          if (!view.container.querySelector('[data-testid="project-chat-header"]')) {
            throw new Error("Project Chat did not restore");
          }
        },
        { timeout: 10_000 }
      );

      const secondResolution = await env.orpc.projects.chat.getOrCreate({ projectPath });
      if (!secondResolution.success) {
        throw new Error(secondResolution.error);
      }
      expect(secondResolution.data.sessionId).toBe(projectChatId);
    } finally {
      await cleanupView(view, cleanupDom);
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(projectPath);
    }
  }, 60_000);
});
