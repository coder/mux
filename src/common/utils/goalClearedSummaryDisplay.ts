import type { MuxMessageMetadata } from "@/common/types/message";

const LEGACY_GOAL_CLEARED_SUMMARY_PREFIX = "Goal cleared: ";

export function getGoalClearedSummaryDisplayText(
  content: string,
  muxMetadata: MuxMessageMetadata | undefined
): string {
  if (muxMetadata?.type !== "goal-cleared-summary") {
    return content;
  }

  // Persisted summaries stay self-describing for model context; UI surfaces the concise form.
  return content.startsWith(LEGACY_GOAL_CLEARED_SUMMARY_PREFIX)
    ? content.slice(LEGACY_GOAL_CLEARED_SUMMARY_PREFIX.length)
    : content;
}
