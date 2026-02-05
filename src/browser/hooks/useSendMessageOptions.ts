import { useThinkingLevel } from "./useThinkingLevel";
import { useAgent } from "@/browser/contexts/AgentContext";
import { usePersistedState } from "./usePersistedState";
import { getDefaultModel } from "./useModelsFromSettings";
import {
  buildSendMessageOptions,
  normalizeModelPreference,
  normalizeSystem1Model,
  normalizeSystem1ThinkingLevel,
} from "@/browser/utils/messages/buildSendMessageOptions";
import {
  getModelKey,
  PREFERRED_SYSTEM_1_MODEL_KEY,
  PREFERRED_SYSTEM_1_THINKING_LEVEL_KEY,
} from "@/common/constants/storage";
import type { SendMessageOptions } from "@/common/orpc/types";
import { useProviderOptions } from "./useProviderOptions";
import { useExperimentOverrideValue } from "./useExperiments";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";

/**
 * Extended send options that includes both the canonical model used for backend routing
 * and a base model string for UI components that need a stable display value.
 */
export interface SendMessageOptionsWithBase extends SendMessageOptions {
  /** Base model in canonical format (e.g., "openai:gpt-5.1-codex-max") for UI/policy checks */
  baseModel: string;
}

/**
 * Single source of truth for message send options (ChatInput, RetryBarrier, etc.).
 * Subscribes to persisted preferences so model/thinking/agent changes propagate automatically.
 */
export function useSendMessageOptions(workspaceId: string): SendMessageOptionsWithBase {
  const [thinkingLevel] = useThinkingLevel();
  const { agentId, disableWorkspaceAgents } = useAgent();
  const { options: providerOptions } = useProviderOptions();
  const defaultModel = getDefaultModel();
  const [preferredModel] = usePersistedState<string>(
    getModelKey(workspaceId),
    defaultModel, // Default to the Settings default model
    { listener: true } // Listen for changes from ModelSelector and other sources
  );

  // Subscribe to local override state so toggles apply immediately.
  // If undefined, the backend will apply the PostHog assignment.
  const programmaticToolCalling = useExperimentOverrideValue(
    EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING
  );
  const programmaticToolCallingExclusive = useExperimentOverrideValue(
    EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING_EXCLUSIVE
  );
  const system1 = useExperimentOverrideValue(EXPERIMENT_IDS.SYSTEM_1);
  const execSubagentHardRestart = useExperimentOverrideValue(
    EXPERIMENT_IDS.EXEC_SUBAGENT_HARD_RESTART
  );

  const [preferredSystem1Model] = usePersistedState<unknown>(PREFERRED_SYSTEM_1_MODEL_KEY, "", {
    listener: true,
  });
  const system1Model = normalizeSystem1Model(preferredSystem1Model);

  const [preferredSystem1ThinkingLevel] = usePersistedState<unknown>(
    PREFERRED_SYSTEM_1_THINKING_LEVEL_KEY,
    "off",
    { listener: true }
  );
  const system1ThinkingLevel = normalizeSystem1ThinkingLevel(preferredSystem1ThinkingLevel);

  // Compute base model (canonical format) for UI components
  const baseModel = normalizeModelPreference(preferredModel, defaultModel);

  const options = buildSendMessageOptions({
    agentId,
    thinkingLevel,
    model: baseModel,
    providerOptions,
    experiments: {
      programmaticToolCalling,
      programmaticToolCallingExclusive,
      system1,
      execSubagentHardRestart,
    },
    system1Model,
    system1ThinkingLevel,
    disableWorkspaceAgents,
  });

  return {
    ...options,
    baseModel,
  };
}
