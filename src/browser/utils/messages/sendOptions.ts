import { getModelKey, getThinkingLevelKey, getModeKey } from "@/common/constants/storage";
import { modeToToolPolicy, PLAN_MODE_INSTRUCTION } from "@/common/utils/ui/modeUtils";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { getDefaultModel } from "@/browser/hooks/useModelLRU";
import { toGatewayModel, migrateGatewayModel } from "@/browser/hooks/useGatewayModels";
import type { SendMessageOptions } from "@/common/orpc/types";
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
  // Read model preference (workspace-specific), fallback to LRU default
  const rawModel = readPersistedState<string>(getModelKey(workspaceId), getDefaultModel());
  // Migrate any legacy mux-gateway:provider/model format to canonical form
  const baseModel = migrateGatewayModel(rawModel);
  // Transform to gateway format if gateway is enabled for this model
  const model = toGatewayModel(baseModel);

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
    mode: mode === "exec" || mode === "plan" ? mode : "exec", // Only pass exec/plan to backend
    thinkingLevel: effectiveThinkingLevel,
    toolPolicy: modeToToolPolicy(mode),
    additionalSystemInstructions,
    providerOptions,
  };
}
