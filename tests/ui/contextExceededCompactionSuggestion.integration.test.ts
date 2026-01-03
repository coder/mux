/**
 * Integration test: when the backend emits a context_exceeded stream error,
 * the frontend should opportunistically suggest compacting with a larger-context model
 * (if the user has one configured).
 */

import { waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  withSharedWorkspace,
} from "../ipc/sendMessageTestHelpers";
import { installDom } from "./dom";
import { renderApp } from "./renderReviewPanel";
import { cleanupView, setupWorkspaceView } from "./helpers";
import type { APIClient } from "@/browser/contexts/API";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { setupProviders } from "../ipc/setup";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("Context exceeded compaction suggestion (UI)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("suggests /compact -m <model> when a higher-context known model is available", async () => {
    await withSharedWorkspace("openai", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      await setupProviders(env, { xai: { apiKey: "dummy" } });
      const suggestion = "/compact -m grok";

      const apiClient = env.orpc as unknown as APIClient;
      const view = renderApp({ apiClient, metadata });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Ensure the workspace view (and chat subscription) is live before sending.
        await waitFor(
          () => {
            const el = view.container.querySelector('textarea[aria-label="Message Claude"]');
            if (!el) throw new Error("Chat textarea not found");
          },
          { timeout: 10_000 }
        );

        await env.orpc.workspace.sendMessage({
          workspaceId,
          message: "Trigger context error",
          options: {
            model: KNOWN_MODELS.GPT.id,
            providerOptions: {
              openai: {
                forceContextLimitError: true,
              },
            },
          },
        });

        // Wait for the context_exceeded error to appear.
        await waitFor(
          () => {
            if (!view.container.textContent?.includes("context_exceeded")) {
              throw new Error("Expected context_exceeded stream error to be visible");
            }
          },
          { timeout: 30_000 }
        );

        // And we should render an action button for one-click retry.
        await waitFor(
          () => {
            const button = view.queryByRole("button", { name: "Retry with compaction" });
            if (!button) {
              throw new Error("Expected Retry with compaction button");
            }
          },
          { timeout: 10_000 }
        );
        // And we should offer an opportunistic compaction command using a larger-context model.
        await waitFor(
          () => {
            if (!view.container.textContent?.includes(suggestion)) {
              throw new Error(`Expected ${suggestion} suggestion`);
            }
          },
          { timeout: 10_000 }
        );
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 45_000);
});
