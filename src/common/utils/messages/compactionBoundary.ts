import assert from "node:assert";

import type { MuxMessage } from "@/common/types/message";

/**
 * Locate the latest durable compaction boundary in reverse chronological order.
 *
 * Returns the index of the newest message tagged with `metadata.compactionBoundary === true`,
 * or `-1` when no durable boundary exists in the provided history.
 */
export function findLatestCompactionBoundaryIndex(messages: MuxMessage[]): number {
  assert(Array.isArray(messages), "findLatestCompactionBoundaryIndex requires a message array");

  // TODO(Approach B): Consider persisting a sidecar compaction index so provider-request
  // slicing can skip reverse-scanning chat history on every request.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (candidate?.metadata?.compactionBoundary !== true) {
      continue;
    }

    assert(
      candidate.metadata.compacted !== undefined && candidate.metadata.compacted !== false,
      "compactionBoundary markers must be attached to compacted summary messages"
    );

    const epoch = candidate.metadata.compactionEpoch;
    if (epoch !== undefined) {
      assert(
        Number.isInteger(epoch) && epoch > 0,
        "compactionBoundary markers must use positive integer compactionEpoch values"
      );
    }

    return i;
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
    sliced[0]?.metadata?.compactionBoundary === true,
    "compaction boundary slicing must start on a compaction boundary message"
  );

  return sliced;
}
