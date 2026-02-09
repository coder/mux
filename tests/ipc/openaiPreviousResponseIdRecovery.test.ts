/**
 * OpenAI previousResponseId recovery integration test.
 *
 * This simulates a corrupted previousResponseId and verifies the runtime
 * retries the request without it so the first request succeeds.
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

const OPENAI_MODEL = modelString("openai", KNOWN_MODELS.GPT.providerModelId);
const DISABLE_TOOLS: ToolPolicy = [{ regex_match: ".*", action: "disable" }];

function createInvalidResponseId(): string {
  return `resp_${randomBytes(12).toString("hex")}`;
}

describeIntegration("OpenAI previousResponseId recovery", () => {
  configureTestRetries(3);

  test.concurrent(
    "recovers from invalid previousResponseId on the first request",
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

        const streamCollector = createStreamCollector(env.orpc, workspaceId);
        streamCollector.start();

        const result = await sendMessageWithModel(
          env,
          workspaceId,
          "Respond with DONE.",
          OPENAI_MODEL,
          {
            thinkingLevel: "medium",
            toolPolicy: DISABLE_TOOLS,
          }
        );
        expect(result.success).toBe(true);

        const streamEnd = await streamCollector.waitForEvent("stream-end", 60000);
        expect(streamEnd).toBeDefined();

        const streamErrors = streamCollector
          .getEvents()
          .filter((event) => "type" in event && event.type === "stream-error");
        expect(streamErrors.length).toBe(0);

        streamCollector.stop();
      } finally {
        await cleanup();
      }
    },
    120000
  );
});
