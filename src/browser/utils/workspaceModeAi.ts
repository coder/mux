import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import {
  coerceOpenAIReasoningMode,
  coerceThinkingLevel,
  type OpenAIReasoningMode,
  type ThinkingLevel,
} from "@/common/types/thinking";
import { normalizeAgentId as normalizeWorkspaceAgentId } from "@/common/utils/agentIds";

export type WorkspaceAISettingsCache = Partial<
  Record<
    string,
    { model: string; thinkingLevel: ThinkingLevel; reasoningMode?: OpenAIReasoningMode }
  >
>;

function normalizeAgentId(agentId: string): string {
  return normalizeWorkspaceAgentId(agentId, "exec");
}

/**
 * Field-wise configured defaults for an agent, walking the base chain like
 * the backend's resolveAgentAiSettings so custom agents (base: exec) inherit
 * an ancestor's model/thinking/pro defaults together (persisting an inherited
 * pro without its pro-capable model would let request gating drop it).
 *
 * Model/thinking inherit only through DECLARED bases: the implicit fallback
 * for unknown agents (plan -> plan, otherwise exec) contributes reasoningMode
 * alone, so desktop mode switches to unconfigured agents keep the workspace's
 * current model instead of yanking it to exec's configured default.
 */
export function resolveConfiguredAiDefaults(
  agentId: string,
  agentAiDefaults: AgentAiDefaults,
  agentBaseById?: ReadonlyMap<string, string | undefined>
): { modelString?: string; thinkingLevel?: ThinkingLevel; reasoningMode?: OpenAIReasoningMode } {
  const visited = new Set<string>();
  let cursor = agentId;
  let declaredChain = true;
  let modelString: string | undefined;
  let thinkingLevel: ThinkingLevel | undefined;
  let reasoningMode: OpenAIReasoningMode | undefined;
  while (!visited.has(cursor)) {
    visited.add(cursor);
    const entry = agentAiDefaults[cursor];
    if (declaredChain) {
      if (modelString === undefined) {
        const candidate = typeof entry?.modelString === "string" ? entry.modelString.trim() : "";
        if (candidate.length > 0) {
          modelString = candidate;
        }
      }
      thinkingLevel ??= coerceThinkingLevel(entry?.thinkingLevel) ?? undefined;
    }
    reasoningMode ??= coerceOpenAIReasoningMode(entry?.reasoningMode) ?? undefined;
    if (modelString !== undefined && thinkingLevel !== undefined && reasoningMode !== undefined) {
      break;
    }
    const declaredBase = agentBaseById?.get(cursor);
    if (declaredBase == null) {
      declaredChain = false;
    }
    cursor = declaredBase ?? (cursor === "plan" ? "plan" : "exec");
  }
  return { modelString, thinkingLevel, reasoningMode };
}

/** Reasoning-mode-only view of resolveConfiguredAiDefaults. */
export function resolveConfiguredReasoningModeDefault(
  agentId: string,
  agentAiDefaults: AgentAiDefaults,
  agentBaseById?: ReadonlyMap<string, string | undefined>
): OpenAIReasoningMode | undefined {
  return resolveConfiguredAiDefaults(agentId, agentAiDefaults, agentBaseById).reasoningMode;
}

// Keep agent -> model/thinking precedence in one place so mode switches that send immediately
// (like propose_plan Implement / Continue in Auto) resolve the same settings as sync effects.
export function resolveWorkspaceAiSettingsForAgent(args: {
  agentId: string;
  agentAiDefaults: AgentAiDefaults;
  workspaceByAgent?: WorkspaceAISettingsCache;
  useWorkspaceByAgentFallback?: boolean;
  fallbackModel: string;
  existingModel: string;
  existingThinking: ThinkingLevel;
  existingReasoningMode?: OpenAIReasoningMode;
  /** Agent id -> base id, for base-chain reasoning-mode inheritance (custom agents). */
  agentBaseById?: ReadonlyMap<string, string | undefined>;
}): {
  resolvedModel: string;
  resolvedThinking: ThinkingLevel;
  resolvedReasoningMode: OpenAIReasoningMode;
} {
  const normalizedAgentId = normalizeAgentId(args.agentId);
  const workspaceOverride = args.workspaceByAgent?.[normalizedAgentId];

  // Field-wise across the agent's own entry then its base chain: an agent
  // inheriting GPT-5.6 + pro from its base must resolve both together even
  // when the active workspace runs a different provider's model.
  const configuredDefaults = resolveConfiguredAiDefaults(
    normalizedAgentId,
    args.agentAiDefaults,
    args.agentBaseById
  );
  const configuredModel = configuredDefaults.modelString;
  const workspaceOverrideModel =
    args.useWorkspaceByAgentFallback && typeof workspaceOverride?.model === "string"
      ? workspaceOverride.model
      : undefined;
  const inheritedModelCandidate =
    workspaceOverrideModel ??
    (typeof args.existingModel === "string" ? args.existingModel : undefined) ??
    "";
  const inheritedModel = inheritedModelCandidate.trim();
  const resolvedModel =
    configuredModel && configuredModel.length > 0
      ? configuredModel
      : inheritedModel.length > 0
        ? inheritedModel
        : args.fallbackModel;

  // Persisted workspace settings can be stale/corrupt; re-validate inherited values
  // so mode sync keeps self-healing behavior instead of propagating invalid options.
  const workspaceOverrideThinking = args.useWorkspaceByAgentFallback
    ? coerceThinkingLevel(workspaceOverride?.thinkingLevel)
    : undefined;
  const inheritedThinking = workspaceOverrideThinking ?? coerceThinkingLevel(args.existingThinking);
  const resolvedThinking = configuredDefaults.thinkingLevel ?? inheritedThinking ?? "off";

  // Configured agent defaults win, mirroring model/thinking precedence (only
  // explicit "pro"/"standard" are persisted there, so absent falls through);
  // the base chain contributes when the agent has no own entry, matching ACP
  // resolution and the Settings card display. Otherwise restore the agent's
  // saved pro-mode choice alongside model/thinking on explicit switches, else
  // inherit the workspace's current mode.
  // When a per-agent entry exists but lacks reasoningMode (legacy entry saved
  // before pro mode shipped), treat absent as "standard" — matching the
  // WorkspaceContext seeding semantics — instead of inheriting a possibly-pro
  // workspace mode from the previously active agent.
  const resolvedReasoningMode =
    configuredDefaults.reasoningMode ??
    (args.useWorkspaceByAgentFallback && workspaceOverride != null
      ? (coerceOpenAIReasoningMode(workspaceOverride.reasoningMode) ?? "standard")
      : (coerceOpenAIReasoningMode(args.existingReasoningMode) ?? "standard"));

  return { resolvedModel, resolvedThinking, resolvedReasoningMode };
}
