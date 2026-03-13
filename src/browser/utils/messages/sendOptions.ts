import {
  GLOBAL_SCOPE_ID,
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
import {
  buildSendMessageOptions,
  normalizeModelPreference,
  normalizeSystem1Model,
  normalizeSystem1ThinkingLevel,
} from "@/browser/utils/messages/buildSendMessageOptions";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import { getWorkspaceAiSettings } from "@/browser/services/workspaceAiSettings";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { isExperimentEnabled } from "@/browser/hooks/useExperiments";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";

/**
 * Read provider options from localStorage
 */
function getProviderOptions(): MuxProviderOptions {
  const anthropic = readPersistedState<MuxProviderOptions["anthropic"]>(
    "provider_options_anthropic",
    {}
  );
  const google = readPersistedState<MuxProviderOptions["google"]>("provider_options_google", {});

  return {
    anthropic,
    google,
  };
}

function isExistingWorkspaceScopeId(scopeId: string): boolean {
  return (
    scopeId !== GLOBAL_SCOPE_ID &&
    !scopeId.startsWith("__project__/") &&
    !scopeId.startsWith("__pending__") &&
    !scopeId.startsWith("__draft__/")
  );
}

function readLegacyPerModelThinking(rawModel: string): ThinkingLevel | undefined {
  const canonicalModel = normalizeToCanonical(rawModel);
  const canonicalThinking = readPersistedState<ThinkingLevel | undefined>(
    getThinkingLevelByModelKey(canonicalModel),
    undefined
  );

  if (canonicalThinking !== undefined) {
    return canonicalThinking;
  }

  if (canonicalModel !== rawModel) {
    return readPersistedState<ThinkingLevel | undefined>(
      getThinkingLevelByModelKey(rawModel),
      undefined
    );
  }

  return undefined;
}

function readLegacyScopedThinkingLevel(scopeId: string, baseModel: string): ThinkingLevel {
  const scopedKey = getThinkingLevelKey(scopeId);
  const existingScoped = readPersistedState<ThinkingLevel | undefined>(scopedKey, undefined);
  const thinkingLevel =
    existingScoped ?? readLegacyPerModelThinking(baseModel) ?? WORKSPACE_DEFAULTS.thinkingLevel;

  if (existingScoped === undefined) {
    // Best-effort: avoid losing a user's existing per-model preference.
    updatePersistedState<ThinkingLevel>(scopedKey, thinkingLevel);
  }

  return thinkingLevel;
}

/**
 * Non-hook equivalent of useSendMessageOptions — reads current preferences from localStorage.
 * Used by compaction, resume, idle-compaction, and plan execution outside React context.
 */
export function getSendOptionsFromStorage(workspaceId: string): SendMessageOptions {
  const defaultModel = getDefaultModel();
  const rawModel = readPersistedState<string>(getModelKey(workspaceId), defaultModel);
  const baseModel = normalizeModelPreference(rawModel, defaultModel);
  const agentId = readPersistedState<string>(
    getAgentIdKey(workspaceId),
    WORKSPACE_DEFAULTS.agentId
  );

  const thinkingLevel = isExistingWorkspaceScopeId(workspaceId)
    ? getWorkspaceAiSettings(workspaceId, agentId).thinkingLevel
    : readLegacyScopedThinkingLevel(workspaceId, baseModel);

  const providerOptions = getProviderOptions();

  const system1Model = normalizeSystem1Model(readPersistedString(PREFERRED_SYSTEM_1_MODEL_KEY));
  const system1ThinkingLevel = normalizeSystem1ThinkingLevel(
    readPersistedState<unknown>(PREFERRED_SYSTEM_1_THINKING_LEVEL_KEY, "off")
  );

  const disableWorkspaceAgents = readPersistedState<boolean>(
    getDisableWorkspaceAgentsKey(workspaceId),
    false
  );

  return buildSendMessageOptions({
    model: baseModel,
    system1Model,
    system1ThinkingLevel,
    agentId,
    thinkingLevel,
    providerOptions,
    disableWorkspaceAgents,
    experiments: {
      programmaticToolCalling: isExperimentEnabled(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING),
      programmaticToolCallingExclusive: isExperimentEnabled(
        EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING_EXCLUSIVE
      ),
      system1: isExperimentEnabled(EXPERIMENT_IDS.SYSTEM_1),
      execSubagentHardRestart: isExperimentEnabled(EXPERIMENT_IDS.EXEC_SUBAGENT_HARD_RESTART),
    },
  });
}
