import type { ThinkingLevel } from "@/common/types/thinking";

interface WorkspaceAiSettingsSnapshot {
  model: string;
  thinkingLevel: ThinkingLevel;
}

const pendingAiSettingsByWorkspace = new Map<string, WorkspaceAiSettingsSnapshot>();

function getPendingKey(workspaceId: string, agentId: string): string {
  return `${workspaceId}:${agentId}`;
}

export function markPendingWorkspaceAiSettings(
  workspaceId: string,
  agentId: string,
  settings: WorkspaceAiSettingsSnapshot
): void {
  if (!workspaceId || !agentId) {
    return;
  }
  pendingAiSettingsByWorkspace.set(getPendingKey(workspaceId, agentId), settings);
}

export function clearPendingWorkspaceAiSettings(
  workspaceId: string,
  agentId: string,
  expectedSettings?: WorkspaceAiSettingsSnapshot
): void {
  if (!workspaceId || !agentId) {
    return;
  }

  const key = getPendingKey(workspaceId, agentId);
  if (expectedSettings) {
    const current = pendingAiSettingsByWorkspace.get(key);
    // A newer write has superseded this one — keep the guard active for the newer value.
    if (
      current &&
      (current.model !== expectedSettings.model ||
        current.thinkingLevel !== expectedSettings.thinkingLevel)
    ) {
      return;
    }
  }

  pendingAiSettingsByWorkspace.delete(key);
}

export function shouldApplyWorkspaceAiSettingsFromBackend(
  workspaceId: string,
  agentId: string,
  incoming: WorkspaceAiSettingsSnapshot
): boolean {
  if (!workspaceId || !agentId) {
    return true;
  }

  const key = getPendingKey(workspaceId, agentId);
  const pending = pendingAiSettingsByWorkspace.get(key);
  if (!pending) {
    return true;
  }

  const matches =
    pending.model === incoming.model && pending.thinkingLevel === incoming.thinkingLevel;
  if (matches) {
    pendingAiSettingsByWorkspace.delete(key);
    return true;
  }

  return false;
}
