import { setupWorkspace, shouldRunIntegrationTests, validateApiKeys } from "./setup";
import {
  sendMessageWithModel,
  createStreamCollector,
  modelString,
  assertStreamSuccess,
} from "./helpers";
import { isUsageDelta } from "../../src/common/orpc/types";
import { KNOWN_MODELS } from "../../src/common/constants/knownModels";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

describeIntegration("usage-delta events", () => {
  // Enable retries in CI for flaky API tests
  if (process.env.CI && typeof jest !== "undefined" && jest.retryTimes) {
    jest.retryTimes(3, { logErrorsBeforeRetry: true });
  }

  // Only test with Anthropic - more reliable multi-step behavior
  test.concurrent(
    "should emit usage-delta events during multi-step tool call streams",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      const collector = createStreamCollector(env.orpc, workspaceId);
      collector.start();

      try {
        // Ask the model to read a file - guaranteed to trigger tool use
        const result = await sendMessageWithModel(
          env,
          workspaceId,
          "Use the file_read tool to read README.md. Only read the first 5 lines.",
          modelString("anthropic", KNOWN_MODELS.SONNET.providerModelId)
        );

        expect(result.success).toBe(true);

        // Wait for stream completion
        await collector.waitForEvent("stream-end", 15000);

        // Verify usage-delta events were emitted
        const allEvents = collector.getEvents();
        const usageDeltas = allEvents.filter(isUsageDelta);

        // Multi-step stream should emit at least one usage-delta (on finish-step)
        expect(usageDeltas.length).toBeGreaterThan(0);

        // Each usage-delta should have valid usage data
        for (const delta of usageDeltas) {
          expect(delta.usage).toBeDefined();
          // inputTokens should be present and > 0 (full context)
          expect(delta.usage.inputTokens).toBeGreaterThan(0);
          // outputTokens may be 0 for some steps, but should be defined
          expect(typeof delta.usage.outputTokens).toBe("number");
        }

        // Verify stream completed successfully
        assertStreamSuccess(collector);
      } finally {
        collector.stop();
        await cleanup();
      }
    },
    30000
  );
});
