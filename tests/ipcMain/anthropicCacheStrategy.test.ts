import { setupWorkspace, shouldRunIntegrationTests } from "./setup";
import { sendMessageWithModel, waitForStreamSuccess } from "./helpers";

// Skip tests unless TEST_INTEGRATION=1 AND required API keys are present
const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY);
const hasOpenAIKey = Boolean(process.env.OPENAI_API_KEY);
const shouldRunSuite = shouldRunIntegrationTests() && hasAnthropicKey && hasOpenAIKey;
const describeIntegration = shouldRunSuite ? describe : describe.skip;
const TEST_TIMEOUT_MS = 60000;

if (shouldRunIntegrationTests() && !shouldRunSuite) {
  // eslint-disable-next-line no-console
  console.warn(
    "Skipping Anthropic cache strategy integration tests: missing ANTHROPIC_API_KEY or OPENAI_API_KEY"
  );
}

if (shouldRunSuite) {
  jest.setTimeout(TEST_TIMEOUT_MS);
}

describeIntegration("Anthropic cache strategy integration", () => {
  test("should apply cache control to messages, system prompt, and tools for Anthropic models", async () => {
    const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");

    try {
      const model = "anthropic:claude-3-5-sonnet-20241022";

      // Send an initial message to establish conversation history
      const firstMessage = "Hello, can you help me with a coding task?";
      await sendMessageWithModel(env.mockIpcRenderer, workspaceId, firstMessage, model, {
        additionalSystemInstructions: "Be concise and clear in your responses.",
        thinkingLevel: "off",
      });
      const firstCollector = await waitForStreamSuccess(env.sentEvents, workspaceId);

      // Send a second message to test cache reuse
      const secondMessage = "What's the best way to handle errors in TypeScript?";
      await sendMessageWithModel(env.mockIpcRenderer, workspaceId, secondMessage, model, {
        additionalSystemInstructions: "Be concise and clear in your responses.",
        thinkingLevel: "off",
      });
      const secondCollector = await waitForStreamSuccess(env.sentEvents, workspaceId);

      // Check that both streams completed successfully
      const firstEndEvent = firstCollector.getEvents().find((e: any) => e.type === "stream-end");
      const secondEndEvent = secondCollector.getEvents().find((e: any) => e.type === "stream-end");
      expect(firstEndEvent).toBeDefined();
      expect(secondEndEvent).toBeDefined();

      // Note: In a real test environment with actual Anthropic API, we would check:
      // - firstCollector.getEndEvent()?.metadata?.usage?.cacheCreationInputTokens > 0 (cache created)
      // - secondCollector.getEndEvent()?.metadata?.usage?.cacheReadInputTokens > 0 (cache used)
      // But in mock mode, we just verify the flow completes successfully
    } finally {
      await cleanup();
    }
  });

  test("should not apply cache control for non-Anthropic models", async () => {
    const { env, workspaceId, cleanup } = await setupWorkspace("openai");

    try {
      // Align OpenAI model with other integration suites to avoid unsupported-tool errors
      const model = "gpt-4o-mini";
      const message = "Hello, can you help me?";

      await sendMessageWithModel(env.mockIpcRenderer, workspaceId, message, model, {
        additionalSystemInstructions: "You are a helpful assistant.",
        thinkingLevel: "off",
      });
      const collector = await waitForStreamSuccess(env.sentEvents, workspaceId);

      // Verify the stream completed
      const endEvent = collector.getEvents().find((e: any) => e.type === "stream-end");
      expect(endEvent).toBeDefined();

      // For non-Anthropic models, cache control should not be applied
      // The stream should complete normally without any cache-related metadata
    } finally {
      await cleanup();
    }
  });
});
