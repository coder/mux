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
  getWorkspaceAISettingsByAgentKey,
} from "@/common/constants/storage";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";
import { coerceThinkingLevel, type ThinkingLevel } from "@/common/types/thinking";
import {
  getAgentIdKey as getScopedAgentIdKey,
  getModelKey,
  getThinkingLevelByModelKey,
  getThinkingLevelKey,
} from "@/common/constants/storage";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

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
  agentId: string;
  agents?: AgentDefinitionDescriptor[];
  defaultModel: string;
  workspaceByAgent: WorkspaceAiSettingsCache;
  agentAiDefaults: AgentAiDefaults;
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

/**
 * Resolve workspace AI settings from cache and configured defaults.
 *
 * Fallback order:
 * 1. Explicit cache entry for agentId
 * 2. Fallback cache entry (e.g., exec for custom agents)
 * 3. Configured agent defaults (user settings)
 * 4. Descriptor defaults (built-in agent definitions)
 * 5. Global default model + "off" thinking
 */
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
  const fallbackModelRaw = normalizeModel(fallbackEntry?.model);
  const configuredModelRaw = normalizeModel(configuredDefaults?.modelString);
  const descriptorModelRaw = normalizeModel(descriptorDefaults?.model);
  const defaultModelRaw = normalizeModel(props.defaultModel) ?? props.defaultModel;

  const modelCandidate =
    explicitModelRaw ??
    fallbackModelRaw ??
    configuredModelRaw ??
    descriptorModelRaw ??
    defaultModelRaw;
  const canonicalModel = migrateGatewayModel(modelCandidate ?? defaultModelRaw);
  const resolvedModel = normalizeModel(canonicalModel) ?? defaultModelRaw;

  const explicitThinkingRaw = coerceThinkingLevel(explicitEntry?.thinkingLevel);
  const fallbackThinkingRaw = coerceThinkingLevel(fallbackEntry?.thinkingLevel);
  const configuredThinkingRaw = coerceThinkingLevel(configuredDefaults?.thinkingLevel);
  const descriptorThinkingRaw = coerceThinkingLevel(descriptorDefaults?.thinkingLevel);

  const resolvedThinking =
    explicitThinkingRaw ??
    fallbackThinkingRaw ??
    configuredThinkingRaw ??
    descriptorThinkingRaw ??
    "off";

  // Self-heal: persist if explicit entry has invalid/stale model or thinking
  const explicitModelCanonical = explicitModelRaw
    ? migrateGatewayModel(explicitModelRaw)
    : undefined;
  const explicitModelNeedsFix =
    explicitEntry !== undefined &&
    (explicitModelCanonical !== resolvedModel || explicitEntry.model !== explicitModelRaw);
  const explicitThinkingNeedsFix =
    explicitEntry !== undefined && explicitThinkingRaw !== resolvedThinking;

  const shouldPersist = explicitModelNeedsFix || explicitThinkingNeedsFix;

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

  const result = resolveWorkspaceAiSettings({
    agentId,
    agents: props.agents,
    defaultModel,
    workspaceByAgent,
    agentAiDefaults,
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

  const result = resolveWorkspaceAiSettings({
    agentId,
    agents: props.agents,
    defaultModel,
    workspaceByAgent,
    agentAiDefaults,
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

// =============================================================================
// Scoped AI Settings (unified interface for workspace and project/global scopes)
// =============================================================================

export interface ScopedAiSettings {
  agentId: string;
  model: string;
  thinkingLevel: ThinkingLevel;
}

export interface ReadScopedAiSettingsProps {
  scopeId: string;
  workspaceId?: string;
  agentId?: string;
  agents?: AgentDefinitionDescriptor[];
  defaultModel?: string;
  persist?: boolean;
}

export interface UseScopedAiSettingsProps {
  scopeId: string;
  workspaceId?: string;
  agentId?: string;
  agents?: AgentDefinitionDescriptor[];
  defaultModel?: string;
}

/**
 * Read AI settings for any scope (workspace, project, or global).
 *
 * - If `workspaceId` is provided, delegates to `readWorkspaceAiSettings`
 * - Otherwise reads from `modelKey(scopeId)` + `thinkingKey(scopeId)` with legacy per-model migration
 */
export function readScopedAiSettings(props: ReadScopedAiSettingsProps): ScopedAiSettings {
  const workspaceId = props.workspaceId;
  const defaultModel = props.defaultModel ?? getDefaultModel();

  // Workspace scope: delegate to workspace accessor
  if (typeof workspaceId === "string" && workspaceId.trim().length > 0) {
    return readWorkspaceAiSettings({
      workspaceId,
      agentId: props.agentId,
      agents: props.agents,
      defaultModel,
      persist: props.persist,
    });
  }

  // Project/global scope: read from scope-keyed storage
  const scopeId = props.scopeId;

  const rawModel = readPersistedState<string>(getModelKey(scopeId), defaultModel);
  const model = migrateGatewayModel(rawModel || defaultModel);

  // Read thinking level with legacy per-model migration
  const thinkingKey = getThinkingLevelKey(scopeId);
  const existingThinking = readPersistedState<ThinkingLevel | undefined>(thinkingKey, undefined);
  let thinkingLevel: ThinkingLevel;

  if (existingThinking !== undefined) {
    thinkingLevel = existingThinking;
  } else {
    // Migrate from legacy per-model key
    const legacyThinking = coerceThinkingLevel(
      readPersistedState(getThinkingLevelByModelKey(model), undefined)
    );
    thinkingLevel = legacyThinking ?? WORKSPACE_DEFAULTS.thinkingLevel;

    // Persist migration if enabled
    if (props.persist !== false && legacyThinking !== undefined) {
      updatePersistedState<ThinkingLevel>(thinkingKey, thinkingLevel);
    }
  }

  const agentId =
    props.agentId ??
    readPersistedState<string>(getScopedAgentIdKey(scopeId), WORKSPACE_DEFAULTS.agentId);

  return { agentId, model, thinkingLevel };
}

/**
 * React hook for AI settings for any scope (workspace, project, or global).
 * Reactive - re-renders when settings change.
 *
 * - If `workspaceId` is provided, delegates to `useWorkspaceAiSettings`
 * - Otherwise uses `usePersistedState` for project/global scope
 */
export function useScopedAiSettings(props: UseScopedAiSettingsProps): ScopedAiSettings {
  const workspaceId = props.workspaceId;
  const defaultModel = props.defaultModel ?? getDefaultModel();
  const isWorkspaceScope = typeof workspaceId === "string" && workspaceId.trim().length > 0;

  // Workspace scope: delegate to workspace hook
  const workspaceSettings = useWorkspaceAiSettings({
    workspaceId: workspaceId ?? "__scoped_ai_settings_fallback__",
    agentId: props.agentId,
    agents: props.agents,
    defaultModel,
    enabled: isWorkspaceScope,
  });

  // Project/global scope: use persisted state hooks
  const scopeId = props.scopeId;
  const thinkingKey = getThinkingLevelKey(scopeId);

  const [rawModel] = usePersistedState<string>(getModelKey(scopeId), defaultModel, {
    listener: true,
  });
  const model = migrateGatewayModel(rawModel || defaultModel);

  const [storedThinkingLevel, setStoredThinkingLevel] = usePersistedState<ThinkingLevel>(
    thinkingKey,
    WORKSPACE_DEFAULTS.thinkingLevel,
    { listener: true }
  );

  const [storedAgentId] = usePersistedState<string>(
    getScopedAgentIdKey(scopeId),
    WORKSPACE_DEFAULTS.agentId,
    { listener: true }
  );

  // One-time migration: seed from legacy per-model key if scope key is missing
  useEffect(() => {
    if (isWorkspaceScope) {
      return;
    }

    const existing = readPersistedState<ThinkingLevel | undefined>(thinkingKey, undefined);
    if (existing !== undefined) {
      return;
    }

    const legacyKey = getThinkingLevelByModelKey(model);
    const legacy = coerceThinkingLevel(readPersistedState(legacyKey, undefined));
    if (legacy === undefined) {
      return;
    }

    setStoredThinkingLevel(legacy);
  }, [isWorkspaceScope, model, thinkingKey, setStoredThinkingLevel]);

  if (isWorkspaceScope) {
    return workspaceSettings;
  }

  const agentId = props.agentId ?? storedAgentId;

  return { agentId, model, thinkingLevel: storedThinkingLevel };
}
