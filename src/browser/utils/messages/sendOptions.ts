import {
  getAgentIdKey,
  getModelKey,
  getThinkingLevelByModelKey,
  getThinkingLevelKey,
  getDisableWorkspaceAgentsKey,
} from "@/common/constants/storage";
import {
  readPersistedState,
  readPersistedString,
  updatePersistedState,
} from "@/browser/hooks/usePersistedState";
import { getDefaultModel } from "@/browser/hooks/useModelsFromSettings";
import { toGatewayModel, migrateGatewayModel } from "@/browser/hooks/useGatewayModels";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { ThinkingLevel } from "@/common/types/thinking";
import { enforceThinkingPolicy } from "@/common/utils/thinking/policy";
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
export function getSendOptionsFromStorage(workspaceId: string): SendMessageOptions {
  // Read model preference (workspace-specific), fallback to the Settings default
  const rawModel = readPersistedState<string>(getModelKey(workspaceId), getDefaultModel());
  // Migrate any legacy mux-gateway:provider/model format to canonical form
  const baseModel = migrateGatewayModel(rawModel);
  // Transform to gateway format if gateway is enabled for this model
  const model = toGatewayModel(baseModel);

  // Read thinking level (workspace-scoped).
  // Migration: if the workspace-scoped value is missing, fall back to legacy per-model storage
  // once, then persist into the workspace-scoped key.
  const scopedKey = getThinkingLevelKey(workspaceId);
  const existingScoped = readPersistedState<ThinkingLevel | undefined>(scopedKey, undefined);
  const thinkingLevel =
    existingScoped ??
    readPersistedState<ThinkingLevel>(
      getThinkingLevelByModelKey(baseModel),
      WORKSPACE_DEFAULTS.thinkingLevel
    );
  if (existingScoped === undefined) {
    // Best-effort: avoid losing a user's existing per-model preference.
    updatePersistedState<ThinkingLevel>(scopedKey, thinkingLevel);
  }

  const agentIdKey = getAgentIdKey(workspaceId);

  // Read selected agentId (workspace-specific).
  // Migration: if missing, fall back to the legacy mode key and seed agentId so non-hook readers
  // (auto-retry/resume) behave consistently across upgrades.
  const persistedAgentId = readPersistedString(agentIdKey);
  const agentIdFromStorage =
    typeof persistedAgentId === "string" && persistedAgentId.trim().length > 0
      ? persistedAgentId.trim().toLowerCase()
      : undefined;

  const legacyMode = readPersistedString(`mode:${workspaceId}`);
  const legacyAgentId = legacyMode === "plan" || legacyMode === "exec" ? legacyMode : undefined;

  const agentId = agentIdFromStorage ?? legacyAgentId ?? WORKSPACE_DEFAULTS.mode;

  if (persistedAgentId === undefined && legacyAgentId !== undefined) {
    updatePersistedState(agentIdKey, legacyAgentId);
  }

  // Derive mode from agentId (plan agent → plan mode, everything else → exec mode)
  // Used by backend for AI settings persistence and compaction detection
  const mode = agentId === "plan" ? "plan" : "exec";

  // Get provider options
  const providerOptions = getProviderOptions();

  // Plan mode instructions are now handled by the backend (has access to plan file path)

  // Enforce thinking policy (gpt-5-pro → high only)
  const effectiveThinkingLevel = enforceThinkingPolicy(baseModel, thinkingLevel);

  // Read disableWorkspaceAgents toggle (workspace-scoped)
  const disableWorkspaceAgents = readPersistedState<boolean>(
    getDisableWorkspaceAgentsKey(workspaceId),
    false
  );

  return {
    model,
    agentId,
    mode,
    thinkingLevel: effectiveThinkingLevel,
    // toolPolicy is computed by backend from agent definitions (resolveToolPolicyForAgent)
    providerOptions,
    disableWorkspaceAgents: disableWorkspaceAgents || undefined, // Only include if true
    experiments: {
      postCompactionContext: isExperimentEnabled(EXPERIMENT_IDS.POST_COMPACTION_CONTEXT),
      programmaticToolCalling: isExperimentEnabled(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING),
      programmaticToolCallingExclusive: isExperimentEnabled(
        EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING_EXCLUSIVE
      ),
    },
  };
}
