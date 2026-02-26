import { z } from "zod";

export const TASK_SETTINGS_LIMITS = {
  maxParallelAgentTasks: { min: 1, max: 256, default: 3 },
  maxTaskNestingDepth: { min: 1, max: 5, default: 3 },
} as const;

export const SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS = {
  bashOutputCompactionMinLines: { min: 0, max: 1_000, default: 10 },
  bashOutputCompactionMinTotalBytes: { min: 0, max: 16 * 1024, default: 4 * 1024 },
  bashOutputCompactionMaxKeptLines: { min: 1, max: 1_000, default: 40 },
  bashOutputCompactionTimeoutMs: { min: 1_000, max: 120_000, default: 5_000 },
} as const;

export const PlanSubagentExecutorRoutingSchema = z.enum(["exec", "orchestrator", "auto"]);

export type PlanSubagentExecutorRouting = z.infer<typeof PlanSubagentExecutorRoutingSchema>;

export const TaskSettingsSchema = z.object({
  maxParallelAgentTasks: z
    .number()
    .int()
    .min(TASK_SETTINGS_LIMITS.maxParallelAgentTasks.min)
    .max(TASK_SETTINGS_LIMITS.maxParallelAgentTasks.max)
    .optional(),
  maxTaskNestingDepth: z
    .number()
    .int()
    .min(TASK_SETTINGS_LIMITS.maxTaskNestingDepth.min)
    .max(TASK_SETTINGS_LIMITS.maxTaskNestingDepth.max)
    .optional(),
  proposePlanImplementReplacesChatHistory: z.boolean().optional(),
  planSubagentExecutorRouting: PlanSubagentExecutorRoutingSchema.optional(),
  planSubagentDefaultsToOrchestrator: z.boolean().optional(),
  bashOutputCompactionMinLines: z
    .number()
    .int()
    .min(SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinLines.min)
    .max(SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinLines.max)
    .optional(),
  bashOutputCompactionMinTotalBytes: z
    .number()
    .int()
    .min(SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinTotalBytes.min)
    .max(SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinTotalBytes.max)
    .optional(),
  bashOutputCompactionMaxKeptLines: z
    .number()
    .int()
    .min(SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMaxKeptLines.min)
    .max(SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMaxKeptLines.max)
    .optional(),
  bashOutputCompactionTimeoutMs: z
    .number()
    .int()
    .min(SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionTimeoutMs.min)
    .max(SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionTimeoutMs.max)
    .optional(),
  bashOutputCompactionHeuristicFallback: z.boolean().optional(),
});

export type TaskSettings = z.infer<typeof TaskSettingsSchema>;
