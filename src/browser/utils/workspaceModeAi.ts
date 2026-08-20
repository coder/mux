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
 * Resolves the configured reasoning-mode default for an agent, walking the
 * base chain like the backend's resolveAgentAiSettings so custom agents
 * (base: exec) inherit an ancestor's pro default. Unknown agents fall back to
 * the same default base (plan -> plan, otherwise exec).
 */
export function resolveConfiguredReasoningModeDefault(
  agentId: string,
  agentAiDefaults: AgentAiDefaults,
  agentBaseById?: ReadonlyMap<string, string | undefined>
): OpenAIReasoningMode | undefined {
  const visited = new Set<string>();
  let cursor = agentId;
  while (!visited.has(cursor)) {
    visited.add(cursor);
    const configured = coerceOpenAIReasoningMode(agentAiDefaults[cursor]?.reasoningMode);
    if (configured != null) {
      return configured;
    }
    cursor = agentBaseById?.get(cursor) ?? (cursor === "plan" ? "plan" : "exec");
  }
  return undefined;
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
  const globalDefault = args.agentAiDefaults[normalizedAgentId];
  const workspaceOverride = args.workspaceByAgent?.[normalizedAgentId];

  const configuredModelCandidate = globalDefault?.modelString;
  const configuredModel =
    typeof configuredModelCandidate === "string" ? configuredModelCandidate.trim() : undefined;
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
  const resolvedThinking =
    coerceThinkingLevel(globalDefault?.thinkingLevel) ?? inheritedThinking ?? "off";

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
    resolveConfiguredReasoningModeDefault(
      normalizedAgentId,
      args.agentAiDefaults,
      args.agentBaseById
    ) ??
    (args.useWorkspaceByAgentFallback && workspaceOverride != null
      ? (coerceOpenAIReasoningMode(workspaceOverride.reasoningMode) ?? "standard")
      : (coerceOpenAIReasoningMode(args.existingReasoningMode) ?? "standard"));

  return { resolvedModel, resolvedThinking, resolvedReasoningMode };
}
