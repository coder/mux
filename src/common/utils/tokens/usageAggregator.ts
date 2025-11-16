/**
 * Usage aggregation utilities for cost calculation
 *
 * IMPORTANT: This file must NOT import tokenizer to avoid pulling
 * 2MB+ of encoding data into the renderer process.
 *
 * Separated from tokenStatsCalculator.ts to keep tokenizer in main process only.
 */

export interface ChatUsageComponent {
  tokens: number;
  cost_usd?: number; // undefined if model pricing unknown
}

/**
 * Enhanced usage type for display that includes provider-specific cache stats
 */
export interface ChatUsageDisplay {
  // Input is the part of the input that was not cached. So,
  // totalInput = input + cached (cacheCreate is separate for billing)
  input: ChatUsageComponent;
  cached: ChatUsageComponent;
  cacheCreate: ChatUsageComponent; // Cache creation tokens (separate billing concept)

  // Output is the part of the output excluding reasoning, so
  // totalOutput = output + reasoning
  output: ChatUsageComponent;
  reasoning: ChatUsageComponent;

  // Optional model field for display purposes (context window calculation, etc.)
  model?: string;
}

/**
 * Sum multiple ChatUsageDisplay objects into a single cumulative display
 * Used for showing total costs across multiple API responses
 */
export function sumUsageHistory(usageHistory: ChatUsageDisplay[]): ChatUsageDisplay | undefined {
  if (usageHistory.length === 0) return undefined;

  // Track if any costs are undefined (model pricing unknown)
  let hasUndefinedCosts = false;

  const sum: ChatUsageDisplay = {
    input: { tokens: 0, cost_usd: 0 },
    cached: { tokens: 0, cost_usd: 0 },
    cacheCreate: { tokens: 0, cost_usd: 0 },
    output: { tokens: 0, cost_usd: 0 },
    reasoning: { tokens: 0, cost_usd: 0 },
  };

  for (const usage of usageHistory) {
    // Iterate over each component and sum tokens and costs
    const componentKeys: Array<"input" | "cached" | "cacheCreate" | "output" | "reasoning"> = [
      "input",
      "cached",
      "cacheCreate",
      "output",
      "reasoning",
    ];
    for (const key of componentKeys) {
      sum[key].tokens += usage[key].tokens;
      if (usage[key].cost_usd === undefined) {
        hasUndefinedCosts = true;
      } else {
        sum[key].cost_usd = (sum[key].cost_usd ?? 0) + (usage[key].cost_usd ?? 0);
      }
    }
  }

  // If any costs were undefined, set all to undefined
  if (hasUndefinedCosts) {
    sum.input.cost_usd = undefined;
    sum.cached.cost_usd = undefined;
    sum.cacheCreate.cost_usd = undefined;
    sum.output.cost_usd = undefined;
    sum.reasoning.cost_usd = undefined;
  }

  return sum;
}
