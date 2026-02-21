import assert from "@/common/utils/assert";
import { coerceThinkingLevel, type ThinkingLevel } from "./thinking";

export const PLAN_SUBAGENT_EXECUTOR_ROUTING_VALUES = ["exec", "orchestrator", "auto"] as const;

export type PlanSubagentExecutorRouting = (typeof PLAN_SUBAGENT_EXECUTOR_ROUTING_VALUES)[number];

export interface TaskSettings {
  maxParallelAgentTasks: number;
  maxTaskNestingDepth: number;

  /**
   * When enabled, clicking "Implement" in propose_plan first replaces chat history with the plan
   * (same behavior as "Start Here").
   */
  proposePlanImplementReplacesChatHistory?: boolean;

  /** Controls plan sub-agent propose_plan handoff target: Exec, Orchestrator, or auto routing. */
  planSubagentExecutorRouting?: PlanSubagentExecutorRouting;

  /**
   * @deprecated Use planSubagentExecutorRouting instead.
   * Kept for downgrade compatibility with older config files.
   */
  planSubagentDefaultsToOrchestrator?: boolean;

  // System 1: bash output compaction (log filtering)
  bashOutputCompactionMinLines?: number;
  bashOutputCompactionMinTotalBytes?: number;
  bashOutputCompactionMaxKeptLines?: number;
  bashOutputCompactionTimeoutMs?: number;
  bashOutputCompactionHeuristicFallback?: boolean;
}

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

export const DEFAULT_TASK_SETTINGS: TaskSettings = {
  maxParallelAgentTasks: TASK_SETTINGS_LIMITS.maxParallelAgentTasks.default,
  maxTaskNestingDepth: TASK_SETTINGS_LIMITS.maxTaskNestingDepth.default,
  proposePlanImplementReplacesChatHistory: false,
  planSubagentExecutorRouting: "exec",
  planSubagentDefaultsToOrchestrator: false,

  bashOutputCompactionMinLines:
    SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinLines.default,
  bashOutputCompactionMinTotalBytes:
    SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinTotalBytes.default,
  bashOutputCompactionMaxKeptLines:
    SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMaxKeptLines.default,
  bashOutputCompactionTimeoutMs:
    SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionTimeoutMs.default,
  bashOutputCompactionHeuristicFallback: true,
};

export interface SubagentAiDefaultsEntry {
  modelString?: string;
  thinkingLevel?: ThinkingLevel;
}

export type SubagentAiDefaults = Record<string, SubagentAiDefaultsEntry>;

