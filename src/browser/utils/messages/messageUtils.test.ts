import { describe, it, expect } from "@jest/globals";
import { mergeConsecutiveStreamErrors } from "./messageUtils";
import type { DisplayedMessage } from "@/common/types/message";

describe("mergeConsecutiveStreamErrors", () => {
  it("returns empty array for empty input", () => {
    const result = mergeConsecutiveStreamErrors([]);
    expect(result).toEqual([]);
  });

  it("leaves non-error messages unchanged", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "user",
        id: "1",
        historyId: "h1",
        content: "test",
        historySequence: 1,
      },
      {
        type: "assistant",
        id: "2",
        historyId: "h2",
        content: "response",
        historySequence: 2,
        isStreaming: false,
        isPartial: false,
        isCompacted: false,
      },
    ];

    const result = mergeConsecutiveStreamErrors(messages);
    expect(result).toEqual(messages);
  });

  it("merges consecutive identical stream errors", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "stream-error",
        id: "e1",
        historyId: "h1",
        error: "Connection timeout",
        errorType: "network",
        historySequence: 1,
      },
      {
        type: "stream-error",
        id: "e2",
        historyId: "h2",
        error: "Connection timeout",
        errorType: "network",
        historySequence: 2,
      },
      {
        type: "stream-error",
        id: "e3",
        historyId: "h3",
        error: "Connection timeout",
        errorType: "network",
        historySequence: 3,
      },
    ];

    const result = mergeConsecutiveStreamErrors(messages);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "stream-error",
      error: "Connection timeout",
      errorType: "network",
      errorCount: 3,
    });
  });

  it("does not merge errors with different content", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "stream-error",
        id: "e1",
        historyId: "h1",
        error: "Connection timeout",
        errorType: "network",
        historySequence: 1,
      },
      {
        type: "stream-error",
        id: "e2",
        historyId: "h2",
        error: "Rate limit exceeded",
        errorType: "rate_limit",
        historySequence: 2,
      },
    ];

    const result = mergeConsecutiveStreamErrors(messages);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      error: "Connection timeout",
      errorCount: 1,
    });
    expect(result[1]).toMatchObject({
      error: "Rate limit exceeded",
      errorCount: 1,
    });
  });

  it("does not merge errors with different error types", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "stream-error",
        id: "e1",
        historyId: "h1",
        error: "Error occurred",
        errorType: "network",
        historySequence: 1,
      },
      {
        type: "stream-error",
        id: "e2",
        historyId: "h2",
        error: "Error occurred",
        errorType: "rate_limit",
        historySequence: 2,
      },
    ];

    const result = mergeConsecutiveStreamErrors(messages);

    expect(result).toHaveLength(2);
    const first = result[0];
    const second = result[1];
    expect(first.type).toBe("stream-error");
    expect(second.type).toBe("stream-error");
    if (first.type === "stream-error" && second.type === "stream-error") {
      expect(first.errorCount).toBe(1);
      expect(second.errorCount).toBe(1);
    }
  });

  it("creates separate merged groups for non-consecutive identical errors", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "stream-error",
        id: "e1",
        historyId: "h1",
        error: "Connection timeout",
        errorType: "network",
        historySequence: 1,
      },
      {
        type: "stream-error",
        id: "e2",
        historyId: "h2",
        error: "Connection timeout",
        errorType: "network",
        historySequence: 2,
      },
      {
        type: "user",
        id: "u1",
        historyId: "hu1",
        content: "retry",
        historySequence: 3,
      },
      {
        type: "stream-error",
        id: "e3",
        historyId: "h3",
        error: "Connection timeout",
        errorType: "network",
        historySequence: 4,
      },
    ];

    const result = mergeConsecutiveStreamErrors(messages);

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      type: "stream-error",
      errorCount: 2,
    });
    expect(result[1]).toMatchObject({
      type: "user",
    });
    expect(result[2]).toMatchObject({
      type: "stream-error",
      errorCount: 1,
    });
  });

  it("handles mixed messages with error sequences", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "user",
        id: "u1",
        historyId: "hu1",
        content: "test",
        historySequence: 1,
      },
      {
        type: "stream-error",
        id: "e1",
        historyId: "h1",
        error: "Error A",
        errorType: "network",
        historySequence: 2,
      },
      {
        type: "stream-error",
        id: "e2",
        historyId: "h2",
        error: "Error A",
        errorType: "network",
        historySequence: 3,
      },
      {
        type: "assistant",
        id: "a1",
        historyId: "ha1",
        content: "response",
        historySequence: 4,
        isStreaming: false,
        isPartial: false,
        isCompacted: false,
      },
      {
        type: "stream-error",
        id: "e3",
        historyId: "h3",
        error: "Error B",
        errorType: "rate_limit",
        historySequence: 5,
      },
    ];

    const result = mergeConsecutiveStreamErrors(messages);

    expect(result).toHaveLength(4);
    expect(result[0].type).toBe("user");
    expect(result[1]).toMatchObject({
      type: "stream-error",
      error: "Error A",
      errorCount: 2,
    });
    expect(result[2].type).toBe("assistant");
    expect(result[3]).toMatchObject({
      type: "stream-error",
      error: "Error B",
      errorCount: 1,
    });
  });

  it("preserves other message properties when merging", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "stream-error",
        id: "e1",
        historyId: "h1",
        error: "Test error",
        errorType: "network",
        historySequence: 1,
        timestamp: 1234567890,
        model: "test-model",
      },
      {
        type: "stream-error",
        id: "e2",
        historyId: "h2",
        error: "Test error",
        errorType: "network",
        historySequence: 2,
      },
    ];

    const result = mergeConsecutiveStreamErrors(messages);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "e1",
      historyId: "h1",
      error: "Test error",
      errorType: "network",
      historySequence: 1,
      timestamp: 1234567890,
      model: "test-model",
      errorCount: 2,
    });
  });
});
