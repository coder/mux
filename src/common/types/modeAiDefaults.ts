import { AGENT_MODE_VALUES, type AgentMode } from "./mode";
import { coerceThinkingLevel, type ThinkingLevel } from "./thinking";

export interface ModeAiDefaultsEntry {
  modelString?: string;
  thinkingLevel?: ThinkingLevel;
}

export type ModeAiDefaults = Partial<Record<AgentMode, ModeAiDefaultsEntry>>;

const AGENT_MODE_SET = new Set<string>(AGENT_MODE_VALUES);

export function normalizeModeAiDefaults(raw: unknown): ModeAiDefaults {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : ({} as const);

  const result: ModeAiDefaults = {};

  for (const [modeRaw, entryRaw] of Object.entries(record)) {
    const mode = modeRaw.trim().toLowerCase();
    if (!mode) continue;
    if (!AGENT_MODE_SET.has(mode)) continue;
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

    result[mode as AgentMode] = { modelString, thinkingLevel };
  }

  return result;
}
