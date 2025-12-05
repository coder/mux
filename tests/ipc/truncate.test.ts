import { setupWorkspace, shouldRunIntegrationTests, validateApiKeys } from "./setup";
import {
  sendMessageWithModel,
  createStreamCollector,
  assertStreamSuccess,
  resolveOrpcClient,
} from "./helpers";
import { HistoryService } from "../../src/node/services/historyService";
import { createMuxMessage } from "../../src/common/types/message";
import type { DeleteMessage } from "@/common/orpc/types";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

describeIntegration("truncateHistory", () => {
  test.concurrent(
    "should truncate 50% of chat history and verify context is updated",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      try {
        const historyService = new HistoryService(env.config);

        // Prepopulate chat with messages (avoid API calls)
        // Create messages with a unique word in the first message
        const uniqueWord = `testword-${Date.now()}`;
        const messages = [
          createMuxMessage("msg-1", "user", `Remember this word: ${uniqueWord}`, {}),
          createMuxMessage("msg-2", "assistant", "I will remember that word.", {}),
          createMuxMessage("msg-3", "user", "What is 2+2?", {}),
          createMuxMessage("msg-4", "assistant", "4", {}),
          createMuxMessage("msg-5", "user", "What is 3+3?", {}),
          createMuxMessage("msg-6", "assistant", "6", {}),
        ];

        // Append messages to history
        for (const msg of messages) {
          const result = await historyService.appendToHistory(workspaceId, msg);
          expect(result.success).toBe(true);
        }

        // Setup collector for delete message verification
        const deleteCollector = createStreamCollector(env.orpc, workspaceId);
        deleteCollector.start();

        // Truncate 50% of history
        const client = resolveOrpcClient(env);
        const truncateResult = await client.workspace.truncateHistory({
          workspaceId,
          percentage: 0.5,
        });
        expect(truncateResult.success).toBe(true);

        // Wait for DeleteMessage to be sent
        const deleteEvent = await deleteCollector.waitForEvent("delete", 5000);
        expect(deleteEvent).toBeDefined();
        deleteCollector.stop();

        // Verify some historySequences were deleted
        const deleteMsg = deleteEvent as DeleteMessage;
        expect(deleteMsg.historySequences.length).toBeGreaterThan(0);

        // Setup collector for verification message
        const collector = createStreamCollector(env.orpc, workspaceId);
        collector.start();

        // Send a message asking AI to repeat the word from the beginning
        // This should fail or return "I don't know" because context was truncated
        const result = await sendMessageWithModel(
          env,
          workspaceId,
          "What was the word I asked you to remember at the beginning? Reply with just the word or 'I don't know'."
        );

        expect(result.success).toBe(true);

        // Wait for response
        await collector.waitForEvent("stream-end", 10000);
        assertStreamSuccess(collector);

        // Get response content
        const finalMessage = collector.getFinalMessage();
        expect(finalMessage).toBeDefined();

        if (finalMessage && "parts" in finalMessage && Array.isArray(finalMessage.parts)) {
          const content = finalMessage.parts
            .filter((part) => part.type === "text")
            .map((part) => (part as { text: string }).text)
            .join("");

          // The word should NOT be in the response (context was truncated)
          // AI should say it doesn't know or doesn't have that information
          expect(content.toLowerCase()).not.toContain(uniqueWord.toLowerCase());
        }
        collector.stop();
      } finally {
        await cleanup();
      }
    },
    30000
  );

  test.concurrent(
    "should truncate 100% of chat history and verify context is cleared",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      try {
        const historyService = new HistoryService(env.config);

        // Prepopulate chat with messages (avoid API calls)
        const uniqueWord = `testword-${Date.now()}`;
        const messages = [
          createMuxMessage("msg-1", "user", `Remember this word: ${uniqueWord}`, {}),
          createMuxMessage("msg-2", "assistant", "I will remember that word.", {}),
          createMuxMessage("msg-3", "user", "Tell me a fact about cats", {}),
          createMuxMessage("msg-4", "assistant", "Cats sleep 12-16 hours a day.", {}),
        ];

        // Append messages to history
        for (const msg of messages) {
          const result = await historyService.appendToHistory(workspaceId, msg);
          expect(result.success).toBe(true);
        }

        // Setup collector for delete message verification
        const deleteCollector = createStreamCollector(env.orpc, workspaceId);
        deleteCollector.start();

        // Truncate 100% of history (full clear)
        const client = resolveOrpcClient(env);
        const truncateResult = await client.workspace.truncateHistory({
          workspaceId,
          percentage: 1.0,
        });
        expect(truncateResult.success).toBe(true);

        // Wait for DeleteMessage to be sent
        const deleteEvent = await deleteCollector.waitForEvent("delete", 5000);
        expect(deleteEvent).toBeDefined();
        deleteCollector.stop();

        // Verify all messages were deleted
        const deleteMsg = deleteEvent as DeleteMessage;
        expect(deleteMsg.historySequences.length).toBe(messages.length);

        // Setup collector for verification message
        const collector = createStreamCollector(env.orpc, workspaceId);
        collector.start();

        // Send a message asking AI to repeat the word from the beginning
        // This should definitely fail since all history was cleared
        const result = await sendMessageWithModel(
          env,
          workspaceId,
          "What was the word I asked you to remember? Reply with just the word or 'I don't know'."
        );

        expect(result.success).toBe(true);

        // Wait for response
        await collector.waitForEvent("stream-end", 10000);
        assertStreamSuccess(collector);

        // Get response content
        const finalMessage = collector.getFinalMessage();
        expect(finalMessage).toBeDefined();

        if (finalMessage && "parts" in finalMessage && Array.isArray(finalMessage.parts)) {
          const content = finalMessage.parts
            .filter((part) => part.type === "text")
            .map((part) => (part as { text: string }).text)
            .join("");

          // The word should definitely NOT be in the response (all history cleared)
          expect(content.toLowerCase()).not.toContain(uniqueWord.toLowerCase());
          // AI should indicate it doesn't know
          const lowerContent = content.toLowerCase();
          expect(
            lowerContent.includes("don't know") ||
              lowerContent.includes("don't have") ||
              lowerContent.includes("no information") ||
              lowerContent.includes("not sure") ||
              lowerContent.includes("can't recall")
          ).toBe(true);
        }
        collector.stop();
      } finally {
        await cleanup();
      }
    },
    30000
  );

  test.concurrent(
    "should block truncate during active stream and require Esc first",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      const collector = createStreamCollector(env.orpc, workspaceId);
      collector.start();
      try {
        const historyService = new HistoryService(env.config);

        // Prepopulate some history
        const uniqueWord = `testword-${Date.now()}`;
        const messages = [
          createMuxMessage("msg-1", "user", `Remember this word: ${uniqueWord}`, {}),
          createMuxMessage("msg-2", "assistant", "I will remember that word.", {}),
        ];

        for (const msg of messages) {
          const result = await historyService.appendToHistory(workspaceId, msg);
          expect(result.success).toBe(true);
        }

        // Start a long-running stream
        void sendMessageWithModel(
          env,
          workspaceId,
          "Run this bash command: for i in {1..60}; do sleep 0.5; done && echo done"
        );

        // Wait for stream to start
        await collector.waitForEvent("stream-start", 10000);

        // Try to truncate during active stream - should be blocked
        const client = resolveOrpcClient(env);
        const truncateResultWhileStreaming = await client.workspace.truncateHistory({
          workspaceId,
          percentage: 1.0,
        });
        expect(truncateResultWhileStreaming.success).toBe(false);
        if (!truncateResultWhileStreaming.success) {
          expect(truncateResultWhileStreaming.error).toContain("stream is active");
          expect(truncateResultWhileStreaming.error).toContain("Press Esc");
        }

        // Test passed - truncate was successfully blocked during active stream
      } finally {
        collector.stop();
        await cleanup();
      }
    },
    15000
  );
});
