import type { WorkspaceAISettingsCache } from "@/browser/utils/workspaceModeAi";
import {
  readPersistedState,
  readPersistedString,
  updatePersistedState,
} from "@/browser/hooks/usePersistedState";
import {
  AGENT_AI_DEFAULTS_KEY,
  DEFAULT_MODEL_KEY,
  HIDDEN_MODELS_KEY,
  LAST_CUSTOM_MODEL_PROVIDER_KEY,
  PREFERRED_SYSTEM_1_MODEL_KEY,
  getModelKey,
  getWorkspaceAISettingsByAgentKey,
} from "@/common/constants/storage";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { modelStringStartsWithProvider } from "@/common/utils/providers/modelString";

// Browser repair only: removing a custom provider updates config on the backend,
// but per-origin persisted browser preferences can still reference provider-owned models.
type UnknownRecord = Record<string, unknown>;

type WorkspaceAISettingsRepairEntry = Partial<NonNullable<WorkspaceAISettingsCache[string]>> &
  UnknownRecord;
type WorkspaceAISettingsRepairCache = Record<string, WorkspaceAISettingsRepairEntry | undefined>;
type AgentAiDefaultsRepairEntry = { modelString?: unknown } & UnknownRecord;
type AgentAiDefaultsRepairCache = Record<string, AgentAiDefaultsRepairEntry | undefined>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function repairPersistedModelString(key: string, provider: string, replacement: string): void {
  const model = readPersistedString(key);
  if (model !== undefined && modelStringStartsWithProvider(model, provider)) {
    updatePersistedState(key, replacement);
  }
}

function repairHiddenModels(provider: string): void {
  const hiddenModels = readPersistedState<unknown>(HIDDEN_MODELS_KEY, undefined);
  if (!Array.isArray(hiddenModels)) {
    return;
  }

  const filteredModels = hiddenModels.filter(
    (model) => typeof model !== "string" || !modelStringStartsWithProvider(model, provider)
  );

  if (filteredModels.length !== hiddenModels.length) {
    updatePersistedState(HIDDEN_MODELS_KEY, filteredModels);
  }
}

function repairAgentAiDefaults(provider: string): void {
  const defaults = readPersistedState<AgentAiDefaultsRepairCache | undefined>(
    AGENT_AI_DEFAULTS_KEY,
    undefined
  );
  if (!isRecord(defaults)) {
    return;
  }

  let changed = false;
  const nextDefaults: AgentAiDefaultsRepairCache = { ...defaults };
  for (const [agentId, entry] of Object.entries(defaults)) {
    if (!isRecord(entry)) {
      continue;
    }

    const modelString = entry.modelString;
    if (typeof modelString !== "string" || !modelStringStartsWithProvider(modelString, provider)) {
      continue;
    }

    const nextEntry = { ...entry };
    delete nextEntry.modelString;
    nextDefaults[agentId] = nextEntry;
    changed = true;
  }

  if (changed) {
    updatePersistedState(AGENT_AI_DEFAULTS_KEY, nextDefaults);
  }
}

function repairLastCustomModelProvider(provider: string): void {
  const lastProvider = readPersistedString(LAST_CUSTOM_MODEL_PROVIDER_KEY);
  if (lastProvider === provider && lastProvider !== "") {
    updatePersistedState(LAST_CUSTOM_MODEL_PROVIDER_KEY, "");
  }
}

function repairWorkspaceAISettingsByAgent(workspaceId: string, provider: string): void {
  const key = getWorkspaceAISettingsByAgentKey(workspaceId);
  const settingsByAgent = readPersistedState<WorkspaceAISettingsRepairCache | undefined>(
    key,
    undefined
  );
  if (!isRecord(settingsByAgent)) {
    return;
  }

  let changed = false;
  const nextSettingsByAgent: WorkspaceAISettingsRepairCache = { ...settingsByAgent };

  for (const [agentName, settings] of Object.entries(settingsByAgent)) {
    if (!isRecord(settings)) {
      continue;
    }

    const model = settings.model;
    if (typeof model !== "string" || !modelStringStartsWithProvider(model, provider)) {
      continue;
    }

    nextSettingsByAgent[agentName] = {
      ...settings,
      model: WORKSPACE_DEFAULTS.model,
    };
    changed = true;
  }

  if (changed) {
    updatePersistedState(key, nextSettingsByAgent);
  }
}

export function repairLocalModelPreferencesForRemovedProvider(
  provider: string,
  workspaceIds: Iterable<string>
): void {
  repairPersistedModelString(DEFAULT_MODEL_KEY, provider, WORKSPACE_DEFAULTS.model);
  repairPersistedModelString(PREFERRED_SYSTEM_1_MODEL_KEY, provider, "");
  repairHiddenModels(provider);
  repairAgentAiDefaults(provider);
  repairLastCustomModelProvider(provider);

  for (const workspaceId of new Set(workspaceIds)) {
    repairPersistedModelString(getModelKey(workspaceId), provider, WORKSPACE_DEFAULTS.model);
    repairWorkspaceAISettingsByAgent(workspaceId, provider);
  }
}
