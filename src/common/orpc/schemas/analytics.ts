import { z } from "zod";

// ── Reusable row schemas (used by both oRPC output AND worker query validation) ──

/** Single row from DuckDB, validated before crossing worker→main boundary */
export const SummaryRowSchema = z.object({
  total_spend_usd: z.number(),
  today_spend_usd: z.number(),
  avg_daily_spend_usd: z.number(),
  cache_hit_ratio: z.number(),
  total_tokens: z.number(),
  total_responses: z.number(),
});
export type SummaryRow = z.infer<typeof SummaryRowSchema>;

export const SpendOverTimeRowSchema = z.object({
  bucket: z.string(),
  model: z.string(),
  cost_usd: z.number(),
});
export type SpendOverTimeRow = z.infer<typeof SpendOverTimeRowSchema>;

export const SpendByProjectRowSchema = z.object({
  project_name: z.string(),
  project_path: z.string(),
  cost_usd: z.number(),
  token_count: z.number(),
});
export type SpendByProjectRow = z.infer<typeof SpendByProjectRowSchema>;

export const SpendByModelRowSchema = z.object({
  model: z.string(),
  cost_usd: z.number(),
  token_count: z.number(),
  response_count: z.number(),
});
export type SpendByModelRow = z.infer<typeof SpendByModelRowSchema>;

export const TimingPercentilesRowSchema = z.object({
  p50: z.number(),
  p90: z.number(),
  p99: z.number(),
});
export type TimingPercentilesRow = z.infer<typeof TimingPercentilesRowSchema>;

export const HistogramBucketSchema = z.object({
  bucket: z.number(),
  count: z.number(),
});
export type HistogramBucket = z.infer<typeof HistogramBucketSchema>;

export const AgentCostRowSchema = z.object({
  agent_id: z.string(),
  cost_usd: z.number(),
  token_count: z.number(),
  response_count: z.number(),
});
export type AgentCostRow = z.infer<typeof AgentCostRowSchema>;

export const ProviderCacheHitModelRowSchema = z.object({
  model: z.string(),
  cached_tokens: z.number(),
  total_prompt_tokens: z.number(),
  response_count: z.number(),
});
export type ProviderCacheHitModelRow = z.infer<typeof ProviderCacheHitModelRowSchema>;

/** ETL input validation — each row extracted from chat.jsonl is validated before insert */
export const EventRowSchema = z.object({
  workspace_id: z.string(),
  project_path: z.string().nullable(),
  project_name: z.string().nullable(),
  workspace_name: z.string().nullable(),
  parent_workspace_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  timestamp: z.number().nullable(), // unix ms
  model: z.string().nullable(),
  thinking_level: z.string().nullable(),
  input_tokens: z.number().default(0),
  output_tokens: z.number().default(0),
  reasoning_tokens: z.number().default(0),
  cached_tokens: z.number().default(0),
  cache_create_tokens: z.number().default(0),
  input_cost_usd: z.number().default(0),
  output_cost_usd: z.number().default(0),
  reasoning_cost_usd: z.number().default(0),
  cached_cost_usd: z.number().default(0),
  total_cost_usd: z.number().default(0),
  duration_ms: z.number().nullable(),
  ttft_ms: z.number().nullable(),
  streaming_ms: z.number().nullable(),
  tool_execution_ms: z.number().nullable(),
  output_tps: z.number().nullable(),
  response_index: z.number().nullable(),
  is_sub_agent: z.boolean().default(false),
});
export type EventRow = z.infer<typeof EventRowSchema>;

// ── oRPC procedure schemas (camelCase for API contract) ──

export const analytics = {
  getSummary: {
    input: z.object({
      projectPath: z.string().nullish(),
      from: z.coerce.date().nullish(),
      to: z.coerce.date().nullish(),
    }),
    output: z.object({
      totalSpendUsd: z.number(),
      todaySpendUsd: z.number(),
      avgDailySpendUsd: z.number(),
      cacheHitRatio: z.number(),
      totalTokens: z.number(),
      totalResponses: z.number(),
    }),
  },
  getSpendOverTime: {
    input: z.object({
      projectPath: z.string().nullish(),
      granularity: z.enum(["hour", "day", "week"]),
      from: z.coerce.date().nullish(),
      to: z.coerce.date().nullish(),
    }),
    output: z.array(
      z.object({
        bucket: z.string(),
        costUsd: z.number(),
        model: z.string(),
      })
    ),
  },
  getSpendByProject: {
    input: z.object({
      from: z.coerce.date().nullish(),
      to: z.coerce.date().nullish(),
    }),
    output: z.array(
      z.object({
        projectName: z.string(),
        projectPath: z.string(),
        costUsd: z.number(),
        tokenCount: z.number(),
      })
    ),
  },
  getSpendByModel: {
    input: z.object({
      projectPath: z.string().nullish(),
      from: z.coerce.date().nullish(),
      to: z.coerce.date().nullish(),
    }),
    output: z.array(
      z.object({
        model: z.string(),
        costUsd: z.number(),
        tokenCount: z.number(),
        responseCount: z.number(),
      })
    ),
  },
  getTimingDistribution: {
    input: z.object({
      metric: z.enum(["ttft", "duration", "tps"]),
      projectPath: z.string().nullish(),
      from: z.coerce.date().nullish(),
      to: z.coerce.date().nullish(),
    }),
    output: z.object({
      p50: z.number(),
      p90: z.number(),
      p99: z.number(),
      histogram: z.array(z.object({ bucket: z.number(), count: z.number() })),
    }),
  },
  getAgentCostBreakdown: {
    input: z.object({
      projectPath: z.string().nullish(),
      from: z.coerce.date().nullish(),
      to: z.coerce.date().nullish(),
    }),
    output: z.array(
      z.object({
        agentId: z.string(),
        costUsd: z.number(),
        tokenCount: z.number(),
        responseCount: z.number(),
      })
    ),
  },
  getCacheHitRatioByProvider: {
    input: z.object({
      projectPath: z.string().nullish(),
      from: z.coerce.date().nullish(),
      to: z.coerce.date().nullish(),
    }),
    output: z.array(
      z.object({
        provider: z.string(),
        cacheHitRatio: z.number(),
        responseCount: z.number(),
      })
    ),
  },
  rebuildDatabase: {
    input: z.object({}),
    output: z.object({ success: z.boolean(), workspacesIngested: z.number() }),
  },
};
