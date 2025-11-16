import type { MuxMessage } from "@/common/types/message";

/**
 * Compute recency timestamp for workspace sorting.
 *
 * Returns the maximum of:
 * - Workspace creation timestamp (ensures newly created/forked workspaces appear at top)
 * - Last user message timestamp (most recent user interaction)
 * - Last compacted message timestamp (fallback for compacted histories)
 *
 * This eliminates race conditions where workspaces appear at bottom before messages load.
 */
export function computeRecencyTimestamp(messages: MuxMessage[], createdAt?: string): number | null {
  if (messages.length === 0 && !createdAt) {
    return null;
  }

  // Parse createdAt to Unix timestamp (ms), handle invalid dates
  let createdTimestamp: number | null = null;
  if (createdAt) {
    const parsed = new Date(createdAt).getTime();
    createdTimestamp = !isNaN(parsed) ? parsed : null;
  }

  // Single reverse pass to find last user and compacted messages
  const reversed = [...messages].reverse();

  const lastUserMsg = reversed.find((m) => m.role === "user" && m.metadata?.timestamp);
  const lastCompactedMsg = reversed.find(
    (m) => m.metadata?.compacted === true && m.metadata?.timestamp
  );

  // Collect all candidate timestamps and return the maximum
  const candidates = [
    createdTimestamp,
    lastUserMsg?.metadata?.timestamp ?? null,
    lastCompactedMsg?.metadata?.timestamp ?? null,
  ].filter((t): t is number => t !== null);

  return candidates.length > 0 ? Math.max(...candidates) : null;
}
