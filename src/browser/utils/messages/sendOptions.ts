import {
  getAgentIdKey,
  getModelKey,
  getThinkingLevelByModelKey,
  getThinkingLevelKey,
  getDisableWorkspaceAgentsKey,
  PREFERRED_SYSTEM_1_MODEL_KEY,
  PREFERRED_SYSTEM_1_THINKING_LEVEL_KEY,
} from "@/common/constants/storage";
import {
  readPersistedState,
  readPersistedString,
  updatePersistedState,
} from "@/browser/hooks/usePersistedState";
import { getDefaultModel } from "@/browser/hooks/useModelsFromSettings";
import { readWorkspaceAiSettings } from "@/browser/hooks/useWorkspaceAiSettings";
import { toGatewayModel, migrateGatewayModel } from "@/browser/hooks/useGatewayModels";
import type { SendMessageOptions } from "@/common/orpc/types";
import { coerceThinkingLevel, type ThinkingLevel } from "@/common/types/thinking";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
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
  const defaultModel = getDefaultModel();

  const workspaceSettings =
    typeof workspaceId === "string" && workspaceId.trim().length > 0
      ? readWorkspaceAiSettings({ workspaceId, defaultModel })
      : null;

  // Workspace AI settings cache is the source of truth; fall back to scope keys for project/global.
  const rawModel = workspaceSettings
    ? workspaceSettings.model
    : readPersistedState<string>(getModelKey(scopeId), defaultModel);
  // Migrate any legacy mux-gateway:provider/model format to canonical form
  const baseModel = workspaceSettings
    ? workspaceSettings.model
    : migrateGatewayModel(rawModel || defaultModel);
  // Transform to gateway format if gateway is enabled for this model
  const model = toGatewayModel(baseModel);

  let thinkingLevel: ThinkingLevel;
  if (workspaceSettings) {
    thinkingLevel = workspaceSettings.thinkingLevel;
  } else {
    // Read thinking level (project/global scoped).
    // Migration: if the scope value is missing, fall back to legacy per-model storage
    // once, then persist into the scope-scoped key.
    const scopedKey = getThinkingLevelKey(scopeId);
    const existingScoped = readPersistedState<ThinkingLevel | undefined>(scopedKey, undefined);
    const resolvedThinking =
      existingScoped ??
      readPersistedState<ThinkingLevel>(
        getThinkingLevelByModelKey(baseModel),
        WORKSPACE_DEFAULTS.thinkingLevel
      );
    if (existingScoped === undefined) {
      // Best-effort: avoid losing a user's existing per-model preference.
      updatePersistedState<ThinkingLevel>(scopedKey, resolvedThinking);
    }

    thinkingLevel = resolvedThinking;
  }

  // Read selected agent id (scope-specific)
  const agentId = workspaceSettings
    ? workspaceSettings.agentId
    : readPersistedState<string>(getAgentIdKey(scopeId), WORKSPACE_DEFAULTS.agentId);

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
