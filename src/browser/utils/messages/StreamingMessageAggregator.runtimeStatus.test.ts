import { describe, test, expect } from "bun:test";

import { StreamingMessageAggregator } from "./StreamingMessageAggregator";

const TEST_CREATED_AT = "2024-01-01T00:00:00.000Z";

describe("StreamingMessageAggregator runtime-status", () => {
  test("handleRuntimeStatus sets status for non-terminal phases and clears on ready/error", () => {
    const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

    expect(aggregator.getRuntimeStatus()).toBeNull();

    aggregator.handleRuntimeStatus({
      type: "runtime-status",
      workspaceId: "ws-1",
      phase: "starting",
      runtimeType: "ssh",
      detail: "Starting workspace...",
    });

    expect(aggregator.getRuntimeStatus()?.phase).toBe("starting");

    aggregator.handleRuntimeStatus({
      type: "runtime-status",
      workspaceId: "ws-1",
      phase: "ready",
      runtimeType: "ssh",
    });

    expect(aggregator.getRuntimeStatus()).toBeNull();

    aggregator.handleRuntimeStatus({
      type: "runtime-status",
      workspaceId: "ws-1",
      phase: "waiting",
      runtimeType: "ssh",
    });

    expect(aggregator.getRuntimeStatus()?.phase).toBe("waiting");

    aggregator.handleRuntimeStatus({
      type: "runtime-status",
      workspaceId: "ws-1",
      phase: "error",
      runtimeType: "ssh",
      detail: "boom",
    });

    expect(aggregator.getRuntimeStatus()).toBeNull();
  });

  test("stream-start clears runtimeStatus", () => {
    const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

    aggregator.handleRuntimeStatus({
      type: "runtime-status",
      workspaceId: "ws-1",
      phase: "starting",
      runtimeType: "ssh",
    });

    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId: "ws-1",
      messageId: "msg-1",
      historySequence: 1,
      model: "test-model",
      startTime: 0,
    });

    expect(aggregator.getRuntimeStatus()).toBeNull();
  });

  test("stream-abort clears runtimeStatus", () => {
    const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

    aggregator.handleRuntimeStatus({
      type: "runtime-status",
      workspaceId: "ws-1",
      phase: "starting",
      runtimeType: "ssh",
    });

    aggregator.handleStreamAbort({
      type: "stream-abort",
      workspaceId: "ws-1",
      messageId: "msg-1",
      metadata: {},
    });

    expect(aggregator.getRuntimeStatus()).toBeNull();
  });

  test("stream-error clears runtimeStatus", () => {
    const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

    aggregator.handleRuntimeStatus({
      type: "runtime-status",
      workspaceId: "ws-1",
      phase: "starting",
      runtimeType: "ssh",
    });

    aggregator.handleStreamError({
      type: "stream-error",
      messageId: "msg-1",
      error: "boom",
      errorType: "runtime_start_failed",
    });

    expect(aggregator.getRuntimeStatus()).toBeNull();
  });
});
