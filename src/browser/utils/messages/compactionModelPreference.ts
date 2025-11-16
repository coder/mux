/**
 * Compaction model preference management
 *
 * Handles the sticky global preference for which model to use during compaction.
 */

import { PREFERRED_COMPACTION_MODEL_KEY } from "@/common/constants/storage";

/**
 * Resolve the effective compaction model, saving preference if a model is specified.
 *
 * @param requestedModel - Model specified in /compact -m flag (if any)
 * @returns The model to use for compaction, or undefined to use workspace default
 */
export function resolveCompactionModel(requestedModel: string | undefined): string | undefined {
  if (requestedModel) {
    // User specified a model with -m flag, save it as the new preference
    localStorage.setItem(PREFERRED_COMPACTION_MODEL_KEY, requestedModel);
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
