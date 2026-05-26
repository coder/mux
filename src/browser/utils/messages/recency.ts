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
  return computeRecencyFromMessages(
    messages,
    parseOptionalIsoTimestamp(createdAt),
    parseOptionalIsoTimestamp(unarchivedAt)
  );
}

// Both `createdAt` and `unarchivedAt` arrive as optional ISO strings and feed
// the same numeric-timestamp slot in `computeRecencyFromMessages`. Centralizing
// the parse keeps the invalid-date guard (NaN → undefined) consistent across
// inputs; an unparseable string is treated the same as a missing one so it
// can't poison the max() in the underlying recency calculation.
function parseOptionalIsoTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = new Date(value).getTime();
  return !isNaN(parsed) ? parsed : undefined;
}
