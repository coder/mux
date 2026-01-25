import { useEffect } from "react";
import { useAgent } from "@/browser/contexts/AgentContext";
import {
  readPersistedState,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import {
  getModelKey,
  getThinkingLevelKey,
  getWorkspaceAISettingsByAgentKey,
  AGENT_AI_DEFAULTS_KEY,
} from "@/common/constants/storage";
import { getDefaultModel } from "@/browser/hooks/useModelsFromSettings";
import { coerceThinkingLevel, type ThinkingLevel } from "@/common/types/thinking";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";

type WorkspaceAISettingsCache = Partial<
  Record<string, { model: string; thinkingLevel: ThinkingLevel }>
>;

export function WorkspaceModeAISync(props: { workspaceId: string }): null {
  const workspaceId = props.workspaceId;
  const { agentId, agents } = useAgent();

  const [agentAiDefaults] = usePersistedState<AgentAiDefaults>(
    AGENT_AI_DEFAULTS_KEY,
    {},
    { listener: true }
  );
  const [workspaceByAgent] = usePersistedState<WorkspaceAISettingsCache>(
    getWorkspaceAISettingsByAgentKey(workspaceId),
    {},
    { listener: true }
  );

  useEffect(() => {
    const fallbackModel = getDefaultModel();
    const modelKey = getModelKey(workspaceId);
    const thinkingKey = getThinkingLevelKey(workspaceId);

    const normalizedAgentId =
      typeof agentId === "string" && agentId.trim().length > 0
        ? agentId.trim().toLowerCase()
        : "exec";

    const activeDescriptor = agents.find((entry) => entry.id === normalizedAgentId);
    const fallbackAgentId =
      activeDescriptor?.base ?? (normalizedAgentId === "plan" ? "plan" : "exec");
    const fallbackIds =
      fallbackAgentId && fallbackAgentId !== normalizedAgentId
        ? [normalizedAgentId, fallbackAgentId]
        : [normalizedAgentId];

    const configuredDefaults = fallbackIds
      .map((id) => agentAiDefaults[id])
      .find((entry) => entry !== undefined);
    const descriptorDefaults = fallbackIds
      .map((id) => agents.find((entry) => entry.id === id)?.aiDefaults)
      .find((entry) => entry !== undefined);

    const agentModelDefault =
      configuredDefaults?.modelString ?? descriptorDefaults?.model ?? undefined;
    const agentThinkingDefault =
      configuredDefaults?.thinkingLevel ?? descriptorDefaults?.thinkingLevel ?? undefined;

    const existingModel = readPersistedState<string>(modelKey, fallbackModel);
    const candidateModel =
      fallbackIds.map((id) => workspaceByAgent[id]?.model).find((entry) => entry !== undefined) ??
      agentModelDefault ??
      existingModel;
    const resolvedModel =
      typeof candidateModel === "string" && candidateModel.trim().length > 0
        ? candidateModel
        : fallbackModel;

    const existingThinking = readPersistedState<ThinkingLevel>(thinkingKey, "off");
    const candidateThinking =
      fallbackIds
        .map((id) => workspaceByAgent[id]?.thinkingLevel)
        .find((entry) => entry !== undefined) ??
      agentThinkingDefault ??
      existingThinking ??
      "off";
    const resolvedThinking = coerceThinkingLevel(candidateThinking) ?? "off";

    if (existingModel !== resolvedModel) {
      updatePersistedState(modelKey, resolvedModel);
    }

    if (existingThinking !== resolvedThinking) {
      updatePersistedState(thinkingKey, resolvedThinking);
    }
  }, [agentAiDefaults, agentId, agents, workspaceByAgent, workspaceId]);

  return null;
}
