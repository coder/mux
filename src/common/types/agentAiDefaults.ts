import { AgentIdSchema } from "@/common/orpc/schemas";
import { coerceThinkingLevel, type ThinkingLevel } from "./thinking";

export interface AgentAiDefaultsEntry {
  modelString?: string;
  thinkingLevel?: ThinkingLevel;
}

export type AgentAiDefaults = Record<string, AgentAiDefaultsEntry>;

export function normalizeAgentAiDefaults(raw: unknown): AgentAiDefaults {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : ({} as const);

  const result: AgentAiDefaults = {};

  for (const [agentIdRaw, entryRaw] of Object.entries(record)) {
    const agentId = agentIdRaw.trim().toLowerCase();
    if (!agentId) continue;
    if (!AgentIdSchema.safeParse(agentId).success) continue;
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

    result[agentId] = { modelString, thinkingLevel };
  }

  return result;
}
