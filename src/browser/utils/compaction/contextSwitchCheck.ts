/**
 * Context switch check utility
 *
 * Determines whether switching to a new model would exceed the model's context limit.
 * Used to warn users before they switch from a high-context model (e.g., Gemini 1M)
 * to a lower-context model (e.g., GPT 272K) when their current context is too large.
 */

import { readPersistedString } from "@/browser/hooks/usePersistedState";
import { PREFERRED_COMPACTION_MODEL_KEY } from "@/common/constants/storage";
import type { DisplayedMessage } from "@/common/types/message";
import { getEffectiveContextLimit } from "./contextLimit";

/** Safety buffer - warn if context exceeds 90% of target model's limit */
const CONTEXT_FIT_THRESHOLD = 0.9;

/** Warning state returned when context doesn't fit in target model */
export interface ContextSwitchWarning {
  currentTokens: number;
  targetLimit: number;
  targetModel: string;
  /** Model to use for compaction, or null if none available */
  compactionModel: string | null;
  /** Error message when no capable compaction model exists */
  errorMessage: string | null;
}

/**
 * Find the most recent assistant message's model from chat history.
 */
export function findPreviousModel(messages: DisplayedMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === "assistant" && msg.model) return msg.model;
  }
  return null;
}

/**
 * Resolve compaction model: preferred (if fits) → previous (if fits) → null.
 */
function resolveCompactionModel(
  currentTokens: number,
  previousModel: string | null,
  use1M: boolean
): string | null {
  const preferred = readPersistedString(PREFERRED_COMPACTION_MODEL_KEY);
  if (preferred) {
    const limit = getEffectiveContextLimit(preferred, use1M);
    if (limit && limit > currentTokens) return preferred;
  }
  if (previousModel) {
    const limit = getEffectiveContextLimit(previousModel, use1M);
    if (limit && limit > currentTokens) return previousModel;
  }
  return null;
}

/**
 * Check if switching to targetModel would exceed its context limit.
 * Returns warning info if context doesn't fit, null otherwise.
 */
export function checkContextSwitch(
  currentTokens: number,
  targetModel: string,
  previousModel: string | null,
  use1M: boolean
): ContextSwitchWarning | null {
  const targetLimit = getEffectiveContextLimit(targetModel, use1M);

  // Unknown model or context fits with 10% buffer - no warning
  if (!targetLimit || currentTokens <= targetLimit * CONTEXT_FIT_THRESHOLD) {
    return null;
  }

  const compactionModel = resolveCompactionModel(currentTokens, previousModel, use1M);

  return {
    currentTokens,
    targetLimit,
    targetModel,
    compactionModel,
    errorMessage: compactionModel
      ? null
      : "Context too large. Use `/compact -m <model>` with a 1M context model.",
  };
}
