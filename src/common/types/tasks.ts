import assert from "@/common/utils/assert";
import { coerceThinkingLevel, type ThinkingLevel } from "./thinking";

export interface TaskSettings {
  maxParallelAgentTasks: number;
  maxTaskNestingDepth: number;
}

export const TASK_SETTINGS_LIMITS = {
  maxParallelAgentTasks: { min: 1, max: 10, default: 3 },
  maxTaskNestingDepth: { min: 1, max: 5, default: 3 },
} as const;

export const DEFAULT_TASK_SETTINGS: TaskSettings = {
  maxParallelAgentTasks: TASK_SETTINGS_LIMITS.maxParallelAgentTasks.default,
  maxTaskNestingDepth: TASK_SETTINGS_LIMITS.maxTaskNestingDepth.default,
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

  const result: TaskSettings = {
    maxParallelAgentTasks,
    maxTaskNestingDepth,
  };

  assert(
    Number.isInteger(result.maxParallelAgentTasks),
    "normalizeTaskSettings: maxParallelAgentTasks must be an integer"
  );
  assert(
    Number.isInteger(result.maxTaskNestingDepth),
    "normalizeTaskSettings: maxTaskNestingDepth must be an integer"
  );

  return result;
}
