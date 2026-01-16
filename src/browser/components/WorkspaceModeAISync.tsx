import { useEffect } from "react";
import { useMode } from "@/browser/contexts/ModeContext";
import { useAgent } from "@/browser/contexts/AgentContext";
import {
  readPersistedState,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import {
  getModelKey,
  getThinkingLevelKey,
  getWorkspaceAISettingsByModeKey,
  AGENT_AI_DEFAULTS_KEY,
  MODE_AI_DEFAULTS_KEY,
} from "@/common/constants/storage";
import { getDefaultModel } from "@/browser/hooks/useModelsFromSettings";
import { migrateGatewayModel } from "@/browser/hooks/useGatewayModels";
import { resolveModelAlias } from "@/common/utils/ai/models";
import { enforceThinkingPolicy } from "@/common/utils/thinking/policy";
import { coerceThinkingLevel, type ThinkingLevel } from "@/common/types/thinking";
import type { ModeAiDefaults } from "@/common/types/modeAiDefaults";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";

type WorkspaceAISettingsCache = Partial<
  Record<string, { model: string; thinkingLevel: ThinkingLevel }>
>;

export function WorkspaceModeAISync(props: { workspaceId: string }): null {
  const workspaceId = props.workspaceId;
  const [mode] = useMode();
  const { agentId, agents } = useAgent();

  const [modeAiDefaults] = usePersistedState<ModeAiDefaults>(
    MODE_AI_DEFAULTS_KEY,
    {},
    {
      listener: true,
    }
  );
  const [agentAiDefaults] = usePersistedState<AgentAiDefaults>(
    AGENT_AI_DEFAULTS_KEY,
    {},
    { listener: true }
  );
  const [workspaceByMode] = usePersistedState<WorkspaceAISettingsCache>(
    getWorkspaceAISettingsByModeKey(workspaceId),
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
        : mode;

    const descriptorDefaults = agents.find((entry) => entry.id === normalizedAgentId)?.aiDefaults;
    const configuredDefaults = agentAiDefaults[normalizedAgentId];

    const agentModelDefault =
      configuredDefaults?.modelString ?? descriptorDefaults?.model ?? undefined;
    const agentThinkingDefault =
      configuredDefaults?.thinkingLevel ?? descriptorDefaults?.thinkingLevel ?? undefined;

    const existingModel = readPersistedState<string>(modelKey, fallbackModel);
    const candidateModel =
      workspaceByMode[normalizedAgentId]?.model ??
      agentModelDefault ??
      workspaceByMode[mode]?.model ??
      modeAiDefaults[mode]?.modelString ??
      existingModel;
    const resolvedModel =
      typeof candidateModel === "string" && candidateModel.trim().length > 0
        ? candidateModel
        : fallbackModel;
    const canonicalModel = migrateGatewayModel(resolveModelAlias(resolvedModel.trim()));
    const effectiveModel = canonicalModel.trim().length > 0 ? canonicalModel : fallbackModel;

    const existingThinking = readPersistedState<ThinkingLevel>(thinkingKey, "off");
    const candidateThinking =
      workspaceByMode[normalizedAgentId]?.thinkingLevel ??
      agentThinkingDefault ??
      workspaceByMode[mode]?.thinkingLevel ??
      modeAiDefaults[mode]?.thinkingLevel ??
      existingThinking ??
      "off";
    const resolvedThinking = coerceThinkingLevel(candidateThinking) ?? "off";

    const effectiveThinking = enforceThinkingPolicy(effectiveModel, resolvedThinking);

    if (existingModel !== effectiveModel) {
      updatePersistedState(modelKey, effectiveModel);
    }

    if (existingThinking !== effectiveThinking) {
      updatePersistedState(thinkingKey, effectiveThinking);
    }
  }, [agentAiDefaults, agentId, agents, mode, modeAiDefaults, workspaceByMode, workspaceId]);

  return null;
}
