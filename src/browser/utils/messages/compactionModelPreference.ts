/**
 * Compaction model preference management
 *
 * Handles the sticky global preference for which model to use during compaction.
 */

import { PREFERRED_COMPACTION_MODEL_KEY } from "@/common/constants/storage";

// Re-export for convenience - validation used in /compact handler
export { isValidModelFormat } from "@/common/utils/ai/models";

/**
 * Resolve the effective compaction model to use for compaction.
 *
 * @param requestedModel - Model specified in /compact -m flag (if any)
 * @returns The model to use for compaction, or undefined to use workspace default
 */
export function resolveCompactionModel(requestedModel: string | undefined): string | undefined {
  if (requestedModel) {
    return requestedModel;
  }

  // No model specified, check if user has a saved preference
  const savedModel = localStorage.getItem(PREFERRED_COMPACTION_MODEL_KEY);
  if (savedModel) {
    return savedModel;
  }

  // No preference saved, return undefined to use workspace default
  return undefined;
}
