import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

const REMOVED_BUILTIN_AGENT_FALLBACKS: Readonly<Record<string, string>> = {
  ask: WORKSPACE_DEFAULTS.agentId,
};

export function normalizeAgentId(
  value: unknown,
  fallback: string = WORKSPACE_DEFAULTS.agentId
): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return fallback;
  }

  return normalized;
}

export function resolveRemovedBuiltinAgentId(
  value: unknown,
  availableAgentIds: Iterable<string>,
  fallback: string = WORKSPACE_DEFAULTS.agentId
): string {
  const normalized = normalizeAgentId(value, fallback);
  const replacement = REMOVED_BUILTIN_AGENT_FALLBACKS[normalized];
  if (!replacement) {
    return normalized;
  }

  for (const candidate of availableAgentIds) {
    if (normalizeAgentId(candidate, "") === normalized) {
      return normalized;
    }
  }

  return replacement;
}
