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

  // Restore the agent's saved pro-mode choice alongside model/thinking on
  // explicit switches; otherwise inherit the workspace's current mode.
  // (Agent AI defaults carry no reasoningMode — it is a per-workspace choice.)
  // When a per-agent entry exists but lacks reasoningMode (legacy entry saved
  // before pro mode shipped), treat absent as "standard" — matching the
  // WorkspaceContext seeding semantics — instead of inheriting a possibly-pro
  // workspace mode from the previously active agent.
  const resolvedReasoningMode =
    args.useWorkspaceByAgentFallback && workspaceOverride != null
      ? (coerceOpenAIReasoningMode(workspaceOverride.reasoningMode) ?? "standard")
      : (coerceOpenAIReasoningMode(args.existingReasoningMode) ?? "standard");

  return { resolvedModel, resolvedThinking, resolvedReasoningMode };
}
