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
import { getModelStats } from "@/common/utils/tokens/modelStats";

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
            if (!args.options) {
              return originalSendMessage.call(workspace, args);
            }

            return originalSendMessage.call(workspace, {
              ...args,
              options: {
                ...args.options,
                providerOptions: {
                  ...args.options.providerOptions,
                  openai: {
                    ...(args.options.providerOptions?.openai ?? {}),
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

type KnownModel = (typeof KNOWN_MODELS)[keyof typeof KNOWN_MODELS];

function pickOpenAIContextUpgrade(): { currentModelId: string; suggestion: string } {
  const openaiModels: Array<{ model: KnownModel; maxInputTokens: number }> = [];

  for (const model of Object.values(KNOWN_MODELS)) {
    if (model.provider !== "openai") {
      continue;
    }

    const stats = getModelStats(model.id);
    if (!stats?.max_input_tokens) {
      continue;
    }

    openaiModels.push({ model, maxInputTokens: stats.max_input_tokens });
  }

  openaiModels.sort((a, b) => a.maxInputTokens - b.maxInputTokens);

  if (openaiModels.length < 2) {
    throw new Error("Test requires at least two OpenAI KNOWN_MODELS with model stats");
  }

  const current = openaiModels[0];
  const best = openaiModels[openaiModels.length - 1];
  if (best.maxInputTokens <= current.maxInputTokens) {
    throw new Error("Test requires an OpenAI model with a strictly larger context window");
  }

  const modelArg = best.model.aliases?.[0] ?? best.model.id;
  return {
    currentModelId: current.model.id,
    suggestion: `/compact -m ${modelArg}`,
  };
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

      const { currentModelId, suggestion } = pickOpenAIContextUpgrade();
      updatePersistedState(getModelKey(workspaceId), currentModelId);

      const apiClient = createForceContextExceededClient(env.orpc as unknown as APIClient);
      const view = renderApp({ apiClient, metadata });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        const textarea = await waitFor(
          () => {
            const el = view.container.querySelector('textarea[aria-label="Message Claude"]');
            if (!el) throw new Error("Chat textarea not found");
            return el as HTMLTextAreaElement;
          },
          { timeout: 10_000 }
        );

        fireEvent.change(textarea, { target: { value: "Trigger context error" } });
        fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });

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
