import type { APIClient } from "@/browser/contexts/API";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  createLocalFirstBackend,
  type LocalFirstBackend,
  type PersistedStateBackend,
} from "@/browser/utils/persistedStateBackend";
import { getWorkspaceAISettingsByAgentKey } from "@/common/constants/storage";
import type { ThinkingLevel } from "@/common/types/thinking";

const WORKSPACE_AI_SETTINGS_PREFIX = "workspaceAiSettingsByAgent:";

type WorkspaceAISettingsByAgentCache = Partial<
  Record<string, { model: string; thinkingLevel: ThinkingLevel }>
>;

let apiRef: APIClient | null = null;

function parseWorkspaceId(key: string): string | null {
  if (!key.startsWith(WORKSPACE_AI_SETTINGS_PREFIX)) {
    return null;
  }
  const workspaceId = key.slice(WORKSPACE_AI_SETTINGS_PREFIX.length);
  return workspaceId.length > 0 ? workspaceId : null;
}

function areWorkspaceAiSettingsEqual(
  left: WorkspaceAISettingsByAgentCache,
  right: WorkspaceAISettingsByAgentCache
): boolean {
  if (left === right) {
    return true;
  }

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  for (const key of leftKeys) {
    const leftEntry = left[key];
    const rightEntry = right[key];
    if (!leftEntry || !rightEntry) {
      return false;
    }
    if (leftEntry.model !== rightEntry.model) {
      return false;
    }
    if (leftEntry.thinkingLevel !== rightEntry.thinkingLevel) {
      return false;
    }
  }

  return true;
}

// Local-first persistence keeps UI snappy while preventing stale metadata from
// overwriting newer local AI settings during rapid toggles.
const workspaceAiSettingsTransport: PersistedStateBackend<WorkspaceAISettingsByAgentCache> = {
  write: async (key, value, previousValue) => {
    const api = apiRef;
    if (!api) {
      return { success: false };
    }

    const workspaceId = parseWorkspaceId(key);
    if (!workspaceId) {
      return { success: false };
    }

    const prev = previousValue ?? {};
    const next = value ?? {};
    const updates: Array<{
      agentId: string;
      aiSettings: { model: string; thinkingLevel: ThinkingLevel };
    }> = [];

    for (const [agentId, entry] of Object.entries(next)) {
      if (!entry) {
        continue;
      }
      const prevEntry = prev[agentId];
      if (
        !prevEntry ||
        prevEntry.model !== entry.model ||
        prevEntry.thinkingLevel !== entry.thinkingLevel
      ) {
        updates.push({ agentId, aiSettings: entry });
      }
    }

    if (updates.length === 0) {
      return { success: true };
    }

    const results = await Promise.all(
      updates.map((update) =>
        api.workspace.updateAgentAISettings({
          workspaceId,
          agentId: update.agentId,
          aiSettings: update.aiSettings,
        })
      )
    );

    return { success: results.every((result) => result.success) };
  },
};

export const workspaceAiSettingsBackend: LocalFirstBackend<WorkspaceAISettingsByAgentCache> =
  createLocalFirstBackend(workspaceAiSettingsTransport, {
    isEqual: areWorkspaceAiSettingsEqual,
  });

export function setWorkspaceAiSettingsBackendApi(api: APIClient | null): void {
  apiRef = api;
}

export function applyWorkspaceAiSettingsFromBackend(
  workspaceId: string,
  nextByAgent: WorkspaceAISettingsByAgentCache,
  existingByAgent?: WorkspaceAISettingsByAgentCache
): boolean {
  const key = getWorkspaceAISettingsByAgentKey(workspaceId);
  if (!workspaceAiSettingsBackend.shouldApplyRemote(key, nextByAgent)) {
    return false;
  }

  if (existingByAgent && areWorkspaceAiSettingsEqual(existingByAgent, nextByAgent)) {
    return true;
  }

  updatePersistedState(key, nextByAgent, undefined, {
    backend: workspaceAiSettingsBackend,
    skipBackend: true,
  });

  return true;
}
