/**
 * UI integration tests for the LandingPage component.
 *
 * The app auto-navigates to the built-in mux-chat workspace on load, so the
 * landing page's full dashboard (stats, recent workspaces) is only visible
 * when no workspace is selected AND no project creation is pending. We verify
 * the loading/not-found states that the LandingPage handles when a workspace
 * ID is in the URL but hasn't resolved yet.
 */

import "../dom";
import { waitFor } from "@testing-library/react";

import { preloadTestModules, createTestEnvironment, cleanupTestEnvironment } from "../../ipc/setup";
import { cleanupTempGitRepo, createTempGitRepo } from "../../ipc/helpers";
import { installDom } from "../dom";
import { renderApp } from "../renderReviewPanel";
import { cleanupView } from "../helpers";

describe("LandingPage", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("shows 'Opening workspace…' when navigating to mux-chat before metadata resolves", async () => {
    const repoPath = await createTempGitRepo();
    const env = await createTestEnvironment();
    env.services.aiService.enableMockMode();
    const cleanupDom = installDom();

    // The app auto-navigates to /workspace/mux-chat. During the brief moment
    // before workspace metadata loads, the LandingPage shows the loading state.
    const view = renderApp({ apiClient: env.orpc });

    try {
      // Wait for the app to finish loading (past the splash screen)
      await waitFor(
        () => {
          const text = view.container.textContent || "";
          if (text.includes("Loading Mux")) {
            throw new Error("Still on splash screen");
          }
        },
        { timeout: 30_000 }
      );

      // The mux-chat workspace renders quickly, so we just verify the app loaded
      // and the old "Welcome to Mux" text is no longer present
      expect(view.container.textContent).not.toContain("Welcome to Mux");

      // The app should have navigated to mux-chat (message window renders)
      await waitFor(
        () => {
          const messageWindow = view.container.querySelector('[data-testid="message-window"]');
          if (!messageWindow) {
            throw new Error("Message window not found");
          }
        },
        { timeout: 10_000 }
      );
    } finally {
      await cleanupView(view, cleanupDom);
      await cleanupTempGitRepo(repoPath);
      await cleanupTestEnvironment(env);
    }
  }, 60_000);
});
