import { describe, test, expect } from "bun:test";

import { StreamingMessageAggregator } from "./StreamingMessageAggregator";

const TEST_CREATED_AT = "2024-01-01T00:00:00.000Z";

const createAggregator = () => new StreamingMessageAggregator(TEST_CREATED_AT);

const seedRuntimeStatus = (aggregator: StreamingMessageAggregator) => {
  aggregator.handleRuntimeStatus({
    type: "runtime-status",
    workspaceId: "ws-1",
    phase: "starting",
    runtimeType: "ssh",
  });
};

const runtimeStatusClearers = [
  {
    name: "stream-start",
    clear: (aggregator: StreamingMessageAggregator) => {
      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "ws-1",
        messageId: "msg-1",
        historySequence: 1,
        model: "test-model",
        startTime: 0,
      });
    },
  },
  {
    name: "stream-abort",
    clear: (aggregator: StreamingMessageAggregator) => {
      aggregator.handleStreamAbort({
        type: "stream-abort",
        workspaceId: "ws-1",
        messageId: "msg-1",
        metadata: {},
      });
    },
  },
  {
    name: "stream-error",
    clear: (aggregator: StreamingMessageAggregator) => {
      aggregator.handleStreamError({
        type: "stream-error",
        messageId: "msg-1",
        error: "boom",
        errorType: "runtime_start_failed",
      });
    },
  },
] as const;

describe("StreamingMessageAggregator runtime-status", () => {
  test("handleRuntimeStatus sets status for non-terminal phases and clears on ready/error", () => {
    const aggregator = createAggregator();

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

  for (const { name, clear } of runtimeStatusClearers) {
    test(`${name} clears runtimeStatus`, () => {
      const aggregator = createAggregator();
      seedRuntimeStatus(aggregator);

      clear(aggregator);

      expect(aggregator.getRuntimeStatus()).toBeNull();
    });
  }
});
