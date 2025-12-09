import type { AutoCompactionCheckResult } from "./autoCompactionCheck";

/**
 * Determines if auto-compaction should trigger based on usage check result.
 * Used by ChatInput to decide whether to auto-compact before sending a message.
 */
export function shouldTriggerAutoCompaction(
  autoCompactionCheck: AutoCompactionCheckResult | undefined,
  isCompacting: boolean,
  isEditing: boolean
): boolean {
  if (!autoCompactionCheck) return false;
  if (isCompacting) return false;
  if (isEditing) return false;

  return autoCompactionCheck.usagePercentage >= autoCompactionCheck.thresholdPercentage;
}
