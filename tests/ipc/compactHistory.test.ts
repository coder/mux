/**
 * compactHistory integration tests.
 *
 * Ensures compaction is a control-plane operation (not a slash-command string), and that
 * history is replaced only on successful compaction completion.
 *
 * Requirements:
 * - Uses the Haiku model for both normal messages and compaction
 * - Builds history by sending messages (replicates user behavior)
 */

import { shouldRunIntegrationTests, validateApiKeys } from "./setup";
import {
  createSharedRepo,
  cleanupSharedRepo,
  withSharedWorkspace,
  configureTestRetries,
} from "./sendMessageTestHelpers";
import { assertStreamSuccess, modelString, sendMessageWithModel } from "./helpers";
import { KNOWN_MODELS } from "../../src/common/constants/knownModels";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

beforeAll(createSharedRepo);
afterAll(cleanupSharedRepo);

describeIntegration("compactHistory integration tests", () => {
  configureTestRetries(3);

  test.concurrent(
    "should compact history using Haiku for both messages + compaction",
    async () => {
      await withSharedWorkspace("anthropic", async ({ env, workspaceId, collector }) => {
        const haiku = modelString("anthropic", KNOWN_MODELS.HAIKU.providerModelId);

        // Build history via normal user interactions.
        collector.clear();

        const message1 =
          "You are helping me plan a small refactor. Explain, in a few sentences, what the risks are when refactoring code without tests.";
        const result1 = await sendMessageWithModel(env, workspaceId, message1, haiku);
        expect(result1.success).toBe(true);
        const streamEnd1 = await collector.waitForEvent("stream-end", 20000);
        expect(streamEnd1).not.toBeNull();
        expect((streamEnd1 as { metadata: { model?: string } }).metadata.model).toBe(haiku);
        assertStreamSuccess(collector);

        collector.clear();

        const message2 =
          "Now list three concrete steps I should take to refactor safely. Include enough detail that it would be useful in a code review.";
        const result2 = await sendMessageWithModel(env, workspaceId, message2, haiku);
        expect(result2.success).toBe(true);
        const streamEnd2 = await collector.waitForEvent("stream-end", 20000);
        expect(streamEnd2).not.toBeNull();
        expect((streamEnd2 as { metadata: { model?: string } }).metadata.model).toBe(haiku);
        assertStreamSuccess(collector);

        collector.clear();

        // Trigger compaction explicitly via the control-plane API.
        const compactResult = await env.orpc.workspace.compactHistory({
          workspaceId,
          model: haiku,
          maxOutputTokens: 800,
          source: "user",
          interrupt: "none",
          sendMessageOptions: {
            model: haiku,
            thinkingLevel: "off",
          },
        });

        expect(compactResult.success).toBe(true);
        if (!compactResult.success) {
          throw new Error(String(compactResult.error));
        }

        // Ensure this stream is actually the compaction stream.
        const streamStart = await collector.waitForEvent("stream-start", 20000);
        expect(streamStart).not.toBeNull();
        const compactionMessageId = (streamStart as { messageId: string }).messageId;

        const streamEnd = await collector.waitForEvent("stream-end", 30000);
        expect(streamEnd).not.toBeNull();
        expect((streamEnd as { messageId: string }).messageId).toBe(compactionMessageId);
        expect((streamEnd as { metadata: { model?: string } }).metadata.model).toBe(haiku);
        assertStreamSuccess(collector);

        // The compaction handler emits a single summary message + delete event.
        const deleteEvent = collector.getEvents().find((e) => e.type === "delete");
        expect(deleteEvent).toBeDefined();

        const summaryMessage = collector
          .getEvents()
          .find((e) => e.type === "message" && e.role === "assistant" && e.metadata?.compacted);
        expect(summaryMessage).toBeDefined();
        expect((summaryMessage as { metadata?: { model?: string } }).metadata?.model).toBe(haiku);

        // Verify persisted history was replaced (user behavior: reload workspace).
        const replay = await env.orpc.workspace.getFullReplay({ workspaceId });
        const replayMessages = replay.filter((m) => m.type === "message");

        // After compaction we should only have a single assistant summary message.
        expect(replayMessages).toHaveLength(1);
        expect(replayMessages[0].role).toBe("assistant");
        expect(replayMessages[0].metadata?.compacted).toBeDefined();
        expect(replayMessages[0].metadata?.model).toBe(haiku);

        // Sanity check: original user prompt text should not be present after replacement.
        const replayText = JSON.stringify(replayMessages[0]);
        expect(replayText).not.toContain("refactoring code without tests");
        expect(replayText).not.toContain("three concrete steps");
      });
    },
    90000
  );
});
