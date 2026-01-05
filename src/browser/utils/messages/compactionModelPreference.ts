/**
 * Compaction model preference management
 */

import { readPersistedState, readPersistedString } from "@/browser/hooks/usePersistedState";
import { MODE_AI_DEFAULTS_KEY, PREFERRED_COMPACTION_MODEL_KEY } from "@/common/constants/storage";
import type { ModeAiDefaults } from "@/common/types/modeAiDefaults";

// Re-export for convenience - validation used in /compact handler
export { isValidModelFormat } from "@/common/utils/ai/models";

/**
 * Resolve the effective compaction model to use.
 *
 * Priority:
 * 1) /compact -m flag
 * 2) Global mode default for compact
 * 3) Legacy global preference (preferredCompactionModel)
 * 4) undefined (caller falls back to workspace default)
 */
export function resolveCompactionModel(requestedModel: string | undefined): string | undefined {
  if (typeof requestedModel === "string" && requestedModel.trim().length > 0) {
    return requestedModel;
  }

  const modeAiDefaults = readPersistedState<ModeAiDefaults>(MODE_AI_DEFAULTS_KEY, {});
  const compactModel = modeAiDefaults.compact?.modelString;
  if (typeof compactModel === "string" && compactModel.trim().length > 0) {
    return compactModel;
  }

  const legacyModel = readPersistedString(PREFERRED_COMPACTION_MODEL_KEY);
  if (typeof legacyModel === "string" && legacyModel.trim().length > 0) {
    return legacyModel;
  }

  return undefined;
}
