import type { SendMessageOptions } from "@/common/types/ipc";

/**
 * Build sanitized SendMessageOptions for auto-continue messages after compaction.
 *
 * - Drops compaction-specific overrides (mode="compact", maxOutputTokens)
 * - Removes frontend metadata (muxMetadata)
 * - Restores the original workspace model when provided
 */
export function buildContinueMessageOptions(
  options: SendMessageOptions,
  resumeModel?: string
): SendMessageOptions {
  const {
    muxMetadata: _ignoredMetadata,
    maxOutputTokens: _ignoredMaxOutputTokens,
    mode: _ignoredMode,
    ...rest
  } = options;

  const nextModel = resumeModel ?? options.model;

  return {
    ...rest,
    model: nextModel,
  };
}
