/**
 * Integration test: when the backend emits a context_exceeded stream error,
 * the frontend should opportunistically suggest compacting with a larger-context model
 * (if the user has one configured).
 */

import { fireEvent, waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  withSharedWorkspace,
} from "../ipc/sendMessageTestHelpers";
import { installDom } from "./dom";
import { renderApp } from "./renderReviewPanel";
import { cleanupView, setupWorkspaceView } from "./helpers";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import type { APIClient } from "@/browser/contexts/API";
import { PREFERRED_COMPACTION_MODEL_KEY } from "@/common/constants/storage";
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

  test("offers compaction in the Stream interrupted banner when a higher-context model is available", async () => {
    await withSharedWorkspace("openai", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      await setupProviders(env, { xai: { apiKey: "dummy" } });
      const expectedCompactionCommand = "/compact -m xai:grok-4-1-fast";
      const suggestedModel = "Grok";

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

        // And we should render an action button for one-click compaction + retry.
        await waitFor(
          () => {
            const button = view.queryByRole("button", { name: "Compact & retry" });
            if (!button) {
              throw new Error("Expected Compact & retry button");
            }
          },
          { timeout: 10_000 }
        );

        // Banner text should clarify that we're not switching the workspace model,
        // just compacting with a higher-context model to unblock.
        await waitFor(
          () => {
            if (!view.container.textContent?.includes("workspace model stays the same")) {
              throw new Error("Expected compaction banner to clarify model is unchanged");
            }
            if (!view.container.textContent?.includes(suggestedModel)) {
              throw new Error(`Expected compaction banner to mention ${suggestedModel}`);
            }
          },
          { timeout: 10_000 }
        );

        // Clicking the CTA should actually send a compaction request message.
        // We assert on the rendered /compact command (from muxMetadata.rawCommand).
        const button = view.getByRole("button", { name: "Compact & retry" });
        if (view.container.textContent?.includes(expectedCompactionCommand)) {
          throw new Error("Compaction command should not be present before clicking");
        }
        fireEvent.click(button);

        await waitFor(
          () => {
            if (!view.container.textContent?.includes(expectedCompactionCommand)) {
              throw new Error(`Expected compaction command: ${expectedCompactionCommand}`);
            }
          },
          { timeout: 10_000 }
        );
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 45_000);

  test("prefers the configured compaction model when context is exceeded", async () => {
    await withSharedWorkspace("openai", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      await setupProviders(env, { anthropic: { apiKey: "dummy" }, xai: { apiKey: "dummy" } });
      updatePersistedState(PREFERRED_COMPACTION_MODEL_KEY, KNOWN_MODELS.HAIKU.id);

      const expectedCompactionCommand = `/compact -m ${KNOWN_MODELS.HAIKU.id}`;
      const suggestedModel = "Haiku";

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

        // And we should render an action button for one-click compaction + retry.
        await waitFor(
          () => {
            const button = view.queryByRole("button", { name: "Compact & retry" });
            if (!button) {
              throw new Error("Expected Compact & retry button");
            }
          },
          { timeout: 10_000 }
        );

        await waitFor(
          () => {
            if (!view.container.textContent?.includes("configured compaction model")) {
              throw new Error("Expected compaction banner to mention configured compaction model");
            }
            if (!view.container.textContent?.includes("workspace model stays the same")) {
              throw new Error("Expected compaction banner to clarify model is unchanged");
            }
            if (!view.container.textContent?.includes(suggestedModel)) {
              throw new Error(`Expected compaction banner to mention ${suggestedModel}`);
            }
          },
          { timeout: 10_000 }
        );

        // Clicking the CTA should actually send a compaction request message.
        // We assert on the rendered /compact command (from muxMetadata.rawCommand).
        const button = view.getByRole("button", { name: "Compact & retry" });
        if (view.container.textContent?.includes(expectedCompactionCommand)) {
          throw new Error("Compaction command should not be present before clicking");
        }
        fireEvent.click(button);

        await waitFor(
          () => {
            if (!view.container.textContent?.includes(expectedCompactionCommand)) {
              throw new Error(`Expected compaction command: ${expectedCompactionCommand}`);
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
