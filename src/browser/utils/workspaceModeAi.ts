import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import { coerceThinkingLevel, type ThinkingLevel } from "@/common/types/thinking";

export type WorkspaceAISettingsCache = Partial<
  Record<string, { model: string; thinkingLevel: ThinkingLevel }>
>;

function normalizeAgentId(agentId: string): string {
  return typeof agentId === "string" && agentId.trim().length > 0
    ? agentId.trim().toLowerCase()
    : "exec";
}

// Keep agent -> model/thinking precedence in one place so mode switches that send immediately
// (like propose_plan Implement / Start Orchestrator) resolve the same settings as sync effects.
export function resolveWorkspaceAiSettingsForAgent(args: {
  agentId: string;
  agents: AgentDefinitionDescriptor[];
  agentAiDefaults: AgentAiDefaults;
  workspaceByAgent: WorkspaceAISettingsCache;
  fallbackModel: string;
  existingModel: string;
  existingThinking: ThinkingLevel;
}): { resolvedModel: string; resolvedThinking: ThinkingLevel } {
  const normalizedAgentId = normalizeAgentId(args.agentId);

  const activeDescriptor = args.agents.find((entry) => entry.id === normalizedAgentId);
  const fallbackAgentId =
    activeDescriptor?.base ?? (normalizedAgentId === "plan" ? "plan" : "exec");
  const fallbackIds =
    fallbackAgentId && fallbackAgentId !== normalizedAgentId
      ? [normalizedAgentId, fallbackAgentId]
      : [normalizedAgentId];

  const hasWorkspaceOverrideForAgent = args.workspaceByAgent[normalizedAgentId] !== undefined;

  const configuredDefaults = args.agentAiDefaults[normalizedAgentId];
  const inheritedConfiguredDefaults =
    hasWorkspaceOverrideForAgent || configuredDefaults !== undefined
      ? undefined
      : fallbackIds
          .slice(1)
          .map((id) => args.agentAiDefaults[id])
          .find((entry) => entry !== undefined);
  const descriptorDefaults = fallbackIds
    .map((id) => args.agents.find((entry) => entry.id === id)?.aiDefaults)
    .find((entry) => entry !== undefined);

  const configuredModelDefault =
    configuredDefaults?.modelString ?? inheritedConfiguredDefaults?.modelString;
  const configuredThinkingDefault =
    configuredDefaults?.thinkingLevel ?? inheritedConfiguredDefaults?.thinkingLevel;
  const descriptorModelDefault = descriptorDefaults?.model;
  const descriptorThinkingDefault = descriptorDefaults?.thinkingLevel;

  // Precedence: explicit Settings override -> workspace by-agent value -> descriptor default
  // -> current workspace value. "Inherit" removes the explicit override, so it falls through.
  // For derived agents, inherited (base) Settings defaults are only considered when this agent
  // has neither a workspace override nor its own Settings entry, matching task creation precedence.
  const candidateModel =
    configuredModelDefault ??
    fallbackIds
      .map((id) => args.workspaceByAgent[id]?.model)
      .find((entry) => entry !== undefined) ??
    descriptorModelDefault ??
    args.existingModel;
  const resolvedModel =
    typeof candidateModel === "string" && candidateModel.trim().length > 0
      ? candidateModel
      : args.fallbackModel;

  const candidateThinking =
    configuredThinkingDefault ??
    fallbackIds
      .map((id) => args.workspaceByAgent[id]?.thinkingLevel)
      .find((entry) => entry !== undefined) ??
    descriptorThinkingDefault ??
    args.existingThinking ??
    "off";
  const resolvedThinking = coerceThinkingLevel(candidateThinking) ?? "off";

  return { resolvedModel, resolvedThinking };
}
