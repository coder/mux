import { getModelKey, getThinkingLevelKey, getModeKey } from "@/common/constants/storage";
import { modeToToolPolicy, PLAN_MODE_INSTRUCTION } from "@/common/utils/ui/modeUtils";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import type { SendMessageOptions } from "@/common/types/ipc";
import type { UIMode } from "@/common/types/mode";
import type { ThinkingLevel } from "@/common/types/thinking";
import { enforceThinkingPolicy } from "@/browser/utils/thinking/policy";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

/**
 * Read provider options from localStorage
 */
function getProviderOptions(): MuxProviderOptions {
  const anthropic = readPersistedState<MuxProviderOptions["anthropic"]>(
    "provider_options_anthropic",
    { use1MContext: false }
  );
  const openai = readPersistedState<MuxProviderOptions["openai"]>("provider_options_openai", {
    disableAutoTruncation: false,
  });
  const google = readPersistedState<MuxProviderOptions["google"]>("provider_options_google", {});

  return {
    anthropic,
    openai,
    google,
  };
}

/**
 * Get send options from localStorage
 * Mirrors logic from useSendMessageOptions but works outside React context
 *
 * Used by useResumeManager for auto-retry without hook dependencies.
 * This ensures DRY - single source of truth for option extraction.
 */
export function getSendOptionsFromStorage(workspaceId: string): SendMessageOptions {
  // Read model preference (workspace-specific), fallback to immutable defaults
  const model = readPersistedState<string>(getModelKey(workspaceId), WORKSPACE_DEFAULTS.model);

  // Read thinking level (workspace-specific)
  const thinkingLevel = readPersistedState<ThinkingLevel>(
    getThinkingLevelKey(workspaceId),
    WORKSPACE_DEFAULTS.thinkingLevel
  );

  // Read mode (workspace-specific)
  const mode = readPersistedState<UIMode>(getModeKey(workspaceId), WORKSPACE_DEFAULTS.mode);

  // Get provider options
  const providerOptions = getProviderOptions();

  // Plan mode system instructions
  const additionalSystemInstructions = mode === "plan" ? PLAN_MODE_INSTRUCTION : undefined;

  // Enforce thinking policy (gpt-5-pro → high only)
  const effectiveThinkingLevel = enforceThinkingPolicy(model, thinkingLevel);

  return {
    model,
    thinkingLevel: effectiveThinkingLevel,
    toolPolicy: modeToToolPolicy(mode),
    additionalSystemInstructions,
    providerOptions,
  };
}
