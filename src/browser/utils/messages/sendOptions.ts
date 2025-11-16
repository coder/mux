import {
  getModelKey,
  getThinkingLevelKey,
  getModeKey,
  USE_1M_CONTEXT_KEY,
} from "@/common/constants/storage";
import { modeToToolPolicy, PLAN_MODE_INSTRUCTION } from "@/browser/utils/ui/modeUtils";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import type { SendMessageOptions } from "@/common/types/ipc";
import type { UIMode } from "@/common/types/mode";
import type { ThinkingLevel } from "@/common/types/thinking";
import { enforceThinkingPolicy } from "@/browser/utils/thinking/policy";
import { getDefaultModelFromLRU } from "@/browser/hooks/useModelLRU";

/**
 * Get send options from localStorage
 * Mirrors logic from useSendMessageOptions but works outside React context
 *
 * Used by useResumeManager for auto-retry without hook dependencies.
 * This ensures DRY - single source of truth for option extraction.
 */
export function getSendOptionsFromStorage(workspaceId: string): SendMessageOptions {
  // Read model preference (workspace-specific), fallback to most recent from LRU
  const model = readPersistedState<string>(getModelKey(workspaceId), getDefaultModelFromLRU());

  // Read thinking level (workspace-specific)
  const thinkingLevel = readPersistedState<ThinkingLevel>(
    getThinkingLevelKey(workspaceId),
    "medium"
  );

  // Read mode (workspace-specific)
  const mode = readPersistedState<UIMode>(getModeKey(workspaceId), "exec");

  // Read 1M context (global)
  const use1M = readPersistedState<boolean>(USE_1M_CONTEXT_KEY, false);

  // Plan mode system instructions
  const additionalSystemInstructions = mode === "plan" ? PLAN_MODE_INSTRUCTION : undefined;

  // Enforce thinking policy (gpt-5-pro → high only)
  const effectiveThinkingLevel = enforceThinkingPolicy(model, thinkingLevel);

  return {
    model,
    thinkingLevel: effectiveThinkingLevel,
    toolPolicy: modeToToolPolicy(mode),
    additionalSystemInstructions,
    providerOptions: {
      anthropic: {
        use1MContext: use1M,
      },
    },
  };
}
