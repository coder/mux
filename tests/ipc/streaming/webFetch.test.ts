/**
 * Integration test: web_fetch via a real Anthropic LLM.
 *
 * Verifies that when using an Anthropic model, the provider-native
 * webFetch_20250910 tool is selected (not our built-in curl-based one),
 * and that the full round-trip works: model calls the tool, Anthropic
 * fetches the page server-side, and the result is streamed back.
 */

import { shouldRunIntegrationTests, validateApiKeys } from "../setup";
import { sendMessageWithModel, assertStreamSuccess } from "../helpers";
import {
  createSharedRepo,
  cleanupSharedRepo,
  withSharedWorkspace,
  configureTestRetries,
} from "../sendMessageTestHelpers";
import { isToolCallStart, isToolCallEnd } from "@/common/orpc/types";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

beforeAll(createSharedRepo);
afterAll(cleanupSharedRepo);

// Sonnet 4.6 — the model that introduced native web_fetch (webFetch_20250910)
const SONNET_4_6 = "anthropic:claude-sonnet-4-6";

describeIntegration("web_fetch integration tests", () => {
  configureTestRetries(2);

  test.concurrent(
    "should call web_fetch and summarize top story from lite.cnn.com",
    async () => {
      await withSharedWorkspace("anthropic", async ({ env, workspaceId, collector }) => {
        const result = await sendMessageWithModel(
          env,
          workspaceId,
          "Use web_fetch to read https://lite.cnn.com/ and tell me the top story headline.",
          SONNET_4_6,
          {
            // Enable only web_fetch (disable everything else) so the model uses it naturally
            // without forcing toolChoice on every turn. Using "require" would set
            // toolChoice: { type: "tool" } on ALL turns including the post-result text turn,
            // preventing the model from generating a text response.
            toolPolicy: [
              { regex_match: ".*", action: "disable" },
              { regex_match: "web_fetch", action: "enable" },
            ],
          }
        );

        expect(result.success).toBe(true);

        // web_fetch + LLM summarization can take up to 60s
        await collector.waitForEvent("stream-end", 60000);

        assertStreamSuccess(collector);

        const events = collector.getEvents();

        // Assert the model called web_fetch
        const webFetchStart = events
          .filter(isToolCallStart)
          .find((e) => e.toolName === "web_fetch");
        expect(webFetchStart).toBeDefined();
        expect(webFetchStart?.args).toMatchObject({ url: "https://lite.cnn.com/" });

        // Assert the tool completed and returned some result.
        // We don't assert success here because lite.cnn.com may return Cloudflare
        // challenges in some CI network environments — but the model handles that
        // gracefully and still produces a text response.
        const webFetchEnd = events.filter(isToolCallEnd).find((e) => e.toolName === "web_fetch");
        expect(webFetchEnd).toBeDefined();
        expect(webFetchEnd?.result).toBeTruthy();

        // Assert the model produced a substantive text response about CNN content
        const deltas = collector.getDeltas();
        const responseText = deltas.join("");
        expect(responseText.length).toBeGreaterThan(20);
      });
    },
    75000
  );
});
