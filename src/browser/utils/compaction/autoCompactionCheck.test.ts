import { describe, test, expect } from "bun:test";
import { checkAutoCompaction } from "./autoCompactionCheck";
import type { WorkspaceUsageState } from "@/browser/stores/WorkspaceStore";
import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import { KNOWN_MODELS } from "@/common/constants/knownModels";

// Helper to create a mock usage entry
const createUsageEntry = (
  tokens: number,
  model: string = KNOWN_MODELS.SONNET.id
): ChatUsageDisplay => {
  // Distribute tokens across different types (realistic pattern)
  const inputTokens = Math.floor(tokens * 0.6); // 60% input
  const outputTokens = Math.floor(tokens * 0.3); // 30% output
  const cachedTokens = Math.floor(tokens * 0.1); // 10% cached

  return {
    input: { tokens: inputTokens },
    cached: { tokens: cachedTokens },
    cacheCreate: { tokens: 0 },
    output: { tokens: outputTokens },
    reasoning: { tokens: 0 },
    model,
  };
};

// Helper to create mock WorkspaceUsageState
const createMockUsage = (
  lastEntryTokens: number,
  historicalTokens?: number,
  model: string = KNOWN_MODELS.SONNET.id
): WorkspaceUsageState => {
  const usageHistory: ChatUsageDisplay[] = [];

  if (historicalTokens !== undefined) {
    // Add historical usage (from compaction)
    usageHistory.push(createUsageEntry(historicalTokens, "historical-model"));
  }

  // Add recent usage
  usageHistory.push(createUsageEntry(lastEntryTokens, model));

  return { usageHistory, totalTokens: 0 };
};

