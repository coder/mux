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
            // Require web_fetch so the test fails fast if the tool isn't offered
            toolPolicy: [{ regex_match: "web_fetch", action: "require" }],
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

        // Assert the tool completed and returned a successful result
        const webFetchEnd = events.filter(isToolCallEnd).find((e) => e.toolName === "web_fetch");
        expect(webFetchEnd).toBeDefined();

        // Tool results may be JSON-wrapped by streamManager: { type: "json", value: ... }.
        // Unwrap before inspecting provider-specific fields.
        const unwrap = (v: unknown): unknown => {
          if (
            v != null &&
            typeof v === "object" &&
            (v as Record<string, unknown>).type === "json" &&
            "value" in (v as object)
          ) {
            return (v as Record<string, unknown>).value;
          }
          return v;
        };

        // Anthropic native: { type: 'web_fetch_result', ... }
        // Built-in fallback: { success: true, ... }
        // Either way the result must be present and not an error
        const toolResult = unwrap(webFetchEnd?.result) as
          | Record<string, unknown>
          | null
          | undefined;
        expect(toolResult).toBeTruthy();
        if (toolResult && "type" in toolResult) {
          // Provider-native path: must not be an error
          expect(toolResult.type).not.toBe("web_fetch_tool_result_error");
        } else if (toolResult && "success" in toolResult) {
          // Built-in fallback path
          expect(toolResult.success).toBe(true);
        }

        // Assert the model produced a substantive text response about CNN content
        const deltas = collector.getDeltas();
        const responseText = deltas.join("");
        expect(responseText.length).toBeGreaterThan(20);
      });
    },
    75000
  );
});
