import type { ThinkingLevel } from "@/common/types/thinking";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

interface WorkspaceAiSettingsSnapshot {
  model: string;
  thinkingLevel: ThinkingLevel;
}

export function getWorkspaceAiSettingsFromMetadata(
  metadata: FrontendWorkspaceMetadata | undefined,
  agentId: string | undefined
): { model: string | undefined; thinkingLevel: ThinkingLevel | undefined } {
  const settings =
    (agentId ? metadata?.aiSettingsByAgent?.[agentId] : undefined) ?? metadata?.aiSettings;
  return {
    model: settings?.model,
    thinkingLevel: settings?.thinkingLevel,
  };
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

export function clearPendingWorkspaceAiSettings(workspaceId: string, agentId: string): void {
  if (!workspaceId || !agentId) {
    return;
  }
  pendingAiSettingsByWorkspace.delete(getPendingKey(workspaceId, agentId));
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
