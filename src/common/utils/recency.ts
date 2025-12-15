import type { MuxMessage } from "@/common/types/message";

/**
 * Check if a message is an idle compaction request.
 * Used to exclude these from recency calculation since they shouldn't affect
 * when the workspace was "last used" by the user.
 */
function isIdleCompactionRequest(msg: MuxMessage): boolean {
  const muxMeta = msg.metadata?.muxMetadata;
  return muxMeta?.type === "compaction-request" && muxMeta?.source === "idle-compaction";
}

/**
 * Compute recency timestamp from messages.
 * Returns max of: createdAt, last user message timestamp, last compacted message timestamp.
 * This is the single source of truth for workspace recency.
 *
 * Excludes idle compaction requests since they shouldn't hoist the workspace
 * in the sidebar (they're background operations, not user activity).
 */
export function computeRecencyFromMessages(
  messages: MuxMessage[],
  createdAt?: number
): number | null {
  const reversed = [...messages].reverse();
  const lastUserMsg = reversed.find(
    (m) => m.role === "user" && m.metadata?.timestamp && !isIdleCompactionRequest(m)
  );
  const lastCompactedMsg = reversed.find(
    (m) => m.metadata?.compacted === true && m.metadata?.timestamp
  );
  const candidates = [
    createdAt ?? null,
    lastUserMsg?.metadata?.timestamp ?? null,
    lastCompactedMsg?.metadata?.timestamp ?? null,
  ].filter((t): t is number => t !== null);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}
