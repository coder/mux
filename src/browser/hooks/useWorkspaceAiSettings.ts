import { useEffect } from "react";
import { getDefaultModel } from "@/browser/hooks/useModelsFromSettings";
import { migrateGatewayModel } from "@/browser/hooks/useGatewayModels";
import {
  readPersistedState,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import {
  AGENT_AI_DEFAULTS_KEY,
  getAgentIdKey,
  getModelKey,
  getThinkingLevelByModelKey,
  getThinkingLevelKey,
  getWorkspaceAISettingsByAgentKey,
} from "@/common/constants/storage";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";
import { coerceThinkingLevel, type ThinkingLevel } from "@/common/types/thinking";

type WorkspaceAiSettingsCache = Partial<
  Record<string, { model: string; thinkingLevel: ThinkingLevel }>
>;

export interface WorkspaceAiSettings {
  agentId: string;
  model: string;
  thinkingLevel: ThinkingLevel;
}

export interface ReadWorkspaceAiSettingsProps {
  workspaceId: string;
  agentId?: string;
  agents?: AgentDefinitionDescriptor[];
  defaultModel?: string;
  persist?: boolean;
}

export interface UseWorkspaceAiSettingsProps {
  workspaceId: string;
  agentId?: string;
  agents?: AgentDefinitionDescriptor[];
  defaultModel?: string;
  enabled?: boolean;
}

interface ResolveWorkspaceAiSettingsProps {
  workspaceId: string;
  agentId: string;
  agents?: AgentDefinitionDescriptor[];
  defaultModel: string;
  workspaceByAgent: WorkspaceAiSettingsCache;
  agentAiDefaults: AgentAiDefaults;
  legacyModel: string | undefined;
  legacyThinking: ThinkingLevel | undefined;
  readLegacyThinkingByModel: (model: string) => ThinkingLevel | undefined;
}

interface ResolveWorkspaceAiSettingsResult {
  settings: WorkspaceAiSettings;
  shouldPersist: boolean;
  nextEntry: { model: string; thinkingLevel: ThinkingLevel };
}

function normalizeAgentId(value: unknown): string {
  if (typeof value !== "string") {
    return "exec";
  }

  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : "exec";
}

function normalizeModel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getFallbackAgentIds(
  agentId: string,
  agents: AgentDefinitionDescriptor[] | undefined
): string[] {
  const descriptor = agents?.find((entry) => entry.id === agentId);
  const fallbackAgentId = descriptor?.base ?? (agentId === "plan" ? "plan" : "exec");
  if (fallbackAgentId && fallbackAgentId !== agentId) {
    return [agentId, fallbackAgentId];
  }
  return [agentId];
}

function resolveWorkspaceAiSettings(
  props: ResolveWorkspaceAiSettingsProps
): ResolveWorkspaceAiSettingsResult {
  const normalizedAgentId = normalizeAgentId(props.agentId);
  const fallbackIds = getFallbackAgentIds(normalizedAgentId, props.agents);

  const workspaceByAgent =
    props.workspaceByAgent && typeof props.workspaceByAgent === "object"
      ? props.workspaceByAgent
      : {};
  const agentAiDefaults =
    props.agentAiDefaults && typeof props.agentAiDefaults === "object" ? props.agentAiDefaults : {};

  const explicitEntry = workspaceByAgent[normalizedAgentId];
  const fallbackEntry = fallbackIds
    .filter((id) => id !== normalizedAgentId)
    .map((id) => workspaceByAgent[id])
    .find((entry) => entry !== undefined);

  const configuredDefaults = fallbackIds
    .map((id) => agentAiDefaults[id])
    .find((entry) => entry !== undefined);
  const descriptorDefaults = fallbackIds
    .map((id) => props.agents?.find((entry) => entry.id === id)?.aiDefaults)
    .find((entry) => entry !== undefined);

  const explicitModelRaw = normalizeModel(explicitEntry?.model);
  const legacyModelRaw = normalizeModel(props.legacyModel);
  const fallbackModelRaw = normalizeModel(fallbackEntry?.model);
  const configuredModelRaw = normalizeModel(configuredDefaults?.modelString);
  const descriptorModelRaw = normalizeModel(descriptorDefaults?.model);
  const defaultModelRaw = normalizeModel(props.defaultModel) ?? props.defaultModel;

  const modelCandidate =
    explicitModelRaw ??
    legacyModelRaw ??
    fallbackModelRaw ??
    configuredModelRaw ??
    descriptorModelRaw ??
    defaultModelRaw;
  const canonicalModel = migrateGatewayModel(modelCandidate ?? defaultModelRaw);
  const resolvedModel = normalizeModel(canonicalModel) ?? defaultModelRaw;

  const explicitThinkingRaw = coerceThinkingLevel(explicitEntry?.thinkingLevel);
  const legacyThinkingRaw = coerceThinkingLevel(props.legacyThinking);
  const fallbackThinkingRaw = coerceThinkingLevel(fallbackEntry?.thinkingLevel);
  const configuredThinkingRaw = coerceThinkingLevel(configuredDefaults?.thinkingLevel);
  const descriptorThinkingRaw = coerceThinkingLevel(descriptorDefaults?.thinkingLevel);

  let resolvedThinking =
    explicitThinkingRaw ??
    legacyThinkingRaw ??
    fallbackThinkingRaw ??
    configuredThinkingRaw ??
    descriptorThinkingRaw;

  let usedLegacyThinkingByModel = false;
  if (!resolvedThinking) {
    const legacyByModel = props.readLegacyThinkingByModel(resolvedModel);
    if (legacyByModel) {
      resolvedThinking = legacyByModel;
      usedLegacyThinkingByModel = true;
    }
  }

  resolvedThinking ??= "off";

  const explicitModelCanonical = explicitModelRaw
    ? migrateGatewayModel(explicitModelRaw)
    : undefined;
  const explicitModelNeedsFix =
    explicitEntry !== undefined &&
    (explicitModelCanonical !== resolvedModel || explicitEntry.model !== explicitModelRaw);
  const explicitThinkingNeedsFix =
    explicitEntry !== undefined && explicitThinkingRaw !== resolvedThinking;

  const usedLegacy =
    legacyModelRaw !== undefined || legacyThinkingRaw !== undefined || usedLegacyThinkingByModel;
  const shouldPersist =
    explicitModelNeedsFix ||
    explicitThinkingNeedsFix ||
    (explicitEntry === undefined && usedLegacy);

  return {
    settings: {
      agentId: normalizedAgentId,
      model: resolvedModel,
      thinkingLevel: resolvedThinking,
    },
    shouldPersist,
    nextEntry: { model: resolvedModel, thinkingLevel: resolvedThinking },
  };
}

function persistWorkspaceAiSettings(
  workspaceId: string,
  agentId: string,
  entry: { model: string; thinkingLevel: ThinkingLevel }
): void {
  updatePersistedState<WorkspaceAiSettingsCache>(
    getWorkspaceAISettingsByAgentKey(workspaceId),
    (prev) => {
      const record: WorkspaceAiSettingsCache = prev && typeof prev === "object" ? prev : {};
      return {
        ...record,
        [agentId]: { model: entry.model, thinkingLevel: entry.thinkingLevel },
      };
    },
    {}
  );
}

export function readWorkspaceAiSettings(props: ReadWorkspaceAiSettingsProps): WorkspaceAiSettings {
  const workspaceId = props.workspaceId;
  const defaultModel = props.defaultModel ?? getDefaultModel();
  const storedAgentId = readPersistedState<string>(getAgentIdKey(workspaceId), "exec");
  const agentId = props.agentId ?? storedAgentId;

  const workspaceByAgent = readPersistedState<WorkspaceAiSettingsCache>(
    getWorkspaceAISettingsByAgentKey(workspaceId),
    {}
  );
  const agentAiDefaults = readPersistedState<AgentAiDefaults>(AGENT_AI_DEFAULTS_KEY, {});
  const legacyModel = readPersistedState<string | undefined>(getModelKey(workspaceId), undefined);
  const legacyThinking = readPersistedState<ThinkingLevel | undefined>(
    getThinkingLevelKey(workspaceId),
    undefined
  );

  const result = resolveWorkspaceAiSettings({
    workspaceId,
    agentId,
    agents: props.agents,
    defaultModel,
    workspaceByAgent,
    agentAiDefaults,
    legacyModel,
    legacyThinking,
    readLegacyThinkingByModel: (model) =>
      coerceThinkingLevel(readPersistedState(getThinkingLevelByModelKey(model), undefined)),
  });

  if (props.persist !== false && result.shouldPersist) {
    persistWorkspaceAiSettings(workspaceId, result.settings.agentId, result.nextEntry);
  }

  return result.settings;
}

export function useWorkspaceAiSettings(props: UseWorkspaceAiSettingsProps): WorkspaceAiSettings {
  const workspaceId = props.workspaceId;
  const enabled = props.enabled ?? true;
  const defaultModel = props.defaultModel ?? getDefaultModel();

  const [storedAgentId] = usePersistedState<string>(getAgentIdKey(workspaceId), "exec", {
    listener: true,
  });
  const agentId = props.agentId ?? storedAgentId;

  const [workspaceByAgent] = usePersistedState<WorkspaceAiSettingsCache>(
    getWorkspaceAISettingsByAgentKey(workspaceId),
    {},
    { listener: true }
  );
  const [agentAiDefaults] = usePersistedState<AgentAiDefaults>(
    AGENT_AI_DEFAULTS_KEY,
    {},
    {
      listener: true,
    }
  );

  const legacyModel = readPersistedState<string | undefined>(getModelKey(workspaceId), undefined);
  const legacyThinking = readPersistedState<ThinkingLevel | undefined>(
    getThinkingLevelKey(workspaceId),
    undefined
  );

  const result = resolveWorkspaceAiSettings({
    workspaceId,
    agentId,
    agents: props.agents,
    defaultModel,
    workspaceByAgent,
    agentAiDefaults,
    legacyModel,
    legacyThinking,
    readLegacyThinkingByModel: (model) =>
      coerceThinkingLevel(readPersistedState(getThinkingLevelByModelKey(model), undefined)),
  });

  const nextAgentId = result.settings.agentId;
  const nextModel = result.nextEntry.model;
  const nextThinkingLevel = result.nextEntry.thinkingLevel;

  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (!result.shouldPersist) {
      return;
    }

    persistWorkspaceAiSettings(workspaceId, nextAgentId, {
      model: nextModel,
      thinkingLevel: nextThinkingLevel,
    });
  }, [enabled, nextAgentId, nextModel, nextThinkingLevel, result.shouldPersist, workspaceId]);

  return result.settings;
}