describe("checkAutoCompaction", () => {
  const SONNET_MAX_TOKENS = 200_000;
  const SONNET_70_PERCENT = SONNET_MAX_TOKENS * 0.7; // 140,000
  const SONNET_60_PERCENT = SONNET_MAX_TOKENS * 0.6; // 120,000

  describe("Basic Functionality", () => {
    test("returns false when no usage data (first message)", () => {
      const result = checkAutoCompaction(undefined, KNOWN_MODELS.SONNET.id, false, true);

      expect(result.shouldShowWarning).toBe(false);
      expect(result.usagePercentage).toBe(0);
      expect(result.thresholdPercentage).toBe(70);
    });

    test("returns false when usage history is empty", () => {
      const usage: WorkspaceUsageState = { usageHistory: [], totalTokens: 0 };
      const result = checkAutoCompaction(usage, KNOWN_MODELS.SONNET.id, false, true);

      expect(result.shouldShowWarning).toBe(false);
      expect(result.usagePercentage).toBe(0);
      expect(result.thresholdPercentage).toBe(70);
    });

    test("returns false when model has no max_input_tokens (unknown model)", () => {
      const usage = createMockUsage(50_000);
      const result = checkAutoCompaction(usage, "unknown-model", false, true);

      expect(result.shouldShowWarning).toBe(false);
      expect(result.usagePercentage).toBe(0);
      expect(result.thresholdPercentage).toBe(70);
    });

    test("returns false when usage is low (10%)", () => {
      const usage = createMockUsage(20_000); // 10% of 200k
      const result = checkAutoCompaction(usage, KNOWN_MODELS.SONNET.id, false, true);

      expect(result.shouldShowWarning).toBe(false);
      expect(result.usagePercentage).toBe(10);
      expect(result.thresholdPercentage).toBe(70);
    });

    test("returns true at warning threshold (60% with default 10% advance)", () => {
      const usage = createMockUsage(SONNET_60_PERCENT);
      const result = checkAutoCompaction(usage, KNOWN_MODELS.SONNET.id, false, true);

      expect(result.shouldShowWarning).toBe(true);
      expect(result.usagePercentage).toBe(60);
      expect(result.thresholdPercentage).toBe(70);
    });

    test("returns true at compaction threshold (70%)", () => {
      const usage = createMockUsage(SONNET_70_PERCENT);
      const result = checkAutoCompaction(usage, KNOWN_MODELS.SONNET.id, false, true);

      expect(result.shouldShowWarning).toBe(true);
      expect(result.usagePercentage).toBe(70);
      expect(result.thresholdPercentage).toBe(70);
    });

    test("returns true above threshold (80%)", () => {
      const usage = createMockUsage(160_000); // 80% of 200k
      const result = checkAutoCompaction(usage, KNOWN_MODELS.SONNET.id, false, true);

      expect(result.shouldShowWarning).toBe(true);
      expect(result.usagePercentage).toBe(80);
      expect(result.thresholdPercentage).toBe(70);
    });
  });

  describe("Usage Calculation (Critical for infinite loop fix)", () => {
    test("uses last usage entry tokens, not cumulative sum", () => {
      const usage = createMockUsage(10_000); // Only 5% of context
      const result = checkAutoCompaction(usage, KNOWN_MODELS.SONNET.id, false, true);

      // Should be 5%, not counting historical
      expect(result.usagePercentage).toBe(5);
      expect(result.shouldShowWarning).toBe(false);
    });

    test("handles historical usage correctly - ignores it in calculation", () => {
      // Scenario: After compaction, historical = 70K, recent = 5K
      // Should calculate based on 5K (2.5%), not 75K (37.5%)
      const usage = createMockUsage(5_000, 70_000);
      const result = checkAutoCompaction(usage, KNOWN_MODELS.SONNET.id, false, true);

      expect(result.usagePercentage).toBe(2.5);
      expect(result.shouldShowWarning).toBe(false);
    });

    test("includes all token types in calculation", () => {
      // Create usage with all token types specified
      const usage: WorkspaceUsageState = {
        usageHistory: [
          {
            input: { tokens: 10_000 },
            cached: { tokens: 5_000 },
            cacheCreate: { tokens: 2_000 },
            output: { tokens: 3_000 },
            reasoning: { tokens: 1_000 },
            model: KNOWN_MODELS.SONNET.id,
          },
        ],
        totalTokens: 0,
      };

      const result = checkAutoCompaction(usage, KNOWN_MODELS.SONNET.id, false, true);

      // Total: 10k + 5k + 2k + 3k + 1k = 21k tokens = 10.5%
      expect(result.usagePercentage).toBe(10.5);
    });
  });

  describe("1M Context Mode", () => {
    test("uses 1M tokens when use1M=true and model supports it (Sonnet 4)", () => {
      const usage = createMockUsage(600_000); // 60% of 1M
      const result = checkAutoCompaction(usage, KNOWN_MODELS.SONNET.id, true, true);

      expect(result.usagePercentage).toBe(60);
      expect(result.shouldShowWarning).toBe(true);
    });

    test("uses 1M tokens for Sonnet with use1M=true (model is claude-sonnet-4-5)", () => {
      const usage = createMockUsage(700_000); // 70% of 1M
      const result = checkAutoCompaction(usage, KNOWN_MODELS.SONNET.id, true, true);

      expect(result.usagePercentage).toBe(70);
      expect(result.shouldShowWarning).toBe(true);
    });

    test("uses standard max_input_tokens when use1M=false", () => {
      const usage = createMockUsage(140_000); // 70% of 200k
      const result = checkAutoCompaction(usage, KNOWN_MODELS.SONNET.id, false, true);

      expect(result.usagePercentage).toBe(70);
      expect(result.shouldShowWarning).toBe(true);
    });

    test("ignores use1M for models that don't support it (GPT)", () => {
      const usage = createMockUsage(100_000, undefined, KNOWN_MODELS.GPT_MINI.id);
      // GPT Mini has 272k context, so 100k = 36.76%
      const result = checkAutoCompaction(usage, KNOWN_MODELS.GPT_MINI.id, true, true);

      // Should use standard 272k, not 1M (use1M ignored for GPT)
      expect(result.usagePercentage).toBeCloseTo(36.76, 1);
      expect(result.shouldShowWarning).toBe(false);
    });
  });

  describe("Edge Cases", () => {
    test("empty usageHistory array returns safe defaults", () => {
      const usage: WorkspaceUsageState = { usageHistory: [], totalTokens: 0 };
      const result = checkAutoCompaction(usage, KNOWN_MODELS.SONNET.id, false, true);

      expect(result.shouldShowWarning).toBe(false);
      expect(result.usagePercentage).toBe(0);
      expect(result.thresholdPercentage).toBe(70);
    });

    test("single entry in usageHistory works correctly", () => {
      const usage = createMockUsage(140_000);
      const result = checkAutoCompaction(usage, KNOWN_MODELS.SONNET.id, false, true);

      expect(result.shouldShowWarning).toBe(true);
      expect(result.usagePercentage).toBe(70);
    });

    test("custom threshold parameter (80%)", () => {
      const usage = createMockUsage(140_000); // 70% of context
      const result = checkAutoCompaction(usage, KNOWN_MODELS.SONNET.id, false, true, 0.8); // 80% threshold

      // At 70%, should NOT show warning for 80% threshold (needs 70% advance = 10%)
      expect(result.shouldShowWarning).toBe(true); // 70% >= (80% - 10% = 70%)
      expect(result.usagePercentage).toBe(70);
      expect(result.thresholdPercentage).toBe(80);
    });

    test("custom warning advance (5% instead of 10%)", () => {
      const usage = createMockUsage(130_000); // 65% of context
      const result = checkAutoCompaction(usage, KNOWN_MODELS.SONNET.id, false, true, 0.7, 5);

      // At 65%, should show warning with 5% advance (70% - 5% = 65%)
      expect(result.shouldShowWarning).toBe(true);
      expect(result.usagePercentage).toBe(65);
      expect(result.thresholdPercentage).toBe(70);
    });

    test("handles zero tokens gracefully", () => {
      const usage: WorkspaceUsageState = {
        usageHistory: [
          {
            input: { tokens: 0 },
            cached: { tokens: 0 },
            cacheCreate: { tokens: 0 },
            output: { tokens: 0 },
            reasoning: { tokens: 0 },
            model: KNOWN_MODELS.SONNET.id,
          },
        ],
        totalTokens: 0,
      };

      const result = checkAutoCompaction(usage, KNOWN_MODELS.SONNET.id, false, true);

      expect(result.shouldShowWarning).toBe(false);
      expect(result.usagePercentage).toBe(0);
    });

    test("handles usage at exactly 100% of context", () => {
      const usage = createMockUsage(SONNET_MAX_TOKENS);
      const result = checkAutoCompaction(usage, KNOWN_MODELS.SONNET.id, false, true);

      expect(result.shouldShowWarning).toBe(true);
      expect(result.usagePercentage).toBe(100);
      expect(result.thresholdPercentage).toBe(70);
    });

    test("handles usage beyond 100% of context", () => {
      const usage = createMockUsage(SONNET_MAX_TOKENS + 50_000);
      const result = checkAutoCompaction(usage, KNOWN_MODELS.SONNET.id, false, true);

      expect(result.shouldShowWarning).toBe(true);
      expect(result.usagePercentage).toBe(125);
      expect(result.thresholdPercentage).toBe(70);
    });
  });

  describe("Percentage Calculation Accuracy", () => {
    test("calculates percentage correctly for various token counts", () => {
      // Test specific percentages
      const testCases = [
        { tokens: 20_000, expectedPercent: 10 },
        { tokens: 40_000, expectedPercent: 20 },
        { tokens: 100_000, expectedPercent: 50 },
        { tokens: 120_000, expectedPercent: 60 },
        { tokens: 140_000, expectedPercent: 70 },
        { tokens: 160_000, expectedPercent: 80 },
        { tokens: 180_000, expectedPercent: 90 },
      ];

      for (const { tokens, expectedPercent } of testCases) {
        const usage = createMockUsage(tokens);
        const result = checkAutoCompaction(usage, KNOWN_MODELS.SONNET.id, false, true);
        expect(result.usagePercentage).toBe(expectedPercent);
      }
    });

    test("handles fractional percentages correctly", () => {
      const usage = createMockUsage(123_456); // 61.728%
      const result = checkAutoCompaction(usage, KNOWN_MODELS.SONNET.id, false, true);

      expect(result.usagePercentage).toBeCloseTo(61.728, 2);
      expect(result.shouldShowWarning).toBe(true); // Above 60%
    });
  });
});
