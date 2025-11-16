import type { ChatUsageDisplay } from "./usageAggregator";
import { getModelStats } from "./modelStats";
import { supports1MContext } from "../ai/models";

export const TOKEN_COMPONENT_COLORS = {
  cached: "var(--color-token-cached)",
  input: "var(--color-token-input)",
  output: "var(--color-token-output)",
  thinking: "var(--color-thinking-mode)",
} as const;

export interface TokenSegment {
  type: "cached" | "cacheCreate" | "input" | "output" | "reasoning";
  tokens: number;
  percentage: number;
  color: string;
}

export interface TokenMeterData {
  segments: TokenSegment[];
  totalTokens: number;
  maxTokens?: number;
  totalPercentage: number;
}

interface SegmentDef {
  type: TokenSegment["type"];
  key: "input" | "cached" | "cacheCreate" | "output" | "reasoning";
  color: string;
  label: string;
}

const SEGMENT_DEFS: SegmentDef[] = [
  { type: "cached", key: "cached", color: TOKEN_COMPONENT_COLORS.cached, label: "Cache Read" },
  {
    type: "cacheCreate",
    key: "cacheCreate",
    color: TOKEN_COMPONENT_COLORS.cached,
    label: "Cache Create",
  },
  { type: "input", key: "input", color: TOKEN_COMPONENT_COLORS.input, label: "Input" },
  { type: "output", key: "output", color: TOKEN_COMPONENT_COLORS.output, label: "Output" },
  {
    type: "reasoning",
    key: "reasoning",
    color: TOKEN_COMPONENT_COLORS.thinking,
    label: "Thinking",
  },
];

/**
 * Calculate token meter data. When verticalProportions is true, segments are sized
 * proportionally to the request (e.g., 50% cached, 30% input) rather than context window.
 */
export function calculateTokenMeterData(
  usage: ChatUsageDisplay | undefined,
  model: string,
  use1M: boolean,
  verticalProportions = false
): TokenMeterData {
  if (!usage) return { segments: [], totalTokens: 0, totalPercentage: 0 };

  const modelStats = getModelStats(model);
  const maxTokens = use1M && supports1MContext(model) ? 1_000_000 : modelStats?.max_input_tokens;

  const totalUsed =
    usage.input.tokens +
    usage.cached.tokens +
    usage.cacheCreate.tokens +
    usage.output.tokens +
    usage.reasoning.tokens;

  const toPercentage = (tokens: number) => {
    if (verticalProportions) {
      return totalUsed > 0 ? (tokens / totalUsed) * 100 : 0;
    }
    return maxTokens ? (tokens / maxTokens) * 100 : totalUsed > 0 ? (tokens / totalUsed) * 100 : 0;
  };

  const segments = SEGMENT_DEFS.filter((def) => usage[def.key].tokens > 0).map((def) => ({
    type: def.type,
    tokens: usage[def.key].tokens,
    percentage: toPercentage(usage[def.key].tokens),
    color: def.color,
  }));

  const contextPercentage = maxTokens ? (totalUsed / maxTokens) * 100 : 100;

  return {
    segments,
    totalTokens: totalUsed,
    maxTokens,
    totalPercentage: verticalProportions
      ? maxTokens
        ? (totalUsed / maxTokens) * 100
        : 0
      : contextPercentage,
  };
}

export function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens.toLocaleString();
}

export function getSegmentLabel(type: TokenSegment["type"]): string {
  return SEGMENT_DEFS.find((def) => def.type === type)?.label ?? type;
}
