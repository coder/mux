import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import { describe, expect, test } from "bun:test";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import { CompactionMonitor, type CompactionStatusEvent } from "./compactionMonitor";

function createUsageDisplay(
  contextTokens: number,
  model = KNOWN_MODELS.SONNET.id
): ChatUsageDisplay {
  const inputTokens = Math.floor(contextTokens * 0.9);
  const cachedTokens = contextTokens - inputTokens;

  return {
    input: { tokens: inputTokens },
    cached: { tokens: cachedTokens },
    cacheCreate: { tokens: 0 },
    output: { tokens: 0 },
    reasoning: { tokens: 0 },
    model,
  };
}

function createMidStreamUsage(inputTokens: number, cachedInputTokens = 0): LanguageModelV2Usage {
  return {
    inputTokens,
    outputTokens: 0,
    totalTokens: inputTokens + cachedInputTokens,
    cachedInputTokens,
  };
}

function createMonitor() {
  const statusEvents: CompactionStatusEvent[] = [];
  const monitor = new CompactionMonitor("workspace-1", (event) => {
    statusEvents.push(event);
  });

  return { monitor, statusEvents };
}

describe("CompactionMonitor", () => {
  test("checkBeforeSend returns auto-compaction result based on threshold", () => {
    const { monitor } = createMonitor();

    const lowResult = monitor.checkBeforeSend({
      model: KNOWN_MODELS.SONNET.id,
      usage: { lastContextUsage: createUsageDisplay(120_000) },
      use1MContext: false,
      providersConfig: null,
    });
    expect(lowResult.shouldForceCompact).toBe(false);
    expect(lowResult.usagePercentage).toBe(60);

    const forceResult = monitor.checkBeforeSend({
      model: KNOWN_MODELS.SONNET.id,
      usage: { lastContextUsage: createUsageDisplay(150_000) },
      use1MContext: false,
      providersConfig: null,
    });
    expect(forceResult.shouldForceCompact).toBe(true);
    expect(forceResult.usagePercentage).toBe(75);

    monitor.setThreshold(0.8);
    const customThresholdResult = monitor.checkBeforeSend({
      model: KNOWN_MODELS.SONNET.id,
      usage: { lastContextUsage: createUsageDisplay(150_000) },
      use1MContext: false,
      providersConfig: null,
    });
    expect(customThresholdResult.thresholdPercentage).toBe(80);
    expect(customThresholdResult.shouldForceCompact).toBe(false);
  });

  test("checkMidStream triggers once when usage exceeds force threshold", () => {
    const { monitor, statusEvents } = createMonitor();

    expect(
      monitor.checkMidStream({
        model: KNOWN_MODELS.SONNET.id,
        usage: createMidStreamUsage(140_000),
        use1MContext: false,
        providersConfig: null,
      })
    ).toBe(false);
    expect(statusEvents).toHaveLength(0);

    expect(
      monitor.checkMidStream({
        model: KNOWN_MODELS.SONNET.id,
        usage: createMidStreamUsage(150_000),
        use1MContext: false,
        providersConfig: null,
      })
    ).toBe(true);
    expect(statusEvents).toEqual([
      {
        type: "auto-compaction-triggered",
        reason: "mid-stream",
        usagePercent: 75,
      },
    ]);

    expect(
      monitor.checkMidStream({
        model: KNOWN_MODELS.SONNET.id,
        usage: createMidStreamUsage(160_000),
        use1MContext: false,
        providersConfig: null,
      })
    ).toBe(false);
    expect(statusEvents).toHaveLength(1);
  });

  test("resetForNewStream allows a new mid-stream trigger", () => {
    const { monitor, statusEvents } = createMonitor();

    expect(
      monitor.checkMidStream({
        model: KNOWN_MODELS.SONNET.id,
        usage: createMidStreamUsage(150_000),
        use1MContext: false,
        providersConfig: null,
      })
    ).toBe(true);
    expect(statusEvents).toHaveLength(1);

    monitor.resetForNewStream();

    expect(
      monitor.checkMidStream({
        model: KNOWN_MODELS.SONNET.id,
        usage: createMidStreamUsage(160_000),
        use1MContext: false,
        providersConfig: null,
      })
    ).toBe(true);
    expect(statusEvents).toHaveLength(2);
  });

  test("setThreshold enforces valid bounds", () => {
    const { monitor } = createMonitor();

    expect(() => monitor.setThreshold(0)).toThrow("invalid threshold");
    expect(() => monitor.setThreshold(1.01)).toThrow("invalid threshold");
    expect(() => monitor.setThreshold(Number.NaN)).toThrow("threshold must be finite");

    monitor.setThreshold(0.55);
    expect(monitor.getThreshold()).toBe(0.55);
  });
});
