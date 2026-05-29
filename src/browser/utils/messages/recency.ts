import type { MuxMessage } from "@/common/types/message";
import { computeRecencyFromMessages } from "@/common/utils/recency";

/**
 * Compute recency timestamp for workspace sorting.
 * Wrapper that handles string timestamp parsing for frontend use.
 *
 * Returns the maximum of:
 * - Workspace creation timestamp (ensures newly created/forked workspaces appear at top)
 * - Workspace unarchived timestamp (ensures restored workspaces appear at top)
 * - Last user message timestamp (most recent user interaction)
 * - Last compacted message timestamp (fallback for compacted histories)
 */
export function computeRecencyTimestamp(
  messages: MuxMessage[],
  createdAt?: string,
  unarchivedAt?: string
): number | null {
  let createdTimestamp: number | undefined;
  if (createdAt) {
    const parsed = new Date(createdAt).getTime();
    createdTimestamp = !isNaN(parsed) ? parsed : undefined;
  }
  let unarchivedTimestamp: number | undefined;
  if (unarchivedAt) {
    const parsed = new Date(unarchivedAt).getTime();
    unarchivedTimestamp = !isNaN(parsed) ? parsed : undefined;
  }
  return computeRecencyFromMessages(messages, createdTimestamp, unarchivedTimestamp);
}
