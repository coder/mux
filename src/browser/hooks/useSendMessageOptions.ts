import { useThinkingLevel } from "./useThinkingLevel";
import { useMode } from "@/browser/contexts/ModeContext";
import { usePersistedState } from "./usePersistedState";
import { getDefaultModelFromLRU } from "./useModelLRU";
import { modeToToolPolicy, PLAN_MODE_INSTRUCTION } from "@/common/utils/ui/modeUtils";
import { getModelKey } from "@/common/constants/storage";
import type { SendMessageOptions } from "@/common/types/ipc";
import type { UIMode } from "@/common/types/mode";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import { getSendOptionsFromStorage } from "@/browser/utils/messages/sendOptions";
import { enforceThinkingPolicy } from "@/browser/utils/thinking/policy";
import { useProviderOptions } from "./useProviderOptions";

/**
 * Construct SendMessageOptions from raw values
 * Shared logic for both hook and non-hook versions
 */
function constructSendMessageOptions(
  mode: UIMode,
  thinkingLevel: ThinkingLevel,
  preferredModel: string | null | undefined,
  providerOptions: MuxProviderOptions,
  fallbackModel: string
): SendMessageOptions {
  const additionalSystemInstructions = mode === "plan" ? PLAN_MODE_INSTRUCTION : undefined;

  // Ensure model is always a valid string (defensive against corrupted localStorage)
  const model =
    typeof preferredModel === "string" && preferredModel ? preferredModel : fallbackModel;

  // Enforce thinking policy at the UI boundary as well (e.g., gpt-5-pro → high only)
  const uiThinking = enforceThinkingPolicy(model, thinkingLevel);

  return {
    thinkingLevel: uiThinking,
    model,
    mode: mode === "exec" || mode === "plan" ? mode : "exec", // Only pass exec/plan to backend
    toolPolicy: modeToToolPolicy(mode),
    additionalSystemInstructions,
    providerOptions,
  };
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
 */
export function useSendMessageOptions(workspaceId: string): SendMessageOptions {
  const [thinkingLevel] = useThinkingLevel();
  const [mode] = useMode();
  const { options: providerOptions } = useProviderOptions();
  const defaultModel = getDefaultModelFromLRU();
  const [preferredModel] = usePersistedState<string>(
    getModelKey(workspaceId),
    defaultModel, // Default to most recently used model
    { listener: true } // Listen for changes from ModelSelector and other sources
  );

  return constructSendMessageOptions(
    mode,
    thinkingLevel,
    preferredModel,
    providerOptions,
    defaultModel
  );
}

/**
 * Build SendMessageOptions outside React using the shared storage reader.
 * Single source of truth with getSendOptionsFromStorage to avoid JSON parsing bugs.
 */
export function buildSendMessageOptions(workspaceId: string): SendMessageOptions {
  return getSendOptionsFromStorage(workspaceId);
}
