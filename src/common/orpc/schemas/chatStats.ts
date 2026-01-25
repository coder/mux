import { z } from "zod";

/** Top file path entry for file_read/file_edit consumers */
export const TopFilePathSchema = z.object({
  path: z.string().meta({ description: "File path (relative or absolute)" }),
  tokens: z.number().meta({ description: "Token count for this file" }),
});

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
  topFilePaths: z
    .array(TopFilePathSchema)
    .optional()
    .meta({ description: "Top 10 files by token count aggregated across all file tools" }),
});

/**
 * Cumulative session usage file format.
 * Stored in ~/.mux/sessions/{workspaceId}/session-usage.json
 */
export const SessionUsageFileSchema = z.object({
  byModel: z.record(z.string(), ChatUsageDisplaySchema),
  lastRequest: z
    .object({
      model: z.string(),
      usage: ChatUsageDisplaySchema,
      timestamp: z.number(),
    })
    .optional(),
  version: z.literal(1),
});
