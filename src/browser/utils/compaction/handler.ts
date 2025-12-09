/**
 * Compaction interrupt handling
 *
 * Ctrl+C (cancel): Abort compaction, enters edit mode on compaction-request message
 * with original /compact command restored for re-editing.
 */

import type { StreamingMessageAggregator } from "@/browser/utils/messages/StreamingMessageAggregator";
import type { APIClient } from "@/browser/contexts/API";

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
 * - Interrupts stream with abandonPartial=true flag (backend skips compaction)
 * - Enters edit mode on compaction-request message
 * - Restores original /compact command to input for re-editing
 * - Leaves compaction-request message in history (can edit or delete it)
 *
 * Flow:
 * 1. Interrupt stream with {abandonPartial: true} - backend detects and skips compaction
 * 2. Enter edit mode on compaction-request message with original command
 */
export async function cancelCompaction(
  client: APIClient,
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

  // Interrupt stream with abandonPartial flag
  // Backend detects this and skips compaction (Ctrl+C flow)
  await client.workspace.interruptStream({ workspaceId, options: { abandonPartial: true } });

  // Enter edit mode on the compaction-request message with original command
  // This lets user immediately edit the message or delete it
  startEditingMessage(compactionRequestMsg.id, command);

  return true;
}
