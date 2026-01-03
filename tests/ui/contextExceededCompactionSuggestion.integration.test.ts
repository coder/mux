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
import type { APIClient } from "@/browser/contexts/API";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getModelKey } from "@/common/constants/storage";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { setupProviders } from "../ipc/setup";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

function createForceContextExceededClient(client: APIClient): APIClient {
  // NOTE: env.orpc is a RouterClient (Proxy-like). Avoid object spreads here,
  // since they may drop non-enumerable/proxied fields.
  const workspace = client.workspace;
  const originalSendMessage = workspace.sendMessage;
  type SendMessageArgs = Parameters<APIClient["workspace"]["sendMessage"]>[0];

  return new Proxy(client as unknown as Record<string, unknown>, {
    get(target, prop, receiver) {
      if (prop !== "workspace") {
        return Reflect.get(target, prop, receiver);
      }

      return new Proxy(workspace as unknown as Record<string, unknown>, {
        get(workspaceTarget, workspaceProp) {
          if (workspaceProp !== "sendMessage") {
            return Reflect.get(workspaceTarget, workspaceProp);
          }

          return async (args: SendMessageArgs) => {
            const model = args.options?.model ?? KNOWN_MODELS.GPT.id;

            return originalSendMessage.call(workspace, {
              ...args,
              options: {
                ...(args.options ?? { model }),
                model,
                providerOptions: {
                  ...(args.options?.providerOptions ?? {}),
                  openai: {
                    ...(args.options?.providerOptions?.openai ?? {}),
                    forceContextLimitError: true,
                  },
                },
              },
            });
          };
        },
      });
    },
  }) as unknown as APIClient;
}

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
      updatePersistedState(getModelKey(workspaceId), KNOWN_MODELS.GPT.id);
      const suggestion = "/compact -m grok";

      const apiClient = createForceContextExceededClient(env.orpc as unknown as APIClient);
      const view = renderApp({ apiClient, metadata });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        const textarea = await waitFor(
          () => {
            const el = view.container.querySelector('textarea[aria-label="Message Claude"]');
            if (!el) throw new Error("Chat textarea not found");
            if ((el as HTMLTextAreaElement).disabled) {
              throw new Error("Chat textarea is disabled");
            }
            return el as HTMLTextAreaElement;
          },
          { timeout: 10_000 }
        );

        fireEvent.input(textarea, { target: { value: "Trigger context error" } });

        await waitFor(
          () => {
            if (textarea.value !== "Trigger context error") {
              throw new Error("Textarea value did not update");
            }
          },
          { timeout: 10_000 }
        );

        const sendButton = await waitFor(
          () => {
            const el = view.container.querySelector('button[aria-label="Send message"]');
            if (!el) throw new Error("Send button not found");
            if ((el as HTMLButtonElement).disabled) {
              throw new Error("Send button is disabled");
            }
            return el as HTMLButtonElement;
          },
          { timeout: 10_000 }
        );
        fireEvent.click(sendButton);

        // Wait for the context_exceeded error to appear.
        await waitFor(
          () => {
            if (!view.container.textContent?.includes("context_exceeded")) {
              throw new Error("Expected context_exceeded stream error to be visible");
            }
          },
          { timeout: 30_000 }
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
