/**
 * compactHistory integration tests.
 *
 * Ensures compaction is a control-plane operation (not a slash-command string), and that:
 * - History is replaced only on successful compaction completion
 * - continueMessage is auto-sent after compaction completes
 *
 * Requirements:
 * - Uses the Haiku model for both compaction and the follow-up continue message
 * - Seeds history via HistoryService (test-only) to avoid extra API calls
 */

import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { shouldRunIntegrationTests, validateApiKeys } from "./setup";
import {
  createSharedRepo,
  cleanupSharedRepo,
  withSharedWorkspace,
  configureTestRetries,
} from "./sendMessageTestHelpers";
import { modelString, seedHistoryMessages } from "./helpers";
import { KNOWN_MODELS } from "../../src/common/constants/knownModels";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

beforeAll(createSharedRepo);
afterAll(cleanupSharedRepo);

function getTextFromMessageParts(message: {
  parts?: Array<{ type: string; text?: string }>;
}): string {
  return (
    message.parts
      ?.filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("") ?? ""
  );
}

async function waitForMatchingEvent(
  collector: { getEvents: () => WorkspaceChatMessage[] },
  predicate: (event: WorkspaceChatMessage) => boolean,
  timeoutMs: number
): Promise<WorkspaceChatMessage | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const match = collector.getEvents().find(predicate);
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

describeIntegration("compactHistory integration tests", () => {
  configureTestRetries(3);

  test.concurrent(
    "should compact history and then auto-send continueMessage",
    async () => {
      await withSharedWorkspace("anthropic", async ({ env, workspaceId, collector }) => {
        const haiku = modelString("anthropic", KNOWN_MODELS.HAIKU.providerModelId);

        // Seed history quickly (test-only) to avoid extra API calls.
        const seededIds = await seedHistoryMessages(workspaceId, env.config, [
          {
            id: "seed-user-0",
            role: "user",
            content: "Context: we are discussing a small code refactor.",
          },
          {
            id: "seed-assistant-0",
            role: "assistant",
            content: "Acknowledged. I will help.",
          },
          {
            id: "seed-user-1",
            role: "user",
            content: "Please keep responses short and practical.",
          },
          {
            id: "seed-assistant-1",
            role: "assistant",
            content: "Understood.",
          },
        ]);

        collector.clear();

        const continueText = "Continue: reply with exactly 'OK'.";

        // Trigger compaction via the control-plane API.
        const compactResult = await env.orpc.workspace.compactHistory({
          workspaceId,
          model: haiku,
          maxOutputTokens: 800,
          source: "user",
          interrupt: "none",
          continueMessage: { text: continueText },
          sendMessageOptions: {
            model: haiku,
            thinkingLevel: "off",
          },
        });

        expect(compactResult.success).toBe(true);
        if (!compactResult.success) {
          throw new Error(String(compactResult.error));
        }

        // Wait for compaction stream to start + end.
        const compactionStreamStart = await collector.waitForEvent("stream-start", 20000);
        expect(compactionStreamStart).not.toBeNull();
        const compactionMessageId = (compactionStreamStart as { messageId: string }).messageId;

        const compactionStreamEnd = await waitForMatchingEvent(
          collector,
          (e) =>
            e.type === "stream-end" &&
            (e as { messageId?: string }).messageId === compactionMessageId,
          45000
        );
        expect(compactionStreamEnd).not.toBeNull();
        expect((compactionStreamEnd as { metadata: { model?: string } }).metadata.model).toBe(
          haiku
        );

        // Compaction should emit delete + summary message.
        const deleteEvent = await waitForMatchingEvent(
          collector,
          (e) => e.type === "delete",
          10000
        );
        expect(deleteEvent).not.toBeNull();

        const summaryMessage = await waitForMatchingEvent(
          collector,
          (e) => e.type === "message" && e.role === "assistant" && Boolean(e.metadata?.compacted),
          10000
        );
        expect(summaryMessage).not.toBeNull();

        // Continue message should be persisted as a user message and then streamed.
        const continueUserMessage = await waitForMatchingEvent(
          collector,
          (e) =>
            e.type === "message" &&
            e.role === "user" &&
            getTextFromMessageParts(e) === continueText,
          20000
        );
        expect(continueUserMessage).not.toBeNull();

        const continueStreamStart = await waitForMatchingEvent(
          collector,
          (e) =>
            e.type === "stream-start" &&
            (e as { messageId?: string }).messageId !== compactionMessageId &&
            (e as { metadata?: { model?: string } }).metadata?.model === haiku,
          20000
        );
        expect(continueStreamStart).not.toBeNull();

        const continueMessageId = (continueStreamStart as { messageId: string }).messageId;
        const continueStreamEnd = await waitForMatchingEvent(
          collector,
          (e) =>
            e.type === "stream-end" &&
            (e as { messageId?: string }).messageId === continueMessageId,
          45000
        );
        expect(continueStreamEnd).not.toBeNull();

        // Verify persisted history:
        // - seeded messages were removed
        // - summary exists
        // - continue message exists
        const replay = await env.orpc.workspace.getFullReplay({ workspaceId });
        const replayMessages = replay.filter((m) => m.type === "message");

        for (const id of seededIds) {
          expect(replayMessages.some((m) => m.id === id)).toBe(false);
        }

        const summaryIndex = replayMessages.findIndex(
          (m) => m.role === "assistant" && Boolean(m.metadata?.compacted)
        );
        expect(summaryIndex).toBe(0);

        const continueIndex = replayMessages.findIndex(
          (m) => m.role === "user" && getTextFromMessageParts(m) === continueText
        );
        expect(continueIndex).toBeGreaterThan(summaryIndex);
      });
    },
    90000
  );
});
