import { describe, it, expect } from "@jest/globals";
import { mergeConsecutiveStreamErrors, groupConsecutiveBashOutput } from "./messageUtils";
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

describe("groupConsecutiveBashOutput", () => {
  // Helper to create a bash_output tool message
  function createBashOutputMessage(
    id: string,
    processId: string,
    historySequence: number
  ): DisplayedMessage {
    return {
      type: "tool",
      id,
      historyId: `h-${id}`,
      toolCallId: `tc-${id}`,
      toolName: "bash_output",
      args: { process_id: processId, timeout_secs: 0 },
      result: { success: true, status: "running", output: `output-${id}` },
      status: "completed",
      isPartial: false,
      historySequence,
    };
  }

  it("returns empty array for empty input", () => {
    const result = groupConsecutiveBashOutput([]);
    expect(result).toEqual([]);
  });

  it("leaves non-bash_output messages unchanged", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "user",
        id: "1",
        historyId: "h1",
        content: "test",
        historySequence: 1,
      },
      {
        type: "tool",
        id: "2",
        historyId: "h2",
        toolCallId: "tc2",
        toolName: "file_read",
        args: { filePath: "/test" },
        status: "completed",
        isPartial: false,
        historySequence: 2,
      },
    ];

    const result = groupConsecutiveBashOutput(messages);
    expect(result).toEqual(messages);
  });

  it("does not group 1-2 consecutive bash_output calls", () => {
    const messages: DisplayedMessage[] = [
      createBashOutputMessage("1", "bash_1", 1),
      createBashOutputMessage("2", "bash_1", 2),
    ];

    const result = groupConsecutiveBashOutput(messages);
    expect(result).toHaveLength(2);
    expect(result[0]).not.toHaveProperty("bashOutputGroup");
    expect(result[1]).not.toHaveProperty("bashOutputGroup");
  });

  it("groups 3+ consecutive bash_output calls to same process", () => {
    const messages: DisplayedMessage[] = [
      createBashOutputMessage("1", "bash_1", 1),
      createBashOutputMessage("2", "bash_1", 2),
      createBashOutputMessage("3", "bash_1", 3),
      createBashOutputMessage("4", "bash_1", 4),
    ];

    const result = groupConsecutiveBashOutput(messages);

    // Should collapse to: first, middle (collapsed), last
    expect(result).toHaveLength(3);

    // First
    expect(result[0].id).toBe("1");
    expect(result[0].bashOutputGroup).toMatchObject({
      position: "first",
      totalCount: 4,
      collapsedCount: 2,
    });

    // Middle (collapsed indicator)
    expect(result[1].bashOutputGroup).toMatchObject({
      position: "middle",
      totalCount: 4,
      collapsedCount: 2,
    });

    // Last
    expect(result[2].id).toBe("4");
    expect(result[2].bashOutputGroup).toMatchObject({
      position: "last",
      totalCount: 4,
      collapsedCount: 2,
    });
  });

  it("does not group bash_output calls to different processes", () => {
    const messages: DisplayedMessage[] = [
      createBashOutputMessage("1", "bash_1", 1),
      createBashOutputMessage("2", "bash_1", 2),
      createBashOutputMessage("3", "bash_2", 3), // Different process
      createBashOutputMessage("4", "bash_1", 4),
    ];

    const result = groupConsecutiveBashOutput(messages);

    // No grouping should occur (max consecutive same-process is 2)
    expect(result).toHaveLength(4);
    expect(result[0]).not.toHaveProperty("bashOutputGroup");
  });

  it("handles multiple separate groups", () => {
    const messages: DisplayedMessage[] = [
      createBashOutputMessage("1", "bash_1", 1),
      createBashOutputMessage("2", "bash_1", 2),
      createBashOutputMessage("3", "bash_1", 3),
      {
        type: "user",
        id: "u1",
        historyId: "hu1",
        content: "check other",
        historySequence: 4,
      },
      createBashOutputMessage("4", "bash_2", 5),
      createBashOutputMessage("5", "bash_2", 6),
      createBashOutputMessage("6", "bash_2", 7),
    ];

    const result = groupConsecutiveBashOutput(messages);

    // First group (3 items -> 3 output), user message, second group (3 items -> 3 output)
    expect(result).toHaveLength(7);

    // First group
    expect(result[0].bashOutputGroup?.position).toBe("first");
    expect(result[1].bashOutputGroup?.position).toBe("middle");
    expect(result[2].bashOutputGroup?.position).toBe("last");

    // User message (unchanged)
    expect(result[3].type).toBe("user");

    // Second group
    expect(result[4].bashOutputGroup?.position).toBe("first");
    expect(result[5].bashOutputGroup?.position).toBe("middle");
    expect(result[6].bashOutputGroup?.position).toBe("last");
  });

  it("preserves message properties when grouping", () => {
    const messages: DisplayedMessage[] = [
      createBashOutputMessage("1", "bash_1", 1),
      createBashOutputMessage("2", "bash_1", 2),
      createBashOutputMessage("3", "bash_1", 3),
    ];

    const result = groupConsecutiveBashOutput(messages);

    // First message should preserve all original properties
    expect(result[0]).toMatchObject({
      type: "tool",
      id: "1",
      historyId: "h-1",
      toolCallId: "tc-1",
      toolName: "bash_output",
      args: { process_id: "bash_1", timeout_secs: 0 },
    });

    // Last message should preserve all original properties
    expect(result[2]).toMatchObject({
      type: "tool",
      id: "3",
      historyId: "h-3",
      toolCallId: "tc-3",
      toolName: "bash_output",
    });
  });

  it("handles exactly 3 consecutive calls (minimum for grouping)", () => {
    const messages: DisplayedMessage[] = [
      createBashOutputMessage("1", "bash_1", 1),
      createBashOutputMessage("2", "bash_1", 2),
      createBashOutputMessage("3", "bash_1", 3),
    ];

    const result = groupConsecutiveBashOutput(messages);

    expect(result).toHaveLength(3);
    expect(result[0].bashOutputGroup?.collapsedCount).toBe(1);
    expect(result[1].bashOutputGroup?.position).toBe("middle");
    expect(result[2].bashOutputGroup?.position).toBe("last");
  });
});
