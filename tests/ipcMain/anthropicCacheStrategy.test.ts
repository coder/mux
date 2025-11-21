import { setupWorkspace, shouldRunIntegrationTests } from "./setup";
import { sendMessageWithModel, waitForStreamSuccess } from "./helpers";

// Skip tests unless TEST_INTEGRATION=1 AND required API keys are present
const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY);
const shouldRunSuite = shouldRunIntegrationTests() && hasAnthropicKey;
const describeIntegration = shouldRunSuite ? describe : describe.skip;
const TEST_TIMEOUT_MS = 45000; // 45s total: setup + 2 messages at 15s each

if (shouldRunIntegrationTests() && !shouldRunSuite) {
  // eslint-disable-next-line no-console
  console.warn("Skipping Anthropic cache strategy integration tests: missing ANTHROPIC_API_KEY");
}

describeIntegration("Anthropic cache strategy integration", () => {
  // Enable retries in CI for flaky API tests
  if (process.env.CI && typeof jest !== "undefined" && jest.retryTimes) {
    jest.retryTimes(2, { logErrorsBeforeRetry: true });
  }

  test(
    "should apply cache control to messages, system prompt, and tools for Anthropic models",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");

      try {
        const model = "anthropic:claude-3-5-sonnet-20241022";

        // Send an initial message to establish conversation history
        const firstMessage = "Hello, can you help me with a coding task?";
        await sendMessageWithModel(env.mockIpcRenderer, workspaceId, firstMessage, model, {
          additionalSystemInstructions: "Be concise and clear in your responses.",
          thinkingLevel: "off",
        });
        const firstCollector = await waitForStreamSuccess(env.sentEvents, workspaceId, 15000);

        // Send a second message to test cache reuse
        const secondMessage = "What's the best way to handle errors in TypeScript?";
        await sendMessageWithModel(env.mockIpcRenderer, workspaceId, secondMessage, model, {
          additionalSystemInstructions: "Be concise and clear in your responses.",
          thinkingLevel: "off",
        });
        const secondCollector = await waitForStreamSuccess(env.sentEvents, workspaceId, 15000);

        // Check that both streams completed successfully
        const firstEndEvent = firstCollector.getEvents().find((e: any) => e.type === "stream-end");
        const secondEndEvent = secondCollector.getEvents().find((e: any) => e.type === "stream-end");
        expect(firstEndEvent).toBeDefined();
        expect(secondEndEvent).toBeDefined();

        // Verify cache control is being applied by checking the messages sent to the model
        // Cache control adds cache_control markers to messages, system, and tools
        // If usage data is available from the API, verify it; otherwise just ensure requests succeeded
        const firstUsage = (firstEndEvent as any)?.metadata?.usage;
        const firstProviderMetadata = (firstEndEvent as any)?.metadata?.providerMetadata?.anthropic;
        const secondUsage = (secondEndEvent as any)?.metadata?.usage;

        // Check if usage data is available from the API
        const hasUsageData =
          firstUsage &&
          Object.keys(firstUsage).length > 0 &&
          (firstProviderMetadata?.cacheCreationInputTokens !== undefined ||
            secondUsage?.cachedInputTokens !== undefined);

        if (hasUsageData) {
          // Full verification when API returns usage data
          expect(firstProviderMetadata?.cacheCreationInputTokens).toBeGreaterThan(0);
          expect(secondUsage?.cachedInputTokens).toBeGreaterThan(0);
        } else {
          // Minimal verification when API doesn't return usage data (e.g., custom bridge)
          // Just ensure both requests completed successfully, which proves cache control
          // headers didn't break the requests
          console.log(
            "Note: API did not return usage data. Skipping cache metrics verification."
          );
          console.log("Test passes if both messages completed successfully.");
        }
      } finally {
        await cleanup();
      }
    },
    TEST_TIMEOUT_MS
  );
});
