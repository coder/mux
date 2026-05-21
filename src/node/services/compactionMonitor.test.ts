import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import { describe, expect, test } from "bun:test";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import { CompactionMonitor, type CompactionStatusEvent } from "./compactionMonitor";

const BETA_SONNET_MODEL = "anthropic:claude-sonnet-4-5";

function createUsageDisplay(contextTokens: number, model = BETA_SONNET_MODEL): ChatUsageDisplay {
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
      model: BETA_SONNET_MODEL,
      usage: { lastContextUsage: createUsageDisplay(120_000) },
      use1MContext: false,
      providersConfig: null,
    });
    expect(lowResult.shouldForceCompact).toBe(false);
    expect(lowResult.usagePercentage).toBe(60);

    const forceResult = monitor.checkBeforeSend({
      model: BETA_SONNET_MODEL,
      usage: { lastContextUsage: createUsageDisplay(150_000) },
      use1MContext: false,
      providersConfig: null,
    });
    expect(forceResult.shouldForceCompact).toBe(true);
    expect(forceResult.usagePercentage).toBe(75);

    monitor.setThreshold(0.8);
    const customThresholdResult = monitor.checkBeforeSend({
      model: BETA_SONNET_MODEL,
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
        model: BETA_SONNET_MODEL,
        usage: createMidStreamUsage(140_000),
        use1MContext: false,
        providersConfig: null,
      })
    ).toBe(false);
    expect(statusEvents).toHaveLength(0);

    expect(
      monitor.checkMidStream({
        model: BETA_SONNET_MODEL,
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
        model: BETA_SONNET_MODEL,
        usage: createMidStreamUsage(160_000),
        use1MContext: false,
        providersConfig: null,
      })
    ).toBe(false);
    expect(statusEvents).toHaveLength(1);
  });

  test("checkMidStream stays disabled when threshold is set to 1.0", () => {
    const { monitor, statusEvents } = createMonitor();
    monitor.setThreshold(1);

    expect(
      monitor.checkMidStream({
        model: BETA_SONNET_MODEL,
        usage: createMidStreamUsage(210_000),
        use1MContext: false,
        providersConfig: null,
      })
    ).toBe(false);
    expect(statusEvents).toHaveLength(0);
  });

  test("checkMidStream ignores malformed non-positive context limits", () => {
    const { monitor, statusEvents } = createMonitor();

    const malformedProvidersConfig = {
      openai: {
        models: [{ id: "gpt-4o", contextWindowTokens: -1 }],
      },
    } as unknown as ProvidersConfigMap;

    expect(
      monitor.checkMidStream({
        model: "openai:gpt-4o",
        usage: createMidStreamUsage(42),
        use1MContext: false,
        providersConfig: malformedProvidersConfig,
      })
    ).toBe(false);
    expect(statusEvents).toHaveLength(0);
  });

  test("checkMidStream does not double-count cachedInputTokens", () => {
    const { monitor, statusEvents } = createMonitor();

    // Force threshold is 75% with defaults (70% + 5% buffer).
    // 145k / 200k = 72.5%, so this should NOT trigger even when
    // cachedInputTokens is present.
    expect(
      monitor.checkMidStream({
        model: BETA_SONNET_MODEL,
        usage: createMidStreamUsage(145_000, 10_000),
        use1MContext: false,
        providersConfig: null,
      })
    ).toBe(false);
    expect(statusEvents).toHaveLength(0);
  });

  test("resetForNewStream allows a new mid-stream trigger", () => {
    const { monitor, statusEvents } = createMonitor();

    expect(
      monitor.checkMidStream({
        model: BETA_SONNET_MODEL,
        usage: createMidStreamUsage(150_000),
        use1MContext: false,
        providersConfig: null,
      })
    ).toBe(true);
    expect(statusEvents).toHaveLength(1);

    monitor.resetForNewStream();

    expect(
      monitor.checkMidStream({
        model: BETA_SONNET_MODEL,
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

  // ────────────────────────────────────────────────────────────────
  // thresholdOverride lane (per-goal auto-compact override).
  //
  // Behavioral contract these tests pin down:
  //   1. A finite, in-range override replaces this.threshold for the
  //      single call. The monitor's own threshold is untouched.
  //   2. Override `>= 1` (per-goal disabled / clamp) suppresses
  //      compaction for that call, even if the monitor's own threshold
  //      would normally fire.
  //   3. `null` / `undefined` / non-finite / non-positive override
  //      falls back to `this.threshold` so a stale or corrupt persisted
  //      goal record cannot brick the compaction loop.
  //   4. `checkBeforeSend` surfaces the effective threshold via
  //      `thresholdPercentage` so the on-send branch in `AgentSession`
  //      reads the right number.
  // ────────────────────────────────────────────────────────────────
  test("checkBeforeSend honors a per-call thresholdOverride for the active goal", () => {
    const { monitor } = createMonitor();

    // 75% usage with a 0.5 (=50%) override should force-compact even
    // though the monitor's own default (70%) would not yet have hit
    // the buffer-driven force threshold.
    const result = monitor.checkBeforeSend({
      model: BETA_SONNET_MODEL,
      usage: { lastContextUsage: createUsageDisplay(150_000) },
      use1MContext: false,
      providersConfig: null,
      thresholdOverride: 0.5,
    });
    expect(result.thresholdPercentage).toBe(50);
    expect(result.shouldForceCompact).toBe(true);

    // The monitor's own threshold must NOT have been mutated by the
    // override — it stays at the default 70% for subsequent calls
    // without an override.
    expect(monitor.getThreshold()).toBe(DEFAULT_THRESHOLD);
    const followUp = monitor.checkBeforeSend({
      model: BETA_SONNET_MODEL,
      usage: { lastContextUsage: createUsageDisplay(150_000) },
      use1MContext: false,
      providersConfig: null,
    });
    expect(followUp.thresholdPercentage).toBe(70);
  });

  test("checkBeforeSend treats an override of 1.0 as disabled for that call", () => {
    const { monitor } = createMonitor();

    // 90% usage would force-compact under the default 70% threshold,
    // but an override of 1.0 (per-goal disabled) must zero out the
    // result and skip the compaction signal entirely.
    const result = monitor.checkBeforeSend({
      model: BETA_SONNET_MODEL,
      usage: { lastContextUsage: createUsageDisplay(180_000) },
      use1MContext: false,
      providersConfig: null,
      thresholdOverride: 1,
    });
    expect(result.shouldForceCompact).toBe(false);
    expect(result.shouldShowWarning).toBe(false);
  });

  test("checkMidStream honors per-call thresholdOverride", () => {
    const { monitor, statusEvents } = createMonitor();

    // 100k / 200k = 50%. Under the monitor's default (70% + 5% buffer
    // = 75% force), this would NOT fire. With an override of 0.4
    // (40% + 5% buffer = 45% force), 50% must trigger.
    expect(
      monitor.checkMidStream({
        model: BETA_SONNET_MODEL,
        usage: createMidStreamUsage(100_000),
        use1MContext: false,
        providersConfig: null,
        thresholdOverride: 0.4,
      })
    ).toBe(true);
    expect(statusEvents).toHaveLength(1);
    expect(statusEvents[0]).toMatchObject({ usagePercent: 50 });
  });

  test("checkMidStream override of 1.0 short-circuits even when usage is high", () => {
    const { monitor, statusEvents } = createMonitor();

    // 95% usage would normally force-compact (under the 70% default
    // threshold the force point is 75%). Override 1 = per-goal off.
    expect(
      monitor.checkMidStream({
        model: BETA_SONNET_MODEL,
        usage: createMidStreamUsage(190_000),
        use1MContext: false,
        providersConfig: null,
        thresholdOverride: 1,
      })
    ).toBe(false);
    expect(statusEvents).toHaveLength(0);
  });

  test("invalid threshold overrides fall back to the monitor's own threshold", () => {
    const { monitor } = createMonitor();

    // null, NaN, negatives, and 0 must all degrade gracefully to the
    // monitor's own threshold rather than throwing — these can come
    // from a corrupt persisted goal record and must not interrupt
    // the on-send / mid-stream pipelines.
    for (const bad of [null, Number.NaN, Number.POSITIVE_INFINITY, -0.1, 0]) {
      const result = monitor.checkBeforeSend({
        model: BETA_SONNET_MODEL,
        usage: { lastContextUsage: createUsageDisplay(150_000) },
        use1MContext: false,
        providersConfig: null,
        thresholdOverride: bad,
      });
      expect(result.thresholdPercentage).toBe(70);
    }
  });
});

// Pulled out as a constant for readability in the override-vs-default
// assertions; matches the monitor's initial value.
const DEFAULT_THRESHOLD = 0.7;
