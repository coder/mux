/**
 * Integration test: Compaction 1M context retry.
 *
 * Validates that when a /compact request exceeds the default context limit (200k),
 * the backend automatically retries with 1M context enabled for models that support it.
 *
 * Pre-seeds ~250k tokens of conversation history, then issues a compaction request
 * with Opus 4.6 (default 200k limit, supports 1M). If the 1M retry fires correctly,
 * the compaction should succeed rather than returning context_exceeded.
 */

import { setupWorkspace, shouldRunIntegrationTests, validateApiKeys } from "./setup";
import { createStreamCollector, resolveOrpcClient } from "./helpers";
import { HistoryService } from "../../src/node/services/historyService";
import { createMuxMessage } from "../../src/common/types/message";
import { KNOWN_MODELS } from "../../src/common/constants/knownModels";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

// ~1 token ≈ 4 chars in English text. To exceed 200k tokens we need ~800k chars.
// Use ~260k tokens of padding to comfortably exceed the 200k default context.
const TOKENS_PER_CHAR = 0.25; // conservative estimate
const TARGET_TOKENS = 260_000;
const CHARS_NEEDED = Math.ceil(TARGET_TOKENS / TOKENS_PER_CHAR);

/** Build a filler message that is roughly `charCount` characters long. */
function buildFillerText(charCount: number): string {
  // Use varied text to avoid aggressive tokenizer compression
  const base =
    "The quick brown fox jumps over the lazy dog. " +
    "Pack my box with five dozen liquor jugs. " +
    "How vexingly quick daft zebras jump. " +
    "Sphinx of black quartz, judge my vow. ";
  const repeats = Math.ceil(charCount / base.length);
  return base.repeat(repeats).slice(0, charCount);
}

describeIntegration("compaction 1M context retry", () => {
  // Compaction with 1M retry can take a while — summarizing 250k+ tokens of content
  const TEST_TIMEOUT_MS = 120_000;

  test(
    "should auto-retry compaction with 1M context when exceeding 200k default limit",
    async () => {
      const { env, workspaceId, cleanup } = await setupWorkspace("anthropic");
      try {
        const historyService = new HistoryService(env.config);

        // Seed conversation history that exceeds 200k tokens.
        // Split across multiple user/assistant pairs to be realistic.
        const pairsNeeded = 10;
        const charsPerMessage = Math.ceil(CHARS_NEEDED / pairsNeeded);

        for (let i = 0; i < pairsNeeded; i++) {
          const userMsg = createMuxMessage(
            `filler-user-${i}`,
            "user",
            buildFillerText(charsPerMessage),
            {}
          );
          const assistantMsg = createMuxMessage(
            `filler-asst-${i}`,
            "assistant",
            buildFillerText(charsPerMessage),
            {}
          );
          const r1 = await historyService.appendToHistory(workspaceId, userMsg);
          expect(r1.success).toBe(true);
          const r2 = await historyService.appendToHistory(workspaceId, assistantMsg);
          expect(r2.success).toBe(true);
        }

        // Set up stream collector
        const collector = createStreamCollector(env.orpc, workspaceId);
        collector.start();

        const opusModel = `anthropic:${KNOWN_MODELS.OPUS.providerModelId}`;

        // Send compaction request — use the same pattern as production /compact.
        // Crucially, do NOT enable 1M context in providerOptions; the retry should add it.
        const client = resolveOrpcClient(env);
        const sendResult = await client.workspace.sendMessage({
          workspaceId,
          message:
            "Please provide a detailed summary of this conversation. " +
            "Capture all key decisions, context, and open questions.",
          options: {
            model: opusModel,
            thinkingLevel: "off",
            agentId: "compact",
            // No providerOptions.anthropic.use1MContext here — the retry should inject it
            toolPolicy: [{ regex_match: ".*", action: "disable" }],
            muxMetadata: {
              type: "compaction-request",
              rawCommand: "/compact",
              parsed: {},
            },
          },
        });

        expect(sendResult.success).toBe(true);

        // Wait for either stream-end (success) or stream-error (failure).
        // With 1M retry working, we expect stream-end.
        const terminalEvent = await Promise.race([
          collector.waitForEvent("stream-end", TEST_TIMEOUT_MS),
          collector.waitForEvent("stream-error", TEST_TIMEOUT_MS),
        ]);

        expect(terminalEvent).toBeDefined();

        if (terminalEvent?.type === "stream-error") {
          // If we got a stream-error, the 1M retry didn't work.
          // Log diagnostic info for debugging.
          const errorType = "errorType" in terminalEvent ? terminalEvent.errorType : "unknown";
          const errorMsg = "error" in terminalEvent ? terminalEvent.error : "unknown";
          throw new Error(
            `Compaction failed (expected 1M retry to succeed): ` +
              `errorType=${errorType}, error=${errorMsg}`
          );
        }

        // Verify we got a successful compaction (stream-end)
        expect(terminalEvent?.type).toBe("stream-end");

        collector.stop();
      } finally {
        await cleanup();
      }
    },
    TEST_TIMEOUT_MS + 10_000
  );
});
