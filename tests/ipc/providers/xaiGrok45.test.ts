import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { isStreamEnd } from "@/common/orpc/types";
import {
  assertStreamSuccess,
  configureTestRetries,
  createStreamCollector,
  sendMessageWithModel,
} from "../helpers";
import { setupWorkspace, shouldRunIntegrationTests, validateApiKeys } from "../setup";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

if (shouldRunIntegrationTests()) {
  validateApiKeys(["XAI_API_KEY"]);
}

describeIntegration("xAI Grok 4.5 integration", () => {
  configureTestRetries(3);

  test("streams a priority request and reports exact billed cost metadata", async () => {
    const { env, workspaceId, cleanup } = await setupWorkspace("xai", "grok-4-5");
    const collector = createStreamCollector(env.orpc, workspaceId);
    collector.start();

    try {
      const result = await sendMessageWithModel(
        env,
        workspaceId,
        "Reply with exactly: GROK45_OK",
        KNOWN_MODELS.GROK_45.id,
        {
          // Grok 4.5's built-in minimum thinking floor is medium.
          thinkingLevel: "medium",
          providerOptions: {
            xai: {
              serviceTier: "priority",
              searchParameters: { mode: "off" },
            },
          },
        }
      );

      expect(result.success).toBe(true);

      const terminalEvent = await Promise.race([
        collector.waitForEvent("stream-end", 60_000),
        collector.waitForEvent("stream-error", 60_000),
      ]);
      if (!terminalEvent) {
        throw new Error("Expected terminal stream event from Grok 4.5");
      }
      if (terminalEvent.type === "stream-error") {
        throw new Error(`Grok 4.5 stream failed: ${terminalEvent.error}`);
      }
      if (!isStreamEnd(terminalEvent)) {
        throw new Error(`Expected stream-end event, received ${terminalEvent.type}`);
      }
      const streamEnd = terminalEvent;

      assertStreamSuccess(collector);
      expect(streamEnd.metadata.model).toBe(KNOWN_MODELS.GROK_45.id);
      expect(streamEnd.metadata.thinkingLevel).toBe("medium");

      const xaiMetadata = streamEnd.metadata.providerMetadata?.xai as
        | { costInUsdTicks?: unknown }
        | undefined;
      expect(typeof xaiMetadata?.costInUsdTicks).toBe("number");
      expect(xaiMetadata?.costInUsdTicks).toBeGreaterThan(0);
      expect(collector.getDeltas().join("").trim().length).toBeGreaterThan(0);
    } finally {
      collector.stop();
      await cleanup();
    }
  }, 90_000);
});
