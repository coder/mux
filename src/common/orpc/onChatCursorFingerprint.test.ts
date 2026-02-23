import { describe, expect, test } from "bun:test";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { computePriorHistoryFingerprint } from "./onChatCursorFingerprint";

function withHistoryMetadata(
  message: MuxMessage,
  historySequence: number,
  timestamp: number
): MuxMessage {
  return {
    ...message,
    metadata: {
      ...message.metadata,
      historySequence,
      timestamp,
    },
  };
}

describe("computePriorHistoryFingerprint", () => {
  test("returns undefined when no rows exist below the anchor", () => {
    const anchorOnly = withHistoryMetadata(
      createMuxMessage("msg-anchor", "assistant", "anchor"),
      1,
      1_000
    );

    expect(computePriorHistoryFingerprint([anchorOnly], 1)).toBeUndefined();
  });

  test("changes when a lower-sequence row is rewritten with new content", () => {
    const originalRow = withHistoryMetadata(
      createMuxMessage("msg-rewritten", "assistant", "original"),
      1,
      1_001
    );
    const anchorRow = withHistoryMetadata(
      createMuxMessage("msg-anchor", "assistant", "anchor"),
      2,
      1_002
    );

    const originalFingerprint = computePriorHistoryFingerprint([originalRow, anchorRow], 2);

    const rewrittenRow = withHistoryMetadata(
      createMuxMessage("msg-rewritten", "assistant", "rewritten"),
      1,
      1_001
    );
    const rewrittenFingerprint = computePriorHistoryFingerprint([rewrittenRow, anchorRow], 2);

    expect(originalFingerprint).toBeDefined();
    expect(rewrittenFingerprint).toBeDefined();
    expect(rewrittenFingerprint).not.toBe(originalFingerprint);
  });
});
