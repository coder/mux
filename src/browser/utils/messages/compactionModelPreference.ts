/**
 * Compaction model preference management
 */

import { readPersistedString } from "@/browser/hooks/usePersistedState";
import { PREFERRED_COMPACTION_MODEL_KEY } from "@/common/constants/storage";

// Re-export for convenience - validation used in /compact handler
export { isValidModelFormat } from "@/common/utils/ai/models";

/**
 * Resolve the effective compaction model to use.
 *
 * Priority:
 * 1) /compact -m flag (requestedModel)
 * 2) Settings preference (preferredCompactionModel)
 * 3) undefined (caller falls back to workspace model)
 */
export function resolveCompactionModel(requestedModel: string | undefined): string | undefined {
  if (typeof requestedModel === "string" && requestedModel.trim().length > 0) {
    return requestedModel;
  }

  const preferred = readPersistedString(PREFERRED_COMPACTION_MODEL_KEY);
  if (typeof preferred === "string" && preferred.trim().length > 0) {
    return preferred;
  }

  return undefined;
}
