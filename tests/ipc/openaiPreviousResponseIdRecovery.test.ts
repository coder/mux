/**
 * OpenAI previousResponseId recovery integration test.
 *
 * This simulates a corrupted previousResponseId and verifies the runtime
 * records it as lost so subsequent requests recover successfully.
 */

import { randomBytes } from "crypto";
import { setupWorkspace, shouldRunIntegrationTests, validateApiKeys } from "./setup";
import {
  sendMessageWithModel,
  createStreamCollector,
  modelString,
  configureTestRetries,
} from "./helpers";
import { KNOWN_MODELS } from "../../src/common/constants/knownModels";
import type { ToolPolicy } from "../../src/common/utils/tools/toolPolicy";
import { createMuxMessage } from "../../src/common/types/message";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["OPENAI_API_KEY"]);
}

const OPENAI_MODEL = modelString("openai", KNOWN_MODELS.GPT_MINI.providerModelId);
const DISABLE_TOOLS: ToolPolicy = [{ regex_match: ".*", action: "disable" }];

function createInvalidResponseId(): string {
  return `resp_${randomBytes(12).toString("hex")}`;
}

describeIntegration("OpenAI previousResponseId recovery", () => {
  configureTestRetries(3);

  test.concurrent(
    "filters invalid previousResponseId after OpenAI rejects it",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("openai");

      try {
        const invalidResponseId = createInvalidResponseId();
        const summaryMessage = createMuxMessage(
          `summary-${Date.now()}`,
          "assistant",
          "Summary placeholder for previousResponseId recovery.",
          {
            timestamp: Date.now(),
            model: OPENAI_MODEL,
            mode: "exec",
            providerMetadata: {
              openai: {
                responseId: invalidResponseId,
              },
            },
          }
        );

        const replaceResult = await env.orpc.workspace.replaceChatHistory({
          workspaceId,
          summaryMessage,
        });
        expect(replaceResult.success).toBe(true);

        const errorCollector = createStreamCollector(env.orpc, workspaceId);
        errorCollector.start();

        const errorResult = await sendMessageWithModel(env, workspaceId, "Say OK.", OPENAI_MODEL, {
          thinkingLevel: "medium",
          toolPolicy: DISABLE_TOOLS,
        });
        expect(errorResult.success).toBe(true);

        const errorEvent = await errorCollector.waitForEvent("stream-error", 60000);
        expect(errorEvent).toBeDefined();
        if (errorEvent?.type === "stream-error") {
          expect(errorEvent.error).toContain(invalidResponseId);
        }
        errorCollector.stop();

        const recoveryCollector = createStreamCollector(env.orpc, workspaceId);
        recoveryCollector.start();

        const recoveryResult = await sendMessageWithModel(
          env,
          workspaceId,
          "Respond with DONE.",
          OPENAI_MODEL,
          {
            thinkingLevel: "medium",
            toolPolicy: DISABLE_TOOLS,
          }
        );
        expect(recoveryResult.success).toBe(true);

        const recoveryEnd = await recoveryCollector.waitForEvent("stream-end", 60000);
        expect(recoveryEnd).toBeDefined();

        const recoveryErrors = recoveryCollector
          .getEvents()
          .filter((event) => "type" in event && event.type === "stream-error");
        expect(recoveryErrors.length).toBe(0);

        recoveryCollector.stop();
      } finally {
        await cleanup();
      }
    },
    120000
  );
});
