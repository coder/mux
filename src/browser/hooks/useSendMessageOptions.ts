import { useThinkingLevel } from "./useThinkingLevel";
import { useMode } from "@/browser/contexts/ModeContext";
import { usePersistedState } from "./usePersistedState";
import { getDefaultModel } from "./useModelLRU";
import { migrateGatewayModel, useGateway, isProviderSupported } from "./useGatewayModels";
import { modeToToolPolicy } from "@/common/utils/ui/modeUtils";
import { getModelKey } from "@/common/constants/storage";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { UIMode } from "@/common/types/mode";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import { getSendOptionsFromStorage } from "@/browser/utils/messages/sendOptions";
import { enforceThinkingPolicy } from "@/browser/utils/thinking/policy";
import { useProviderOptions } from "./useProviderOptions";
import type { GatewayState } from "./useGatewayModels";

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

/**
 * Construct SendMessageOptions from raw values
 * Shared logic for both hook and non-hook versions
 *
 * Note: Plan mode instructions are handled by the backend (has access to plan file path)
 */
function constructSendMessageOptions(
  mode: UIMode,
  thinkingLevel: ThinkingLevel,
  preferredModel: string | null | undefined,
  providerOptions: MuxProviderOptions,
  fallbackModel: string,
  gateway: GatewayState
): SendMessageOptions {
  // Ensure model is always a valid string (defensive against corrupted localStorage)
  const rawModel =
    typeof preferredModel === "string" && preferredModel ? preferredModel : fallbackModel;

  // Migrate any legacy mux-gateway:provider/model format to canonical form
  const baseModel = migrateGatewayModel(rawModel);

  // Enforce thinking policy BEFORE gateway transform (policy checks canonical model name)
  const uiThinking = enforceThinkingPolicy(baseModel, thinkingLevel);

  // Transform to gateway format if gateway is enabled for this model (reactive)
  const model = applyGatewayTransform(baseModel, gateway);

  return {
    thinkingLevel: uiThinking,
    model,
    mode: mode === "exec" || mode === "plan" ? mode : "exec", // Only pass exec/plan to backend
    toolPolicy: modeToToolPolicy(mode),
    providerOptions,
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
  const { options: providerOptions } = useProviderOptions();
  const defaultModel = getDefaultModel();
  const [preferredModel] = usePersistedState<string>(
    getModelKey(workspaceId),
    defaultModel, // Default to most recently used model
    { listener: true } // Listen for changes from ModelSelector and other sources
  );

  // Subscribe to gateway state so we re-render when user toggles gateway
  const gateway = useGateway();

  // Compute base model (canonical format) for UI components
  const rawModel =
    typeof preferredModel === "string" && preferredModel ? preferredModel : defaultModel;
  const baseModel = migrateGatewayModel(rawModel);

  const options = constructSendMessageOptions(
    mode,
    thinkingLevel,
    preferredModel,
    providerOptions,
    defaultModel,
    gateway
  );

  return { ...options, baseModel };
}

/**
 * Build SendMessageOptions outside React using the shared storage reader.
 * Single source of truth with getSendOptionsFromStorage to avoid JSON parsing bugs.
 */
export function buildSendMessageOptions(workspaceId: string): SendMessageOptions {
  return getSendOptionsFromStorage(workspaceId);
}
