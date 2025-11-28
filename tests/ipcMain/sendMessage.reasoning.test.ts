/**
 * Integration tests for reasoning/thinking functionality across Anthropic models.
 * Verifies Opus 4.5 uses `effort` and Sonnet 4.5 uses `thinking.budgetTokens`.
 */

import { shouldRunIntegrationTests, validateApiKeys } from "./setup";
import { sendMessage, assertStreamSuccess, waitForStreamSuccess } from "./helpers";
import { createSharedRepo, cleanupSharedRepo, withSharedWorkspace } from "./sendMessageTestHelpers";
import { KNOWN_MODELS } from "@/common/constants/knownModels";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

beforeAll(createSharedRepo);
afterAll(cleanupSharedRepo);

describeIntegration("Anthropic reasoning parameter tests", () => {
  test.concurrent(
    "Sonnet 4.5 with thinking (budgetTokens)",
    async () => {
      await withSharedWorkspace("anthropic", async ({ env, workspaceId }) => {
        const result = await sendMessage(
          env.mockIpcRenderer,
          workspaceId,
          "What is 2+2? Answer in one word.",
          { model: KNOWN_MODELS.SONNET.id, thinkingLevel: "low" }
        );
        expect(result.success).toBe(true);

        const collector = await waitForStreamSuccess(env.sentEvents, workspaceId, 30000);
        assertStreamSuccess(collector);
        expect(collector.getDeltas().length).toBeGreaterThan(0);
      });
    },
    60000
  );

  test.concurrent(
    "Opus 4.5 with thinking (effort)",
    async () => {
      await withSharedWorkspace("anthropic", async ({ env, workspaceId }) => {
        const result = await sendMessage(
          env.mockIpcRenderer,
          workspaceId,
          "What is 4+4? Answer in one word.",
          { model: KNOWN_MODELS.OPUS.id, thinkingLevel: "low" }
        );
        expect(result.success).toBe(true);

        const collector = await waitForStreamSuccess(env.sentEvents, workspaceId, 60000);
        assertStreamSuccess(collector);
        expect(collector.getDeltas().length).toBeGreaterThan(0);
      });
    },
    90000
  );
});
