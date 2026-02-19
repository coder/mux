import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import { coerceThinkingLevel, type ThinkingLevel } from "@/common/types/thinking";

function normalizeAgentId(agentId: string): string {
  return typeof agentId === "string" && agentId.trim().length > 0
    ? agentId.trim().toLowerCase()
    : "exec";
}

// Keep agent -> model/thinking precedence in one place so mode switches that send immediately
// (like propose_plan Implement / Start Orchestrator) resolve the same settings as sync effects.
export function resolveWorkspaceAiSettingsForAgent(args: {
  agentId: string;
  agentAiDefaults: AgentAiDefaults;
  fallbackModel: string;
  existingModel: string;
  existingThinking: ThinkingLevel;
}): { resolvedModel: string; resolvedThinking: ThinkingLevel } {
  const normalizedAgentId = normalizeAgentId(args.agentId);
  const globalDefault = args.agentAiDefaults[normalizedAgentId];

  const configuredModelCandidate = globalDefault?.modelString;
  const configuredModel =
    typeof configuredModelCandidate === "string" ? configuredModelCandidate.trim() : undefined;
  const inheritedModelCandidate =
    typeof args.existingModel === "string" ? args.existingModel : undefined;
  const inheritedModel = inheritedModelCandidate?.trim() ?? "";
  const resolvedModel =
    configuredModel && configuredModel.length > 0
      ? configuredModel
      : inheritedModel.length > 0
        ? inheritedModel
        : args.fallbackModel;

  // Persisted workspace settings can be stale/corrupt; re-validate inherited values
  // so mode sync keeps self-healing behavior instead of propagating invalid options.
  const inheritedThinking = coerceThinkingLevel(args.existingThinking);
  const resolvedThinking =
    coerceThinkingLevel(globalDefault?.thinkingLevel) ?? inheritedThinking ?? "off";

  return { resolvedModel, resolvedThinking };
}
