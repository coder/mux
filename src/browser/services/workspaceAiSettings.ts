import {
  usePersistedState,
  readPersistedState,
  updatePersistedState,
} from "@/browser/hooks/usePersistedState";
import {
  clearPendingWorkspaceAiSettings,
  markPendingWorkspaceAiSettings,
} from "@/browser/utils/workspaceAiSettingsSync";
import {
  AGENT_AI_DEFAULTS_KEY,
  getAgentIdKey,
  getModelKey,
  getThinkingLevelByModelKey,
  getThinkingLevelKey,
  getWorkspaceAISettingsByAgentKey,
} from "@/common/constants/storage";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import { coerceThinkingLevel, type ThinkingLevel } from "@/common/types/thinking";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

interface WorkspaceAiSettings {
  model: string;
  thinkingLevel: ThinkingLevel;
}

interface WorkspaceAiSettingsApi {
  workspace: {
    updateAgentAISettings(input: {
      workspaceId: string;
      agentId: string;
      aiSettings: WorkspaceAiSettings;
    }): Promise<unknown>;
  };
}

interface GetWorkspaceAiSettingsOptions {
  inheritFromAgentId?: string;
}

const EMPTY_AGENT_AI_DEFAULTS: AgentAiDefaults = {};
const EMPTY_WORKSPACE_AI_SETTINGS_CACHE: WorkspaceAISettingsCache = {};
const DEFAULT_WORKSPACE_AI_SETTINGS: WorkspaceAiSettings = {
  model: WORKSPACE_DEFAULTS.model,
  thinkingLevel: WORKSPACE_DEFAULTS.thinkingLevel,
};
const NOOP_WORKSPACE_SCOPE_ID = "__workspace-ai-settings:noop__";

export type WorkspaceAISettingsCache = Partial<
  Record<string, { model: string; thinkingLevel: ThinkingLevel }>
>;

function normalizeModelString(model: unknown): string | undefined {
  return typeof model === "string" && model.trim().length > 0 ? model.trim() : undefined;
}

function readAgentAiDefaults(): AgentAiDefaults {
  return readPersistedState<AgentAiDefaults>(AGENT_AI_DEFAULTS_KEY, EMPTY_AGENT_AI_DEFAULTS);
}

function readWorkspaceAiSettingsCache(workspaceId: string): WorkspaceAISettingsCache {
  return readPersistedState<WorkspaceAISettingsCache>(
    getWorkspaceAISettingsByAgentKey(workspaceId),
    EMPTY_WORKSPACE_AI_SETTINGS_CACHE
  );
}

function readCurrentWorkspaceModel(workspaceId: string): string {
  return (
    normalizeModelString(
      readPersistedState<string>(getModelKey(workspaceId), WORKSPACE_DEFAULTS.model)
    ) ?? WORKSPACE_DEFAULTS.model
  );
}

function resolveModel(args: {
  agentDefaultModel: unknown;
  cachedModel: unknown;
  currentModel: string;
}): string {
  return (
    normalizeModelString(args.agentDefaultModel) ??
    normalizeModelString(args.cachedModel) ??
    normalizeModelString(args.currentModel) ??
    WORKSPACE_DEFAULTS.model
  );
}

function getWorkspaceScopedKey(
  workspaceId: string | undefined,
  buildKey: (workspaceId: string) => string
): string {
  return workspaceId ? buildKey(workspaceId) : buildKey(NOOP_WORKSPACE_SCOPE_ID);
}

function hasOwnCacheEntry(cache: WorkspaceAISettingsCache, agentId: string): boolean {
  return Object.prototype.hasOwnProperty.call(cache, agentId);
}

function readLegacyWorkspaceThinking(workspaceId: string): ThinkingLevel | undefined {
  return coerceThinkingLevel(
    readPersistedState<unknown>(getThinkingLevelKey(workspaceId), undefined)
  );
}

function readLegacyPerModelThinking(rawModel: string): ThinkingLevel | undefined {
  const normalizedRawModel = normalizeModelString(rawModel);
  if (!normalizedRawModel) {
    return undefined;
  }

  const canonicalModel = normalizeToCanonical(normalizedRawModel);
  const canonicalThinking = coerceThinkingLevel(
    readPersistedState<unknown>(getThinkingLevelByModelKey(canonicalModel), undefined)
  );
  if (canonicalThinking !== undefined) {
    return canonicalThinking;
  }

  if (canonicalModel !== normalizedRawModel) {
    return coerceThinkingLevel(
      readPersistedState<unknown>(getThinkingLevelByModelKey(normalizedRawModel), undefined)
    );
  }

  return undefined;
}

export function normalizeAgentId(agentId: string): string {
  return typeof agentId === "string" && agentId.trim().length > 0
    ? agentId.trim().toLowerCase()
    : "exec";
}

