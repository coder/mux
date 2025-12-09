import { z } from "zod";

export const TokenConsumerSchema = z.object({
  name: z.string().meta({ description: '"User", "Assistant", "bash", "readFile", etc.' }),
  tokens: z.number().meta({ description: "Total token count for this consumer" }),
  percentage: z.number().meta({ description: "% of total tokens" }),
  fixedTokens: z
    .number()
    .optional()
    .meta({ description: "Fixed overhead (e.g., tool definitions)" }),
  variableTokens: z
    .number()
    .optional()
    .meta({ description: "Variable usage (e.g., actual tool calls, text)" }),
});

export const ChatUsageComponentSchema = z.object({
  tokens: z.number(),
  cost_usd: z.number().optional(),
});

export const ChatUsageDisplaySchema = z.object({
  input: ChatUsageComponentSchema,
  cached: ChatUsageComponentSchema,
  cacheCreate: ChatUsageComponentSchema,
  output: ChatUsageComponentSchema,
  reasoning: ChatUsageComponentSchema,
  model: z.string().optional(),
});

export const ChatStatsSchema = z.object({
  consumers: z.array(TokenConsumerSchema).meta({ description: "Sorted descending by token count" }),
  totalTokens: z.number(),
  model: z.string(),
  tokenizerName: z.string().meta({ description: 'e.g., "o200k_base", "claude"' }),
  usageHistory: z
    .array(ChatUsageDisplaySchema)
    .meta({ description: "Ordered array of actual usage statistics from API responses" }),
});
