/**
 * Compaction model preference management
 *
 * resolveCompactionModel priority:
 *   1) /compact -m flag (requestedModel)
 *   2) Settings preference (preferredCompactionModel)
 *   3) undefined → caller falls back to workspace model
 */

import { readPersistedString } from "@/browser/hooks/usePersistedState";
import { PREFERRED_COMPACTION_MODEL_KEY } from "@/common/constants/storage";

function trimmedOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

export function getPreferredCompactionModel(): string | undefined {
  return trimmedOrUndefined(readPersistedString(PREFERRED_COMPACTION_MODEL_KEY));
}

export function resolveCompactionModel(requestedModel: string | undefined): string | undefined {
  return trimmedOrUndefined(requestedModel) ?? getPreferredCompactionModel();
}
