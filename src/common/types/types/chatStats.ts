import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";

export interface TokenConsumer {
  name: string; // "User", "Assistant", "bash", "readFile", etc.
  tokens: number; // Total token count for this consumer
  percentage: number; // % of total tokens
  fixedTokens?: number; // Fixed overhead (e.g., tool definitions)
  variableTokens?: number; // Variable usage (e.g., actual tool calls, text)
}

export interface ChatStats {
  consumers: TokenConsumer[]; // Sorted descending by token count
  totalTokens: number;
  model: string;
  tokenizerName: string; // e.g., "o200k_base", "claude"
  usageHistory: ChatUsageDisplay[]; // Ordered array of actual usage statistics from API responses
}
