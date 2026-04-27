import type { WorkspaceAISettingsCache } from "@/browser/utils/workspaceModeAi";
import {
  readPersistedState,
  readPersistedString,
  updatePersistedState,
} from "@/browser/hooks/usePersistedState";
import {
  DEFAULT_MODEL_KEY,
  HIDDEN_MODELS_KEY,
  LAST_CUSTOM_MODEL_PROVIDER_KEY,
  getModelKey,
  getWorkspaceAISettingsByAgentKey,
} from "@/common/constants/storage";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

// Browser repair only: removing a custom provider updates config on the backend,
// but per-origin persisted browser preferences can still reference provider-owned models.
type UnknownRecord = Record<string, unknown>;

type WorkspaceAISettingsRepairEntry = Partial<NonNullable<WorkspaceAISettingsCache[string]>> &
  UnknownRecord;
type WorkspaceAISettingsRepairCache = Record<string, WorkspaceAISettingsRepairEntry | undefined>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelFromProvider(model: string, provider: string): boolean {
  return model.startsWith(`${provider}:`);
}

function repairPersistedModelString(key: string, provider: string): void {
  const model = readPersistedString(key);
  if (model !== undefined && isModelFromProvider(model, provider)) {
    updatePersistedState(key, WORKSPACE_DEFAULTS.model);
  }
}

function repairHiddenModels(provider: string): void {
  const hiddenModels = readPersistedState<unknown>(HIDDEN_MODELS_KEY, undefined);
  if (!Array.isArray(hiddenModels)) {
    return;
  }

  const filteredModels = hiddenModels.filter(
    (model) => typeof model !== "string" || !isModelFromProvider(model, provider)
  );

  if (filteredModels.length !== hiddenModels.length) {
    updatePersistedState(HIDDEN_MODELS_KEY, filteredModels);
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
    if (typeof model !== "string" || !isModelFromProvider(model, provider)) {
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
  repairPersistedModelString(DEFAULT_MODEL_KEY, provider);
  repairHiddenModels(provider);
  repairLastCustomModelProvider(provider);

  for (const workspaceId of new Set(workspaceIds)) {
    repairPersistedModelString(getModelKey(workspaceId), provider);
    repairWorkspaceAISettingsByAgent(workspaceId, provider);
  }
}
