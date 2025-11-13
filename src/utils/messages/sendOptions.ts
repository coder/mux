import {
  getModelKey,
  getThinkingLevelKey,
  getModeKey,
  USE_1M_CONTEXT_KEY,
} from "@/constants/storage";
import { modeToToolPolicy, PLAN_MODE_INSTRUCTION } from "@/utils/ui/modeUtils";
import { readPersistedState } from "@/hooks/usePersistedState";
import type { SendMessageOptions } from "@/types/ipc";
import type { UIMode } from "@/types/mode";
import type { ThinkingLevel } from "@/types/thinking";
import { enforceThinkingPolicy } from "@/utils/thinking/policy";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

/**
 * Get send options from localStorage
 * Mirrors logic from useSendMessageOptions but works outside React context
 *
 * Used by useResumeManager for auto-retry without hook dependencies.
 * This ensures DRY - single source of truth for option extraction.
 */
export function getSendOptionsFromStorage(workspaceId: string): SendMessageOptions {
  // Read model preference (workspace-specific), fallback to hard-coded default
  const model = readPersistedState<string>(getModelKey(workspaceId), WORKSPACE_DEFAULTS.model);

  // Read thinking level (workspace-specific)
  const thinkingLevel = readPersistedState<ThinkingLevel>(
    getThinkingLevelKey(workspaceId),
    WORKSPACE_DEFAULTS.thinkingLevel
  );

  // Read mode (workspace-specific)
  const mode = readPersistedState<UIMode>(getModeKey(workspaceId), WORKSPACE_DEFAULTS.mode);

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
