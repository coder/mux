import {
  getDisableWorkspaceAgentsKey,
  PREFERRED_SYSTEM_1_MODEL_KEY,
  PREFERRED_SYSTEM_1_THINKING_LEVEL_KEY,
} from "@/common/constants/storage";
import { readPersistedState, readPersistedString } from "@/browser/hooks/usePersistedState";
import { readScopedAiSettings } from "@/browser/hooks/useWorkspaceAiSettings";
import { toGatewayModel, migrateGatewayModel } from "@/browser/hooks/useGatewayModels";
import type { SendMessageOptions } from "@/common/orpc/types";
import { coerceThinkingLevel } from "@/common/types/thinking";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import { isExperimentEnabled } from "@/browser/hooks/useExperiments";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";

/**
 * Read provider options from localStorage
 */
function getProviderOptions(): MuxProviderOptions {
  const anthropic = readPersistedState<MuxProviderOptions["anthropic"]>(
    "provider_options_anthropic",
    { use1MContext: false }
  );
  const google = readPersistedState<MuxProviderOptions["google"]>("provider_options_google", {});

  return {
    anthropic,
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
interface GetSendOptionsFromStorageProps {
  scopeId: string;
  workspaceId?: string;
}

export function getSendOptionsFromStorage(
  props: GetSendOptionsFromStorageProps
): SendMessageOptions {
  const scopeId = props.scopeId;
  const workspaceId = props.workspaceId;

  // Read model, thinking level, and agent ID from the unified accessor
  const settings = readScopedAiSettings({ scopeId, workspaceId });
  const { agentId, thinkingLevel } = settings;

  // Transform to gateway format if gateway is enabled for this model
  const model = toGatewayModel(settings.model);

  // Get provider options
  const providerOptions = getProviderOptions();

  // Plan mode instructions are now handled by the backend (has access to plan file path)

  // Read disableWorkspaceAgents toggle (scope-scoped)

  const system1ModelTrimmed = readPersistedString(PREFERRED_SYSTEM_1_MODEL_KEY)?.trim();
  const baseSystem1Model =
    system1ModelTrimmed !== undefined && system1ModelTrimmed.length > 0
      ? migrateGatewayModel(system1ModelTrimmed)
      : undefined;
  const system1Model =
    baseSystem1Model !== undefined ? toGatewayModel(baseSystem1Model) : undefined;
  const system1ThinkingLevelRaw = readPersistedState<unknown>(
    PREFERRED_SYSTEM_1_THINKING_LEVEL_KEY,
    "off"
  );
  const system1ThinkingLevel = coerceThinkingLevel(system1ThinkingLevelRaw) ?? "off";

  const disableWorkspaceAgents = readPersistedState<boolean>(
    getDisableWorkspaceAgentsKey(scopeId),
    false
  );

  return {
    model,
    system1Model,
    system1ThinkingLevel: system1ThinkingLevel !== "off" ? system1ThinkingLevel : undefined,
    agentId,
    thinkingLevel,
    // toolPolicy is computed by backend from agent definitions (resolveToolPolicyForAgent)
    providerOptions,
    disableWorkspaceAgents: disableWorkspaceAgents || undefined, // Only include if true
    experiments: {
      programmaticToolCalling: isExperimentEnabled(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING),
      programmaticToolCallingExclusive: isExperimentEnabled(
        EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING_EXCLUSIVE
      ),
      system1: isExperimentEnabled(EXPERIMENT_IDS.SYSTEM_1),
    },
  };
}
