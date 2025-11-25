/**
 * Compaction options transformation
 *
 * Single source of truth for converting compaction metadata into SendMessageOptions.
 * Used by both ChatInput (initial send) and useResumeManager (resume after interruption).
 */

import type { SendMessageOptions } from "@/common/orpc/types";
import type { CompactionRequestData } from "@/common/types/message";

/**
 * Apply compaction-specific option overrides to base options.
 *
 * This function is the single source of truth for how compaction metadata
 * transforms workspace defaults. Both initial sends and stream resumption
 * use this function to ensure consistent behavior.
 *
 * @param baseOptions - Workspace default options (from localStorage or useSendMessageOptions)
 * @param compactData - Compaction request metadata from /compact command
 * @returns Final SendMessageOptions with compaction overrides applied
 */
export function applyCompactionOverrides(
  baseOptions: SendMessageOptions,
  compactData: CompactionRequestData
): SendMessageOptions {
  // Use custom model if specified, otherwise use workspace default
  const compactionModel = compactData.model ?? baseOptions.model;

  return {
    ...baseOptions,
    model: compactionModel,
    // Keep workspace default thinking level - all models support thinking now that tools are disabled
    thinkingLevel: baseOptions.thinkingLevel,
    maxOutputTokens: compactData.maxOutputTokens,
    mode: "compact" as const,
    toolPolicy: [], // Disable all tools during compaction
  };
}
