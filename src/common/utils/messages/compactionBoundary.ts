import assert from "node:assert";

import type { MuxMessage } from "@/common/types/message";

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isDurableCompactionBoundaryMarker(message: MuxMessage | undefined): boolean {
  if (message?.metadata?.compactionBoundary !== true) {
    return false;
  }

  // Self-healing read path: malformed persisted boundary metadata should be ignored,
  // not crash request assembly.
  if (message.metadata.compacted === undefined || message.metadata.compacted === false) {
    return false;
  }

  const epoch = message.metadata.compactionEpoch;
  if (!isPositiveInteger(epoch)) {
    return false;
  }

  return true;
}

/**
 * Locate the latest durable compaction boundary in reverse chronological order.
 *
 * Returns the index of the newest message tagged with valid boundary metadata,
 * or `-1` when no durable boundary exists in the provided history.
 */
export function findLatestCompactionBoundaryIndex(messages: MuxMessage[]): number {
  assert(Array.isArray(messages), "findLatestCompactionBoundaryIndex requires a message array");

  // TODO(Approach B): Consider persisting a sidecar compaction index so provider-request
  // slicing can skip reverse-scanning chat history on every request.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isDurableCompactionBoundaryMarker(messages[i])) {
      return i;
    }
  }

  return -1;
}

/**
 * Slice request payload history from the latest compaction boundary (inclusive).
 *
 * This is request-only and must not be used to mutate persisted replay history.
 */
export function sliceMessagesFromLatestCompactionBoundary(messages: MuxMessage[]): MuxMessage[] {
  const boundaryIndex = findLatestCompactionBoundaryIndex(messages);
  if (boundaryIndex === -1) {
    return messages;
  }

  assert(
    boundaryIndex >= 0 && boundaryIndex < messages.length,
    "compaction boundary index must be within message history bounds"
  );

  const sliced = messages.slice(boundaryIndex);
  assert(sliced.length > 0, "compaction boundary slicing must retain at least one message");
  assert(
    isDurableCompactionBoundaryMarker(sliced[0]),
    "compaction boundary slicing must start on a durable compaction boundary message"
  );

  return sliced;
}
