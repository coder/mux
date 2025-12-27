import { describe, expect, test } from "bun:test";

import type { DeleteMessage, StreamErrorMessage, WorkspaceChatMessage } from "@/common/orpc/types";
import type {
  ReasoningDeltaEvent,
  ReasoningEndEvent,
  StreamAbortEvent,
  StreamDeltaEvent,
  StreamEndEvent,
  StreamStartEvent,
  ToolCallDeltaEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
  UsageDeltaEvent,
} from "@/common/types/stream";

import {
  applyWorkspaceChatEventToAggregator,
  type WorkspaceChatEventAggregator,
} from "./applyWorkspaceChatEventToAggregator";

class StubAggregator implements WorkspaceChatEventAggregator {
  readonly calls: string[] = [];

  handleStreamStart(data: StreamStartEvent): void {
    this.calls.push(`handleStreamStart:${data.messageId}`);
  }

  handleStreamDelta(data: StreamDeltaEvent): void {
    this.calls.push(`handleStreamDelta:${data.messageId}`);
  }

  handleStreamEnd(data: StreamEndEvent): void {
    this.calls.push(`handleStreamEnd:${data.messageId}`);
  }

  handleStreamAbort(data: StreamAbortEvent): void {
    this.calls.push(`handleStreamAbort:${data.messageId}`);
  }

  handleStreamError(data: StreamErrorMessage): void {
    this.calls.push(`handleStreamError:${data.messageId}`);
  }

  handleToolCallStart(data: ToolCallStartEvent): void {
    this.calls.push(`handleToolCallStart:${data.toolCallId}`);
  }

  handleToolCallDelta(data: ToolCallDeltaEvent): void {
    this.calls.push(`handleToolCallDelta:${data.toolCallId}`);
  }

  handleToolCallEnd(data: ToolCallEndEvent): void {
    this.calls.push(`handleToolCallEnd:${data.toolCallId}`);
  }

  handleReasoningDelta(data: ReasoningDeltaEvent): void {
    this.calls.push(`handleReasoningDelta:${data.messageId}`);
  }

  handleReasoningEnd(data: ReasoningEndEvent): void {
    this.calls.push(`handleReasoningEnd:${data.messageId}`);
  }

  handleUsageDelta(data: UsageDeltaEvent): void {
    this.calls.push(`handleUsageDelta:${data.messageId}`);
  }

  handleDeleteMessage(data: DeleteMessage): void {
    this.calls.push(`handleDeleteMessage:${data.historySequences.join(",")}`);
  }

  handleMessage(data: WorkspaceChatMessage): void {
    this.calls.push(`handleMessage:${data.type}`);
  }

  clearTokenState(messageId: string): void {
    this.calls.push(`clearTokenState:${messageId}`);
  }
}

describe("applyWorkspaceChatEventToAggregator", () => {
  test("stream-start routes to handleStreamStart", () => {
    const aggregator = new StubAggregator();

    const event: WorkspaceChatMessage = {
      type: "stream-start",
      workspaceId: "ws-1",
      messageId: "msg-1",
      historySequence: 1,
      model: "test-model",
      startTime: 0,
    };

    const hint = applyWorkspaceChatEventToAggregator(aggregator, event);

    expect(hint).toBe("immediate");
    expect(aggregator.calls).toEqual(["handleStreamStart:msg-1"]);
  });

  test("stream-delta routes to handleStreamDelta and is throttled", () => {
    const aggregator = new StubAggregator();

    const event: WorkspaceChatMessage = {
      type: "stream-delta",
      workspaceId: "ws-1",
      messageId: "msg-1",
      delta: "hi",
      tokens: 1,
      timestamp: 1,
    };

    const hint = applyWorkspaceChatEventToAggregator(aggregator, event);

    expect(hint).toBe("throttled");
    expect(aggregator.calls).toEqual(["handleStreamDelta:msg-1"]);
  });

  test("stream-end routes to handleStreamEnd and clears token state", () => {
    const aggregator = new StubAggregator();

    const event: WorkspaceChatMessage = {
      type: "stream-end",
      workspaceId: "ws-1",
      messageId: "msg-1",
      metadata: { model: "test-model" },
      parts: [],
    };

    const hint = applyWorkspaceChatEventToAggregator(aggregator, event);

    expect(hint).toBe("immediate");
    expect(aggregator.calls).toEqual(["handleStreamEnd:msg-1", "clearTokenState:msg-1"]);
  });

  test("stream-abort clears token state before calling handleStreamAbort", () => {
    const aggregator = new StubAggregator();

    const event: WorkspaceChatMessage = {
      type: "stream-abort",
      workspaceId: "ws-1",
      messageId: "msg-1",
      metadata: {},
    };

    const hint = applyWorkspaceChatEventToAggregator(aggregator, event);

    expect(hint).toBe("immediate");
    expect(aggregator.calls).toEqual(["clearTokenState:msg-1", "handleStreamAbort:msg-1"]);
  });

  test("tool-call-delta routes to handleToolCallDelta and is throttled", () => {
    const aggregator = new StubAggregator();

    const event: WorkspaceChatMessage = {
      type: "tool-call-delta",
      workspaceId: "ws-1",
      messageId: "msg-1",
      toolCallId: "tool-1",
      toolName: "bash",
      delta: { chunk: "..." },
      tokens: 1,
      timestamp: 1,
    };

    const hint = applyWorkspaceChatEventToAggregator(aggregator, event);

    expect(hint).toBe("throttled");
    expect(aggregator.calls).toEqual(["handleToolCallDelta:tool-1"]);
  });

  test("message routes to handleMessage", () => {
    const aggregator = new StubAggregator();

    const event: WorkspaceChatMessage = {
      type: "message",
      id: "msg-1",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
      metadata: { historySequence: 1, timestamp: 0 },
    };

    const hint = applyWorkspaceChatEventToAggregator(aggregator, event);

    expect(hint).toBe("immediate");
    expect(aggregator.calls).toEqual(["handleMessage:message"]);
  });

  test("queued-message-changed is ignored", () => {
    const aggregator = new StubAggregator();

    const event: WorkspaceChatMessage = {
      type: "queued-message-changed",
      workspaceId: "ws-1",
      queuedMessages: ["a"],
      displayText: "queued",
    };

    const hint = applyWorkspaceChatEventToAggregator(aggregator, event);

    expect(hint).toBe("ignored");
    expect(aggregator.calls).toEqual([]);
  });

  test("unsupported event types are ignored (forward-compatible)", () => {
    const aggregator = new StubAggregator();

    const event: WorkspaceChatMessage = {
      type: "error",
      workspaceId: "ws-1",
      messageId: "msg-1",
      error: "boom",
      errorType: "unknown",
    };

    const hint = applyWorkspaceChatEventToAggregator(aggregator, event);

    expect(hint).toBe("ignored");
    expect(aggregator.calls).toEqual([]);
  });

  test("throws when aggregator is missing", () => {
    const event: WorkspaceChatMessage = {
      type: "caught-up",
    };

    expect(() =>
      applyWorkspaceChatEventToAggregator(null as unknown as WorkspaceChatEventAggregator, event)
    ).toThrow();
  });
});
