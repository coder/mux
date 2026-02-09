import { useEffect, useRef } from "react";
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
import { setWorkspaceModelWithOrigin } from "@/browser/utils/modelChange";
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

  // User request: this effect runs on mount and during background sync (defaults/config).
  // Only treat *real* agentId changes as explicit (origin "agent"); everything else is "sync"
  // so we don't show context-switch warnings on workspace entry.
  const prevAgentIdRef = useRef<string | null>(null);
  const prevWorkspaceIdRef = useRef<string | null>(null);

  useEffect(() => {
    const fallbackModel = getDefaultModel();
    const modelKey = getModelKey(workspaceId);
    const thinkingKey = getThinkingLevelKey(workspaceId);

    const normalizedAgentId =
      typeof agentId === "string" && agentId.trim().length > 0
        ? agentId.trim().toLowerCase()
        : "exec";

    const isExplicitAgentSwitch =
      prevAgentIdRef.current !== null &&
      prevWorkspaceIdRef.current === workspaceId &&
      prevAgentIdRef.current !== normalizedAgentId;

    // Update refs for the next run (even if no model changes).
    prevAgentIdRef.current = normalizedAgentId;
    prevWorkspaceIdRef.current = workspaceId;

    const activeDescriptor = agents.find((entry) => entry.id === normalizedAgentId);
    const fallbackAgentId =
      activeDescriptor?.base ?? (normalizedAgentId === "plan" ? "plan" : "exec");
    const fallbackIds =
      fallbackAgentId && fallbackAgentId !== normalizedAgentId
        ? [normalizedAgentId, fallbackAgentId]
        : [normalizedAgentId];

    const hasWorkspaceOverrideForAgent = workspaceByAgent[normalizedAgentId] !== undefined;

    const configuredDefaults = agentAiDefaults[normalizedAgentId];
    const inheritedConfiguredDefaults =
      hasWorkspaceOverrideForAgent || configuredDefaults !== undefined
        ? undefined
        : fallbackIds
            .slice(1)
            .map((id) => agentAiDefaults[id])
            .find((entry) => entry !== undefined);
    const descriptorDefaults = fallbackIds
      .map((id) => agents.find((entry) => entry.id === id)?.aiDefaults)
      .find((entry) => entry !== undefined);

    const configuredModelDefault =
      configuredDefaults?.modelString ?? inheritedConfiguredDefaults?.modelString;
    const configuredThinkingDefault =
      configuredDefaults?.thinkingLevel ?? inheritedConfiguredDefaults?.thinkingLevel;
    const descriptorModelDefault = descriptorDefaults?.model;
    const descriptorThinkingDefault = descriptorDefaults?.thinkingLevel;

    const existingModel = readPersistedState<string>(modelKey, fallbackModel);
    // Precedence: explicit Settings override -> workspace by-agent value -> descriptor default
    // -> current workspace value. "Inherit" removes the explicit override, so it falls through.
    // For derived agents, inherited (base) Settings defaults are only considered when this agent
    // has neither a workspace override nor its own Settings entry, matching task creation precedence.
    const candidateModel =
      configuredModelDefault ??
      fallbackIds.map((id) => workspaceByAgent[id]?.model).find((entry) => entry !== undefined) ??
      descriptorModelDefault ??
      existingModel;
    const resolvedModel =
      typeof candidateModel === "string" && candidateModel.trim().length > 0
        ? candidateModel
        : fallbackModel;

    const existingThinking = readPersistedState<ThinkingLevel>(thinkingKey, "off");
    const candidateThinking =
      configuredThinkingDefault ??
      fallbackIds
        .map((id) => workspaceByAgent[id]?.thinkingLevel)
        .find((entry) => entry !== undefined) ??
      descriptorThinkingDefault ??
      existingThinking ??
      "off";
    const resolvedThinking = coerceThinkingLevel(candidateThinking) ?? "off";

    if (existingModel !== resolvedModel) {
      setWorkspaceModelWithOrigin(
        workspaceId,
        resolvedModel,
        isExplicitAgentSwitch ? "agent" : "sync"
      );
    }

    if (existingThinking !== resolvedThinking) {
      updatePersistedState(thinkingKey, resolvedThinking);
    }
  }, [agentAiDefaults, agentId, agents, workspaceByAgent, workspaceId]);

  return null;
}
