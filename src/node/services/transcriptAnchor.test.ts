import { describe, expect, test } from "bun:test";
import { snapshotTranscriptAnchor } from "./transcriptAnchor";

describe("snapshotTranscriptAnchor", () => {
  test("captures merged text and reasoning offsets with canonical part indexes", () => {
    expect(
      snapshotTranscriptAnchor({
        messageId: "assistant-1",
        historySequence: 7,
        parts: [
          { type: "reasoning", text: "reason" },
          { type: "reasoning", text: "ing" },
          { type: "text", text: "answer" },
          { type: "text", text: " text" },
        ],
      })
    ).toEqual({
      messageId: "assistant-1",
      historySequence: 7,
      textLength: 11,
      reasoningLength: 9,
      partIndex: 2,
    });
  });

  test("returns undefined without an active stream", () => {
    expect(snapshotTranscriptAnchor(undefined)).toBeUndefined();
  });
});
