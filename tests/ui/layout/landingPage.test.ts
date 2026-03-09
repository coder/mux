/**
 * UI integration tests for the LandingPage component.
 *
 * The landing page is the default startup view — users see gateway credits,
 * 7-day stats, and recent workspaces before explicitly choosing a workspace.
 * No auto-navigation to mux-chat or any other workspace occurs on startup.
 */

import "../dom";
import { waitFor } from "@testing-library/react";

import { preloadTestModules, createTestEnvironment, cleanupTestEnvironment } from "../../ipc/setup";
import { cleanupTempGitRepo, createTempGitRepo } from "../../ipc/helpers";
import { installDom } from "../dom";
import { renderApp } from "../renderReviewPanel";
import { cleanupView } from "../helpers";

/** Wait for the app to get past the splash screen. */
async function waitForReady(view: ReturnType<typeof renderApp>) {
  await waitFor(
    () => {
      const text = view.container.textContent || "";
      if (text.includes("Loading Mux")) {
        throw new Error("Still on splash screen");
      }
    },
    { timeout: 30_000 }
  );
}

describe("LandingPage", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("renders landing page with stats on startup — no auto-navigate to workspace", async () => {
    const repoPath = await createTempGitRepo();
    const env = await createTestEnvironment();
    env.services.aiService.enableMockMode();
    const cleanupDom = installDom();
    const view = renderApp({ apiClient: env.orpc });

    try {
      await waitForReady(view);

      // Landing page stats row should be visible
      await waitFor(
        () => {
          const statsRow = view.container.querySelector('[data-testid="session-stats-row"]');
          if (!statsRow) {
            throw new Error("Session stats row not found");
          }
        },
        { timeout: 10_000 }
      );

      // No workspace should be auto-selected (no message window)
      const messageWindow = view.container.querySelector('[data-testid="message-window"]');
      expect(messageWindow).toBeNull();

      // Old "Welcome to Mux" text should not be present
      expect(view.container.textContent).not.toContain("Welcome to Mux");

      // Verify stat card labels
      const statsText =
        view.container.querySelector('[data-testid="session-stats-row"]')?.textContent || "";
      expect(statsText).toContain("Total Spend");
      expect(statsText).toContain("Today");
      expect(statsText).toContain("Total Tokens");
      expect(statsText).toContain("Responses");
    } finally {
      await cleanupView(view, cleanupDom);
      await cleanupTempGitRepo(repoPath);
      await cleanupTestEnvironment(env);
    }
  }, 60_000);
});
