import { z } from "zod";

const ModeSchema = z.enum(["plan", "exec"]);

export const TimingAnomalySchema = z.enum([
  "negative_duration",
  "tool_gt_total",
  "ttft_gt_total",
  "percent_out_of_range",
  "nan",
]);

export const ActiveStreamStatsSchema = z.object({
  messageId: z.string(),
  model: z.string(),
  mode: ModeSchema.optional(),

  elapsedMs: z.number(),
  ttftMs: z.number().nullable(),
  toolExecutionMs: z.number(),
  modelTimeMs: z.number(),
  streamingMs: z.number(),

  outputTokens: z.number(),
  reasoningTokens: z.number(),

  /** Total tokens streamed so far (text + reasoning + tool args). */
  liveTokenCount: z.number(),
  /** Tokens/sec, trailing window. */
  liveTPS: z.number(),

  invalid: z.boolean(),
  anomalies: z.array(TimingAnomalySchema),
});

export const CompletedStreamStatsSchema = z.object({
  messageId: z.string(),
  model: z.string(),
  mode: ModeSchema.optional(),

  totalDurationMs: z.number(),
  ttftMs: z.number().nullable(),
  toolExecutionMs: z.number(),
  modelTimeMs: z.number(),
  streamingMs: z.number(),

  outputTokens: z.number(),
  reasoningTokens: z.number(),

  invalid: z.boolean(),
  anomalies: z.array(TimingAnomalySchema),
});

export const ModelTimingStatsSchema = z.object({
  model: z.string(),
  mode: ModeSchema.optional(),

  totalDurationMs: z.number(),
  totalToolExecutionMs: z.number(),
  totalStreamingMs: z.number(),

  totalTtftMs: z.number(),
  ttftCount: z.number(),
  responseCount: z.number(),

  totalOutputTokens: z.number(),
  totalReasoningTokens: z.number(),
});

export const SessionTimingStatsSchema = z.object({
  totalDurationMs: z.number(),
  totalToolExecutionMs: z.number(),
  totalStreamingMs: z.number(),

  totalTtftMs: z.number(),
  ttftCount: z.number(),
  responseCount: z.number(),

  totalOutputTokens: z.number(),
  totalReasoningTokens: z.number(),

  /** Per-model breakdown (key is stable identifier like normalizeGatewayModel(model) or model:mode). */
  byModel: z.record(z.string(), ModelTimingStatsSchema),
});

export const WorkspaceStatsSnapshotSchema = z.object({
  workspaceId: z.string(),
  generatedAt: z.number(),

  active: ActiveStreamStatsSchema.optional(),
  lastRequest: CompletedStreamStatsSchema.optional(),
  session: SessionTimingStatsSchema.optional(),
});

export const SessionTimingFileSchema = z.object({
  version: z.literal(1),
  lastRequest: CompletedStreamStatsSchema.optional(),
  session: SessionTimingStatsSchema,
});

// Convenient TypeScript type exports
export type TimingAnomaly = z.infer<typeof TimingAnomalySchema>;
export type ActiveStreamStats = z.infer<typeof ActiveStreamStatsSchema>;
export type CompletedStreamStats = z.infer<typeof CompletedStreamStatsSchema>;
export type ModelTimingStats = z.infer<typeof ModelTimingStatsSchema>;
export type SessionTimingStats = z.infer<typeof SessionTimingStatsSchema>;
export type WorkspaceStatsSnapshot = z.infer<typeof WorkspaceStatsSnapshotSchema>;
export type SessionTimingFile = z.infer<typeof SessionTimingFileSchema>;
