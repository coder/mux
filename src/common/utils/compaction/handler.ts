/**
 * Compaction interrupt handling
 *
 * Two interrupt flows during compaction:
 * - Ctrl+C (cancel): Abort compaction, restore original history + command to input
 * - Ctrl+A (accept early): Complete compaction with [truncated] sentinel
 *
 * Uses localStorage to persist cancellation intent across reloads:
 * - Before interrupt, store messageId in localStorage
 * - handleCompactionAbort checks localStorage and verifies messageId matches
 * - Reload-safe: localStorage persists, messageId ensures freshness
 */

import type { StreamingMessageAggregator } from "@/browser/utils/messages/StreamingMessageAggregator";
import { getCancelledCompactionKey } from "@/common/constants/storage";

/**
 * Check if the workspace is currently in a compaction stream
 */
export function isCompactingStream(aggregator: StreamingMessageAggregator): boolean {
  const messages = aggregator.getAllMessages();
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  return lastUserMsg?.metadata?.muxMetadata?.type === "compaction-request";
}

/**
 * Find the compaction-request user message in message history
 */
export function findCompactionRequestMessage(
  aggregator: StreamingMessageAggregator
): ReturnType<typeof aggregator.getAllMessages>[number] | null {
  const messages = aggregator.getAllMessages();
  return (
    [...messages]
      .reverse()
      .find((m) => m.role === "user" && m.metadata?.muxMetadata?.type === "compaction-request") ??
    null
  );
}

/**
 * Get the original /compact command from the last user message
 */
export function getCompactionCommand(aggregator: StreamingMessageAggregator): string | null {
  const compactionMsg = findCompactionRequestMessage(aggregator);
  if (!compactionMsg) return null;

  const muxMeta = compactionMsg.metadata?.muxMetadata;
  if (muxMeta?.type !== "compaction-request") return null;

  return muxMeta.rawCommand ?? null;
}

/**
 * Cancel compaction (Ctrl+C flow)
 *
 * Aborts the compaction stream and puts user in edit mode for compaction-request:
 * - Interrupts stream with abandonPartial flag (deletes partial, doesn't commit)
 * - Skips compaction (via localStorage marker checked by handleCompactionAbort)
 * - Enters edit mode on compaction-request message
 * - Restores original /compact command to input for re-editing
 * - Leaves compaction-request message in history (can edit or delete it)
 *
 * Flow:
 * 1. Store cancellation marker in localStorage with compactionRequestId for verification
 * 2. Interrupt stream with {abandonPartial: true} - backend deletes partial
 * 3. handleCompactionAbort checks localStorage, verifies compactionRequestId, skips compaction
 * 4. Enter edit mode on compaction-request message with original command
 *
 * Reload-safe: localStorage persists across reloads, compactionRequestId ensures freshness
 */
export async function cancelCompaction(
  workspaceId: string,
  aggregator: StreamingMessageAggregator,
  startEditingMessage: (messageId: string, initialText: string) => void
): Promise<boolean> {
  // Find the compaction request message
  const compactionRequestMsg = findCompactionRequestMessage(aggregator);
  if (!compactionRequestMsg) {
    return false;
  }

  // Extract command before modifying history
  const command = getCompactionCommand(aggregator);
  if (!command) {
    return false;
  }

  // CRITICAL: Store cancellation marker in localStorage BEFORE interrupt
  // Use the compaction-request user message ID (stable across retries)
  // This persists across reloads and verifies we're cancelling the right compaction
  const storageKey = getCancelledCompactionKey(workspaceId);
  localStorage.setItem(
    storageKey,
    JSON.stringify({
      compactionRequestId: compactionRequestMsg.id,
      timestamp: Date.now(),
    })
  );

  // Interrupt stream with abandonPartial flag
  // This tells backend to DELETE the partial instead of committing it
  // Result: history ends with the compaction-request user message (which is fine - just a user message)
  await window.api.workspace.interruptStream(workspaceId, { abandonPartial: true });

  // Enter edit mode on the compaction-request message with original command
  // This lets user immediately edit the message or delete it
  startEditingMessage(compactionRequestMsg.id, command);

  return true;
}
