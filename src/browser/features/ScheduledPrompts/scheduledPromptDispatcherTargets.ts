import { getScheduledPromptsKey } from "@/common/constants/storage";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { canUseScheduledPromptsInWorkspace } from "./scheduledPromptAvailability";
import { normalizeScheduledPrompts } from "./scheduledPrompts";

export const SCHEDULED_PROMPTS_STORAGE_PREFIX = "scheduledPrompts:";

export interface ScheduledPromptDispatcherTarget {
  workspaceId: string;
  projectPath: string;
}

export function isScheduledPromptsStorageKey(key: string): boolean {
  return key.startsWith(SCHEDULED_PROMPTS_STORAGE_PREFIX);
}

export function getScheduledPromptDispatcherTargets(
  workspaceMetadata: ReadonlyMap<string, FrontendWorkspaceMetadata>,
  readStoredPrompts: (storageKey: string) => unknown
): ScheduledPromptDispatcherTarget[] {
  const targets: ScheduledPromptDispatcherTarget[] = [];

  for (const [workspaceId, meta] of workspaceMetadata) {
    if (!canUseScheduledPromptsInWorkspace(meta) || !meta.projectPath) {
      continue;
    }

    const prompts = normalizeScheduledPrompts(readStoredPrompts(getScheduledPromptsKey(workspaceId)));
    if (!prompts.some((prompt) => prompt.status === "scheduled")) {
      continue;
    }

    targets.push({ workspaceId, projectPath: meta.projectPath });
  }

  return targets;
}
