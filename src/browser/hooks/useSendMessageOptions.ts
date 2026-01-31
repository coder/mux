import { useThinkingLevel } from "./useThinkingLevel";
import { useAgent } from "@/browser/contexts/AgentContext";
import { usePersistedState } from "./usePersistedState";
import { getDefaultModel } from "./useModelsFromSettings";
import { migrateGatewayModel } from "./useGatewayModels";
import {
  getModelKey,
  PREFERRED_SYSTEM_1_MODEL_KEY,
  PREFERRED_SYSTEM_1_THINKING_LEVEL_KEY,
} from "@/common/constants/storage";
import type { SendMessageOptions } from "@/common/orpc/types";
import { coerceThinkingLevel, type ThinkingLevel } from "@/common/types/thinking";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import { getSendOptionsFromStorage } from "@/browser/utils/messages/sendOptions";
import { useProviderOptions } from "./useProviderOptions";
import { useExperimentOverrideValue } from "./useExperiments";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";

interface ExperimentValues {
  programmaticToolCalling: boolean | undefined;
  programmaticToolCallingExclusive: boolean | undefined;
  system1: boolean | undefined;
}

/**
 * Construct SendMessageOptions from raw values
 * Shared logic for both hook and non-hook versions
 *
 * Note: Plan mode instructions are handled by the backend (has access to plan file path)
 */
function constructSendMessageOptions(
  agentId: string,
  thinkingLevel: ThinkingLevel,
  baseModel: string,
  providerOptions: MuxProviderOptions,
  experimentValues: ExperimentValues,
  system1Model: string | undefined,
  system1ThinkingLevel: ThinkingLevel | undefined
): SendMessageOptions {
  // Preserve the user's preferred thinking level; backend enforces per-model policy.
  const uiThinking = thinkingLevel;

  const system1ModelForBackend =
    system1Model !== undefined ? migrateGatewayModel(system1Model) : undefined;

  const system1ThinkingLevelForBackend =
    system1ThinkingLevel !== undefined && system1ThinkingLevel !== "off"
      ? system1ThinkingLevel
      : undefined;

  return {
    thinkingLevel: uiThinking,
    model: baseModel,
    ...(system1ModelForBackend ? { system1Model: system1ModelForBackend } : {}),
    ...(system1ThinkingLevelForBackend
      ? { system1ThinkingLevel: system1ThinkingLevelForBackend }
      : {}),
    agentId,
    // toolPolicy is computed by backend from agent definitions (resolveToolPolicyForAgent)
    providerOptions,
    experiments: {
      programmaticToolCalling: experimentValues.programmaticToolCalling,
      programmaticToolCallingExclusive: experimentValues.programmaticToolCallingExclusive,
      system1: experimentValues.system1,
    },
  };
}

/**
 * Extended send options that includes both the canonical model used for backend routing
 * and a base model string for UI components that need a stable display value.
 */
export interface SendMessageOptionsWithBase extends SendMessageOptions {
  /** Base model in canonical format (e.g., "openai:gpt-5.1-codex-max") for UI/policy checks */
  baseModel: string;
}

/**
 * Build SendMessageOptions from current user preferences
 * This ensures all message sends (new, retry, resume) use consistent options
 *
 * Single source of truth for message options - guarantees parity between
 * ChatInput, RetryBarrier, and any other components that send messages.
 *
 * Uses usePersistedState which has listener mode, so changes to preferences
 * propagate automatically to all components using this hook.
 *
 * Returns both `model` (canonical for backend routing) and `baseModel`
 * (canonical format for UI display and policy checks).
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

  const [preferredSystem1Model] = usePersistedState<unknown>(PREFERRED_SYSTEM_1_MODEL_KEY, "", {
    listener: true,
  });
  const system1ModelTrimmed =
    typeof preferredSystem1Model === "string" ? preferredSystem1Model.trim() : undefined;
  const system1Model =
    system1ModelTrimmed !== undefined && system1ModelTrimmed.length > 0
      ? system1ModelTrimmed
      : undefined;

  const [preferredSystem1ThinkingLevel] = usePersistedState<unknown>(
    PREFERRED_SYSTEM_1_THINKING_LEVEL_KEY,
    "off",
    { listener: true }
  );
  const system1ThinkingLevel = coerceThinkingLevel(preferredSystem1ThinkingLevel) ?? "off";

  // Compute base model (canonical format) for UI components
  const rawModel =
    typeof preferredModel === "string" && preferredModel ? preferredModel : defaultModel;
  const baseModel = migrateGatewayModel(rawModel);

  const options = constructSendMessageOptions(
    agentId,
    thinkingLevel,
    baseModel,
    providerOptions,
    { programmaticToolCalling, programmaticToolCallingExclusive, system1 },
    system1Model,
    system1ThinkingLevel
  );

  return {
    ...options,
    baseModel,
    disableWorkspaceAgents: disableWorkspaceAgents || undefined, // Only include if true
  };
}

/**
 * Build SendMessageOptions outside React using the shared storage reader.
 * Single source of truth with getSendOptionsFromStorage to avoid JSON parsing bugs.
 */
export function buildSendMessageOptions(workspaceId: string): SendMessageOptions {
  return getSendOptionsFromStorage(workspaceId);
}
