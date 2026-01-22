import { useThinkingLevel } from "./useThinkingLevel";
import { useMode } from "@/browser/contexts/ModeContext";
import { useAgent } from "@/browser/contexts/AgentContext";
import { usePersistedState } from "./usePersistedState";
import { getDefaultModel } from "./useModelsFromSettings";
import { migrateGatewayModel, useGateway, isProviderSupported } from "./useGatewayModels";
import {
  getModelKey,
  PREFERRED_SYSTEM_1_MODEL_KEY,
  PREFERRED_SYSTEM_1_THINKING_LEVEL_KEY,
} from "@/common/constants/storage";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { UIMode } from "@/common/types/mode";
import { coerceThinkingLevel, type ThinkingLevel } from "@/common/types/thinking";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import { getSendOptionsFromStorage } from "@/browser/utils/messages/sendOptions";
import { useProviderOptions } from "./useProviderOptions";
import type { GatewayState } from "./useGatewayModels";
import { useExperimentOverrideValue } from "./useExperiments";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";

/**
 * Transform model to gateway format using reactive gateway state.
 * This ensures the component re-renders when gateway toggles change.
 */
function applyGatewayTransform(modelId: string, gateway: GatewayState): string {
  if (!gateway.isActive || !isProviderSupported(modelId) || !gateway.modelUsesGateway(modelId)) {
    return modelId;
  }

  // Transform provider:model to mux-gateway:provider/model
  const colonIndex = modelId.indexOf(":");
  if (colonIndex === -1) return modelId;

  const provider = modelId.slice(0, colonIndex);
  const model = modelId.slice(colonIndex + 1);
  return `mux-gateway:${provider}/${model}`;
}

interface ExperimentValues {
  postCompactionContext: boolean | undefined;
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
  mode: UIMode,
  agentId: string,
  thinkingLevel: ThinkingLevel,
  preferredModel: string | null | undefined,
  providerOptions: MuxProviderOptions,
  fallbackModel: string,
  gateway: GatewayState,
  experimentValues: ExperimentValues,
  system1Model: string | undefined,
  system1ThinkingLevel: ThinkingLevel | undefined
): SendMessageOptions {
  // Ensure model is always a valid string (defensive against corrupted localStorage)
  const rawModel =
    typeof preferredModel === "string" && preferredModel ? preferredModel : fallbackModel;

  // Migrate any legacy mux-gateway:provider/model format to canonical form
  const baseModel = migrateGatewayModel(rawModel);

  // Preserve the user's preferred thinking level; backend enforces per-model policy.
  const uiThinking = thinkingLevel;

  // Transform to gateway format if gateway is enabled for this model (reactive)
  const model = applyGatewayTransform(baseModel, gateway);

  const system1ModelForBackend =
    system1Model !== undefined
      ? applyGatewayTransform(migrateGatewayModel(system1Model), gateway)
      : undefined;

  const system1ThinkingLevelForBackend =
    system1ThinkingLevel !== undefined && system1ThinkingLevel !== "off"
      ? system1ThinkingLevel
      : undefined;

  return {
    thinkingLevel: uiThinking,
    model,
    ...(system1ModelForBackend ? { system1Model: system1ModelForBackend } : {}),
    ...(system1ThinkingLevelForBackend
      ? { system1ThinkingLevel: system1ThinkingLevelForBackend }
      : {}),
    agentId,
    mode: mode === "exec" || mode === "plan" ? mode : "exec", // Only pass exec/plan to backend
    // toolPolicy is computed by backend from agent definitions (resolveToolPolicyForAgent)
    providerOptions,
    experiments: {
      postCompactionContext: experimentValues.postCompactionContext,
      programmaticToolCalling: experimentValues.programmaticToolCalling,
      programmaticToolCallingExclusive: experimentValues.programmaticToolCallingExclusive,
      system1: experimentValues.system1,
    },
  };
}

/**
 * Extended send options that includes both the gateway-transformed model
 * and the base model (for UI components that need canonical model names).
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
 * Returns both `model` (possibly gateway-transformed for API calls) and
 * `baseModel` (canonical format for UI display and policy checks).
 */
export function useSendMessageOptions(workspaceId: string): SendMessageOptionsWithBase {
  const [thinkingLevel] = useThinkingLevel();
  const [mode] = useMode();
  const { agentId, disableWorkspaceAgents } = useAgent();
  const { options: providerOptions } = useProviderOptions();
  const defaultModel = getDefaultModel();
  const [preferredModel] = usePersistedState<string>(
    getModelKey(workspaceId),
    defaultModel, // Default to the Settings default model
    { listener: true } // Listen for changes from ModelSelector and other sources
  );

  // Subscribe to gateway state so we re-render when user toggles gateway
  const gateway = useGateway();

  // Subscribe to local override state so toggles apply immediately.
  // If undefined, the backend will apply the PostHog assignment.
  const postCompactionContext = useExperimentOverrideValue(EXPERIMENT_IDS.POST_COMPACTION_CONTEXT);
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
    mode,
    agentId,
    thinkingLevel,
    preferredModel,
    providerOptions,
    defaultModel,
    gateway,
    { postCompactionContext, programmaticToolCalling, programmaticToolCallingExclusive, system1 },
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
