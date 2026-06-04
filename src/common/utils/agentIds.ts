import { AgentIdSchema } from "@/common/schemas/ids";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

const REMOVED_BUILTIN_AGENT_FALLBACKS: Readonly<Record<string, string>> = {
  ask: WORKSPACE_DEFAULTS.agentId,
  auto: WORKSPACE_DEFAULTS.agentId,
  mux: WORKSPACE_DEFAULTS.agentId,
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

export function resolvePersistedAgentId(
  value: { agentId?: unknown; agentType?: unknown } | undefined,
  fallback: string = WORKSPACE_DEFAULTS.agentId
): string {
  if (value == null) {
    return fallback;
  }

  // Legacy task/workspace records may only have agentType. Coerce and validate
  // each field independently so blank or corrupt modern agentId values cannot
  // mask a valid legacy value.
  const agentId = normalizePersistedAgentCandidate(value.agentId);
  if (agentId != null) {
    return agentId;
  }

  const agentType = normalizePersistedAgentCandidate(value.agentType);
  if (agentType != null) {
    return agentType;
  }

  return fallback;
}

function normalizePersistedAgentCandidate(value: unknown): string | undefined {
  const normalized = normalizeAgentId(value, "");
  if (normalized.length === 0) {
    return undefined;
  }
  return AgentIdSchema.safeParse(normalized).success ? normalized : undefined;
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