export function normalizeSubagentAiDefaults(raw: unknown): SubagentAiDefaults {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : ({} as const);

  const result: SubagentAiDefaults = {};

  for (const [agentTypeRaw, entryRaw] of Object.entries(record)) {
    const agentType = agentTypeRaw.trim().toLowerCase();
    if (!agentType) continue;
    if (agentType === "exec") continue;
    if (!entryRaw || typeof entryRaw !== "object") continue;

    const entry = entryRaw as Record<string, unknown>;

    const modelString =
      typeof entry.modelString === "string" && entry.modelString.trim().length > 0
        ? entry.modelString.trim()
        : undefined;

    const thinkingLevel = coerceThinkingLevel(entry.thinkingLevel);

    if (!modelString && !thinkingLevel) {
      continue;
    }

    result[agentType] = { modelString, thinkingLevel };
  }

  return result;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const rounded = Math.floor(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

export function isPlanSubagentExecutorRouting(
  value: unknown
): value is PlanSubagentExecutorRouting {
  return (
    typeof value === "string" &&
    PLAN_SUBAGENT_EXECUTOR_ROUTING_VALUES.some((candidate) => candidate === value)
  );
}

export function normalizeTaskSettings(raw: unknown): TaskSettings {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : ({} as const);

  const maxParallelAgentTasks = clampInt(
    record.maxParallelAgentTasks,
    DEFAULT_TASK_SETTINGS.maxParallelAgentTasks,
    TASK_SETTINGS_LIMITS.maxParallelAgentTasks.min,
    TASK_SETTINGS_LIMITS.maxParallelAgentTasks.max
  );
  const maxTaskNestingDepth = clampInt(
    record.maxTaskNestingDepth,
    DEFAULT_TASK_SETTINGS.maxTaskNestingDepth,
    TASK_SETTINGS_LIMITS.maxTaskNestingDepth.min,
    TASK_SETTINGS_LIMITS.maxTaskNestingDepth.max
  );

  const proposePlanImplementReplacesChatHistory =
    typeof record.proposePlanImplementReplacesChatHistory === "boolean"
      ? record.proposePlanImplementReplacesChatHistory
      : (DEFAULT_TASK_SETTINGS.proposePlanImplementReplacesChatHistory ?? false);

  const normalizedPlanSubagentExecutorRouting = isPlanSubagentExecutorRouting(
    record.planSubagentExecutorRouting
  )
    ? record.planSubagentExecutorRouting
    : undefined;

  const migratedPlanSubagentExecutorRouting =
    normalizedPlanSubagentExecutorRouting ??
    (typeof record.planSubagentDefaultsToOrchestrator === "boolean"
      ? record.planSubagentDefaultsToOrchestrator
        ? "orchestrator"
        : "exec"
      : undefined);

  const planSubagentExecutorRouting =
    migratedPlanSubagentExecutorRouting ??
    DEFAULT_TASK_SETTINGS.planSubagentExecutorRouting ??
    "exec";

  // Keep the deprecated boolean in sync for downgrade compatibility.
  const planSubagentDefaultsToOrchestrator = planSubagentExecutorRouting === "orchestrator";

  const bashOutputCompactionMinLines = clampInt(
    record.bashOutputCompactionMinLines,
    SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinLines.default,
    SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinLines.min,
    SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinLines.max
  );
  const bashOutputCompactionMinTotalBytes = clampInt(
    record.bashOutputCompactionMinTotalBytes,
    SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinTotalBytes.default,
    SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinTotalBytes.min,
    SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinTotalBytes.max
  );
  const bashOutputCompactionMaxKeptLines = clampInt(
    record.bashOutputCompactionMaxKeptLines,
    SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMaxKeptLines.default,
    SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMaxKeptLines.min,
    SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMaxKeptLines.max
  );
  const bashOutputCompactionTimeoutMsRaw = clampInt(
    record.bashOutputCompactionTimeoutMs,
    SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionTimeoutMs.default,
    SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionTimeoutMs.min,
    SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionTimeoutMs.max
  );

  const bashOutputCompactionHeuristicFallback =
    typeof record.bashOutputCompactionHeuristicFallback === "boolean"
      ? record.bashOutputCompactionHeuristicFallback
      : (DEFAULT_TASK_SETTINGS.bashOutputCompactionHeuristicFallback ?? true);
  const bashOutputCompactionTimeoutMs = Math.floor(bashOutputCompactionTimeoutMsRaw / 1000) * 1000;

  const result: TaskSettings = {
    maxParallelAgentTasks,
    maxTaskNestingDepth,
    proposePlanImplementReplacesChatHistory,
    planSubagentExecutorRouting,
    planSubagentDefaultsToOrchestrator,
    bashOutputCompactionMinLines,
    bashOutputCompactionMinTotalBytes,
    bashOutputCompactionMaxKeptLines,
    bashOutputCompactionTimeoutMs,
    bashOutputCompactionHeuristicFallback,
  };

  assert(
    Number.isInteger(maxParallelAgentTasks),
    "normalizeTaskSettings: maxParallelAgentTasks must be an integer"
  );
  assert(
    Number.isInteger(maxTaskNestingDepth),
    "normalizeTaskSettings: maxTaskNestingDepth must be an integer"
  );

  assert(
    typeof proposePlanImplementReplacesChatHistory === "boolean",
    "normalizeTaskSettings: proposePlanImplementReplacesChatHistory must be a boolean"
  );

  assert(
    isPlanSubagentExecutorRouting(planSubagentExecutorRouting),
    "normalizeTaskSettings: planSubagentExecutorRouting must be exec, orchestrator, or auto"
  );

  assert(
    typeof planSubagentDefaultsToOrchestrator === "boolean",
    "normalizeTaskSettings: planSubagentDefaultsToOrchestrator must be a boolean"
  );

  assert(
    Number.isInteger(bashOutputCompactionMinLines),
    "normalizeTaskSettings: bashOutputCompactionMinLines must be an integer"
  );
  assert(
    Number.isInteger(bashOutputCompactionMinTotalBytes),
    "normalizeTaskSettings: bashOutputCompactionMinTotalBytes must be an integer"
  );
  assert(
    Number.isInteger(bashOutputCompactionMaxKeptLines),
    "normalizeTaskSettings: bashOutputCompactionMaxKeptLines must be an integer"
  );
  assert(
    Number.isInteger(bashOutputCompactionTimeoutMs),
    "normalizeTaskSettings: bashOutputCompactionTimeoutMs must be an integer"
  );

  assert(
    typeof bashOutputCompactionHeuristicFallback === "boolean",
    "normalizeTaskSettings: bashOutputCompactionHeuristicFallback must be a boolean"
  );
  assert(
    bashOutputCompactionTimeoutMs % 1000 === 0,
    "normalizeTaskSettings: bashOutputCompactionTimeoutMs must be a whole number of seconds"
  );

  return result;
}