export function getWorkspaceAiSettings(
  workspaceId: string,
  agentId?: string,
  options?: GetWorkspaceAiSettingsOptions
): { model: string; thinkingLevel: ThinkingLevel } {
  const requestedAgentId =
    agentId ?? readPersistedState<string>(getAgentIdKey(workspaceId), WORKSPACE_DEFAULTS.agentId);
  const normalizedAgentId = normalizeAgentId(requestedAgentId);
  const agentAiDefaults = readAgentAiDefaults();
  const workspaceByAgent = readWorkspaceAiSettingsCache(workspaceId);
  const agentDefaults = agentAiDefaults[normalizedAgentId];
  const cachedEntry = workspaceByAgent[normalizedAgentId];
  const currentModel = readCurrentWorkspaceModel(workspaceId);
  const inheritFromAgentId = options?.inheritFromAgentId
    ? normalizeAgentId(options.inheritFromAgentId)
    : undefined;

  if (
    inheritFromAgentId &&
    inheritFromAgentId !== normalizedAgentId &&
    !hasOwnCacheEntry(workspaceByAgent, normalizedAgentId) &&
    agentDefaults === undefined
  ) {
    const inheritedSettings = getWorkspaceAiSettings(workspaceId, inheritFromAgentId);
    setWorkspaceAiSettings(workspaceId, normalizedAgentId, inheritedSettings);
    return inheritedSettings;
  }

  const model = resolveModel({
    agentDefaultModel: agentDefaults?.modelString,
    cachedModel: cachedEntry?.model,
    currentModel,
  });
  const configuredThinking = coerceThinkingLevel(agentDefaults?.thinkingLevel);
  if (configuredThinking !== undefined) {
    return { model, thinkingLevel: configuredThinking };
  }

  const cachedThinking = coerceThinkingLevel(cachedEntry?.thinkingLevel);
  if (cachedThinking !== undefined) {
    return { model, thinkingLevel: cachedThinking };
  }

  const legacyWorkspaceThinking = readLegacyWorkspaceThinking(workspaceId);
  if (legacyWorkspaceThinking !== undefined) {
    // Seed the per-agent cache as soon as we recover from legacy keys so later reads
    // can stay on the new storage boundary without revisiting workspace-scoped thinking.
    setWorkspaceAiSettings(workspaceId, normalizedAgentId, {
      thinkingLevel: legacyWorkspaceThinking,
    });
    return { model, thinkingLevel: legacyWorkspaceThinking };
  }

  const legacyPerModelThinking = readLegacyPerModelThinking(currentModel);
  if (legacyPerModelThinking !== undefined) {
    setWorkspaceAiSettings(workspaceId, normalizedAgentId, {
      thinkingLevel: legacyPerModelThinking,
    });
    return { model, thinkingLevel: legacyPerModelThinking };
  }

  return { model, thinkingLevel: WORKSPACE_DEFAULTS.thinkingLevel };
}

export function setWorkspaceAiSettings(
  workspaceId: string,
  agentId: string,
  update: Partial<{ model: string; thinkingLevel: ThinkingLevel }>,
  api?: WorkspaceAiSettingsApi
): void {
  const normalizedAgentId = normalizeAgentId(agentId);
  const currentCache = readWorkspaceAiSettingsCache(workspaceId);
  const existingEntry = currentCache[normalizedAgentId];
  const merged: WorkspaceAiSettings = {
    model:
      normalizeModelString(update.model) ??
      normalizeModelString(existingEntry?.model) ??
      readCurrentWorkspaceModel(workspaceId),
    thinkingLevel:
      coerceThinkingLevel(update.thinkingLevel) ??
      coerceThinkingLevel(existingEntry?.thinkingLevel) ??
      WORKSPACE_DEFAULTS.thinkingLevel,
  };

  updatePersistedState<WorkspaceAISettingsCache>(
    getWorkspaceAISettingsByAgentKey(workspaceId),
    {
      ...currentCache,
      [normalizedAgentId]: merged,
    },
    EMPTY_WORKSPACE_AI_SETTINGS_CACHE
  );

  if (!api) {
    return;
  }

  markPendingWorkspaceAiSettings(workspaceId, normalizedAgentId, merged);
  void api.workspace
    .updateAgentAISettings({
      workspaceId,
      agentId: normalizedAgentId,
      aiSettings: merged,
    })
    .catch(() => {
      // Best-effort only; local storage remains authoritative for the current session.
    })
    .finally(() => {
      clearPendingWorkspaceAiSettings(workspaceId, normalizedAgentId);
    });
}

export function useWorkspaceAiSettings(
  workspaceId?: string,
  agentId?: string
): { model: string; thinkingLevel: ThinkingLevel } {
  usePersistedState<WorkspaceAISettingsCache>(
    getWorkspaceScopedKey(workspaceId, getWorkspaceAISettingsByAgentKey),
    EMPTY_WORKSPACE_AI_SETTINGS_CACHE,
    { listener: true }
  );
  usePersistedState<AgentAiDefaults>(AGENT_AI_DEFAULTS_KEY, EMPTY_AGENT_AI_DEFAULTS, {
    listener: true,
  });
  const [activeAgentId] = usePersistedState<string>(
    getWorkspaceScopedKey(workspaceId, getAgentIdKey),
    WORKSPACE_DEFAULTS.agentId,
    { listener: true }
  );
  usePersistedState<string>(
    getWorkspaceScopedKey(workspaceId, getModelKey),
    WORKSPACE_DEFAULTS.model,
    {
      listener: true,
    }
  );
  usePersistedState<ThinkingLevel | undefined>(
    getWorkspaceScopedKey(workspaceId, getThinkingLevelKey),
    undefined,
    { listener: true }
  );

  if (!workspaceId) {
    return DEFAULT_WORKSPACE_AI_SETTINGS;
  }

  return getWorkspaceAiSettings(workspaceId, agentId ?? activeAgentId);
}
