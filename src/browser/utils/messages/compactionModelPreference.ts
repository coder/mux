/**
 * Compaction model preference management
 */

import { readPersistedString } from "@/browser/hooks/usePersistedState";
import { PREFERRED_COMPACTION_MODEL_KEY } from "@/common/constants/storage";

export function getPreferredCompactionModel(): string | undefined {
  const preferred = readPersistedString(PREFERRED_COMPACTION_MODEL_KEY);
  if (typeof preferred === "string" && preferred.trim().length > 0) {
    return preferred.trim();
  }

  return undefined;
}

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
    return requestedModel.trim();
  }

  return getPreferredCompactionModel();
}
