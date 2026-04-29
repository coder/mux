import type {
  PlanSubagentExecutorRouting,
  TaskSettings as TaskSettingsOnDisk,
} from "@/common/config/schemas/taskSettings";
import { TASK_SETTINGS_LIMITS } from "@/common/config/schemas/taskSettings";
import type {
  SubagentAiDefaults,
  SubagentAiDefaultsEntry,
} from "@/common/config/schemas/appConfigOnDisk";
import assert from "@/common/utils/assert";
import { coerceThinkingLevel, type ThinkingLevel } from "./thinking";

export type { PlanSubagentExecutorRouting, SubagentAiDefaults, SubagentAiDefaultsEntry };
export { TASK_SETTINGS_LIMITS } from "@/common/config/schemas/taskSettings";

// Normalized runtime settings always include numeric task limits.
export type TaskSettings = Required<
  Pick<TaskSettingsOnDisk, "maxParallelAgentTasks" | "maxTaskNestingDepth">
> &
  Omit<TaskSettingsOnDisk, "maxParallelAgentTasks" | "maxTaskNestingDepth">;

export const DEFAULT_TASK_SETTINGS: TaskSettings = {
  maxParallelAgentTasks: TASK_SETTINGS_LIMITS.maxParallelAgentTasks.default,
  maxTaskNestingDepth: TASK_SETTINGS_LIMITS.maxTaskNestingDepth.default,
  proposePlanImplementReplacesChatHistory: false,
  preserveSubagentsUntilArchive: false,
  planSubagentExecutorRouting: "auto",
  planSubagentDefaultsToOrchestrator: false,
};

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

    const thinkingLevel: ThinkingLevel | undefined = coerceThinkingLevel(entry.thinkingLevel);

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
  return value === "exec" || value === "orchestrator" || value === "auto";
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

  const preserveSubagentsUntilArchive =
    typeof record.preserveSubagentsUntilArchive === "boolean"
      ? record.preserveSubagentsUntilArchive
      : DEFAULT_TASK_SETTINGS.preserveSubagentsUntilArchive;

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

  const result: TaskSettings = {
    maxParallelAgentTasks,
    maxTaskNestingDepth,
    proposePlanImplementReplacesChatHistory,
    preserveSubagentsUntilArchive,
    planSubagentExecutorRouting,
    planSubagentDefaultsToOrchestrator,
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
    typeof preserveSubagentsUntilArchive === "boolean",
    "normalizeTaskSettings: preserveSubagentsUntilArchive must be a boolean"
  );

  assert(
    isPlanSubagentExecutorRouting(planSubagentExecutorRouting),
    "normalizeTaskSettings: planSubagentExecutorRouting must be exec, orchestrator, or auto"
  );

  assert(
    typeof planSubagentDefaultsToOrchestrator === "boolean",
    "normalizeTaskSettings: planSubagentDefaultsToOrchestrator must be a boolean"
  );

  return result;
}
