import type { TranscriptAnchor } from "@/common/types/message";
import type { CompletedMessagePart } from "@/common/types/stream";

interface ActiveTranscriptStream {
  messageId: string;
  historySequence: number;
  parts: readonly CompletedMessagePart[];
}

/** Capture the exact display boundary before awaited work lets the active stream advance. */
export function snapshotTranscriptAnchor(
  liveStream: ActiveTranscriptStream | undefined
): TranscriptAnchor | undefined {
  if (!liveStream) {
    return undefined;
  }

  let textLength = 0;
  let reasoningLength = 0;
  let partIndex = 0;
  let previousContentType: "text" | "reasoning" | undefined;
  for (const part of liveStream.parts) {
    if (part.type === "text") {
      textLength += part.text.length;
      if (previousContentType !== "text") {
        partIndex++;
      }
      previousContentType = "text";
    } else if (part.type === "reasoning") {
      reasoningLength += part.text.length;
      if (previousContentType !== "reasoning") {
        partIndex++;
      }
      previousContentType = "reasoning";
    } else {
      // The renderer merges adjacent content deltas, but tool parts remain standalone.
      partIndex++;
      previousContentType = undefined;
    }
  }

  return {
    messageId: liveStream.messageId,
    historySequence: liveStream.historySequence,
    textLength,
    reasoningLength,
    partIndex,
  };
}
