import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { useThinkingLevel } from "./useThinkingLevel";
import { useAgent } from "@/browser/contexts/AgentContext";
import { usePersistedState } from "./usePersistedState";
import {
  buildSendMessageOptions,
  normalizeModelPreference,
} from "@/browser/utils/messages/buildSendMessageOptions";
import { DEFAULT_MODEL_KEY, getModelKey } from "@/common/constants/storage";
import type { SendMessageOptions } from "@/common/orpc/types";
import { useProviderOptions } from "./useProviderOptions";
import { useExperimentOverrideValue } from "./useExperiments";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { getWorkspaceAiSettingsFromMetadata } from "@/browser/utils/workspaceAiSettingsSync";

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
  const { workspaceMetadata } = useWorkspaceContext();
  const { options: providerOptions } = useProviderOptions();

  // Subscribe to the global default model preference so backend-seeded values apply
  // immediately on fresh origins (e.g., when switching ports).
  const [defaultModelPref] = usePersistedState<string>(
    DEFAULT_MODEL_KEY,
    WORKSPACE_DEFAULTS.model,
    { listener: true }
  );
  const defaultModel = normalizeModelPreference(defaultModelPref, WORKSPACE_DEFAULTS.model);

  // Workspace-scoped model preference. If unset, fall back to metadata, then global default.
  // Note: we intentionally *don't* pass defaultModel as the usePersistedState initialValue;
  // initialValue is sticky and would lock in the fallback before startup seeding.
  const [preferredModel] = usePersistedState<string | null>(getModelKey(workspaceId), null, {
    listener: true,
  });

  // Subscribe to local override state so toggles apply immediately.
  // If undefined, the backend will apply the PostHog assignment.
  const programmaticToolCalling = useExperimentOverrideValue(
    EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING
  );
  const programmaticToolCallingExclusive = useExperimentOverrideValue(
    EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING_EXCLUSIVE
  );
  const advisorTool = useExperimentOverrideValue(EXPERIMENT_IDS.ADVISOR_TOOL);
  const execSubagentHardRestart = useExperimentOverrideValue(
    EXPERIMENT_IDS.EXEC_SUBAGENT_HARD_RESTART
  );

  // Prefer metadata over the global default until workspace localStorage seeding catches up.
  const metadataSettings = getWorkspaceAiSettingsFromMetadata(
    workspaceMetadata.get(workspaceId),
    agentId
  );
  const baseModel = normalizeModelPreference(
    preferredModel,
    metadataSettings.model ?? defaultModel
  );

  const options = buildSendMessageOptions({
    agentId,
    thinkingLevel,
    model: baseModel,
    providerOptions,
    experiments: {
      programmaticToolCalling,
      programmaticToolCallingExclusive,
      advisorTool,
      execSubagentHardRestart,
    },
    disableWorkspaceAgents,
  });

  return {
    ...options,
    baseModel,
  };
}
