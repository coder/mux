import { describe, expect, it } from "bun:test";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { createUpdateMappingState, mapWorkspaceChatEventToAcp } from "./updates";

const WORKSPACE_ID = "workspace-1";
const MESSAGE_ID = "message-1";
const STALE_MESSAGE_ID = "message-stale";
const TIMESTAMP = 1_739_793_600_000;

function streamStartEvent(messageId = MESSAGE_ID): WorkspaceChatMessage {
  return {
    type: "stream-start",
    workspaceId: WORKSPACE_ID,
    messageId,
    model: "openai:gpt-5.2",
    historySequence: 1,
    startTime: TIMESTAMP,
  };
}

function streamDeltaEvent(delta: string, messageId = MESSAGE_ID): WorkspaceChatMessage {
  return {
    type: "stream-delta",
    workspaceId: WORKSPACE_ID,
    messageId,
    delta,
    tokens: 1,
    timestamp: TIMESTAMP,
  };
}

function reasoningDeltaEvent(delta: string, messageId = MESSAGE_ID): WorkspaceChatMessage {
  return {
    type: "reasoning-delta",
    workspaceId: WORKSPACE_ID,
    messageId,
    delta,
    tokens: 1,
    timestamp: TIMESTAMP,
  };
}

function toolCallStartEvent(messageId = MESSAGE_ID): WorkspaceChatMessage {
  return {
    type: "tool-call-start",
    workspaceId: WORKSPACE_ID,
    messageId,
    toolCallId: "tool-1",
    toolName: "bash",
    args: { command: "echo hello" },
    tokens: 3,
    timestamp: TIMESTAMP,
  };
}

function toolCallEndEvent(messageId = MESSAGE_ID): WorkspaceChatMessage {
  return {
    type: "tool-call-end",
    workspaceId: WORKSPACE_ID,
    messageId,
    toolCallId: "tool-1",
    toolName: "bash",
    result: "command output",
    timestamp: TIMESTAMP,
  };
}

function streamEndEvent(messageId = MESSAGE_ID): WorkspaceChatMessage {
  return {
    type: "stream-end",
    workspaceId: WORKSPACE_ID,
    messageId,
    metadata: {
      model: "openai:gpt-5.2",
    },
    parts: [],
  };
}

function streamAbortEvent(
  abortReason: "user" | "startup" | "system",
  messageId = MESSAGE_ID
): WorkspaceChatMessage {
  return {
    type: "stream-abort",
    workspaceId: WORKSPACE_ID,
    messageId,
    abortReason,
  };
}

function streamErrorEvent(messageId = MESSAGE_ID, error = "stream failure"): WorkspaceChatMessage {
  return {
    type: "stream-error",
    messageId,
    error,
    errorType: "unknown",
  };
}

function usageDeltaEvent(messageId = MESSAGE_ID): WorkspaceChatMessage {
  return {
    type: "usage-delta",
    workspaceId: WORKSPACE_ID,
    messageId,
    usage: {
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
    },
    cumulativeUsage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: undefined,
      reasoningTokens: 2,
      cachedInputTokens: 1,
    },
  };
}

describe("mapWorkspaceChatEventToAcp", () => {
  it("stream-start initializes activeMessageId", () => {
    const state = createUpdateMappingState();

    const mapped = mapWorkspaceChatEventToAcp(streamStartEvent(), state, false);

    expect(mapped).toEqual({ kind: "ignore" });
    expect(state.activeMessageId).toBe(MESSAGE_ID);
  });

  it("maps stream-delta to agent_message_chunk", () => {
    const state = createUpdateMappingState();
    state.activeMessageId = MESSAGE_ID;

    const mapped = mapWorkspaceChatEventToAcp(streamDeltaEvent("hello"), state, false);

    expect(mapped).toEqual({
      kind: "update",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "hello",
        },
      },
    });
    expect(state.activeMessageId).toBe(MESSAGE_ID);
  });

  it("ignores stale stream-delta when activeMessageId is null", () => {
    const state = createUpdateMappingState();

    const mapped = mapWorkspaceChatEventToAcp(
      streamDeltaEvent("stale delta", STALE_MESSAGE_ID),
      state,
      false
    );

    expect(mapped).toEqual({ kind: "ignore" });
    expect(state.activeMessageId).toBeNull();
  });

  it("maps reasoning-delta to agent_thought_chunk", () => {
    const state = createUpdateMappingState();
    state.activeMessageId = MESSAGE_ID;

    const mapped = mapWorkspaceChatEventToAcp(reasoningDeltaEvent("thinking"), state, false);

    expect(mapped).toEqual({
      kind: "update",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: {
          type: "text",
          text: "thinking",
        },
      },
    });
  });

  it("maps tool-call-start to tool_call", () => {
    const state = createUpdateMappingState();
    state.activeMessageId = MESSAGE_ID;

    const mapped = mapWorkspaceChatEventToAcp(toolCallStartEvent(), state, false);

    expect(mapped).toEqual({
      kind: "update",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "bash",
        status: "in_progress",
        rawInput: {
          command: "echo hello",
        },
      },
    });
  });

  it("maps tool-call-end to completed tool_call_update", () => {
    const state = createUpdateMappingState();
    state.activeMessageId = MESSAGE_ID;

    const mapped = mapWorkspaceChatEventToAcp(toolCallEndEvent(), state, false);

    expect(mapped).toEqual({
      kind: "update",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: "command output",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "command output",
            },
          },
        ],
      },
    });
  });

  it("maps stream-end to an end_turn stop and clears active message", () => {
    const state = createUpdateMappingState();
    state.activeMessageId = MESSAGE_ID;

    const mapped = mapWorkspaceChatEventToAcp(streamEndEvent(), state, false);

    expect(mapped).toEqual({
      kind: "stop",
      stopReason: "end_turn",
    });
    expect(state.activeMessageId).toBeNull();
  });

  it("ignores stale stream-end when activeMessageId is null", () => {
    const state = createUpdateMappingState();

    const mapped = mapWorkspaceChatEventToAcp(streamEndEvent(STALE_MESSAGE_ID), state, false);

    expect(mapped).toEqual({ kind: "ignore" });
    expect(state.activeMessageId).toBeNull();
  });

  it("maps stream-abort from user to cancelled", () => {
    const state = createUpdateMappingState();
    state.activeMessageId = MESSAGE_ID;

    const mapped = mapWorkspaceChatEventToAcp(streamAbortEvent("user"), state, false);

    expect(mapped).toEqual({
      kind: "stop",
      stopReason: "cancelled",
    });
    expect(state.activeMessageId).toBeNull();
  });

  it("maps stream-abort from non-user causes to end_turn", () => {
    const state = createUpdateMappingState();
    state.activeMessageId = MESSAGE_ID;

    const mapped = mapWorkspaceChatEventToAcp(streamAbortEvent("system"), state, false);

    expect(mapped).toEqual({
      kind: "stop",
      stopReason: "end_turn",
    });
    expect(state.activeMessageId).toBeNull();
  });

  it("ignores stale stream-abort when activeMessageId is null", () => {
    const state = createUpdateMappingState();

    const mapped = mapWorkspaceChatEventToAcp(
      streamAbortEvent("system", STALE_MESSAGE_ID),
      state,
      false
    );

    expect(mapped).toEqual({ kind: "ignore" });
    expect(state.activeMessageId).toBeNull();
  });

  it("maps stream-error to an error when it matches the active message", () => {
    const state = createUpdateMappingState();
    state.activeMessageId = MESSAGE_ID;

    const mapped = mapWorkspaceChatEventToAcp(streamErrorEvent(MESSAGE_ID, "boom"), state, false);

    expect(mapped).toEqual({
      kind: "error",
      error: new Error("boom"),
    });
    expect(state.activeMessageId).toBe(MESSAGE_ID);
  });

  it("surfaces stream-error before stream-start when activeMessageId is null", () => {
    const state = createUpdateMappingState();

    const mapped = mapWorkspaceChatEventToAcp(
      streamErrorEvent(STALE_MESSAGE_ID, "startup failed"),
      state,
      false
    );

    expect(mapped).toEqual({
      kind: "error",
      error: new Error("startup failed"),
    });
    expect(state.activeMessageId).toBeNull();
  });

  it("ignores stale stream-error from a previous stream while one is active", () => {
    const state = createUpdateMappingState();
    state.activeMessageId = MESSAGE_ID;

    const mapped = mapWorkspaceChatEventToAcp(
      streamErrorEvent(STALE_MESSAGE_ID, "old stream failure"),
      state,
      false
    );

    expect(mapped).toEqual({ kind: "ignore" });
    expect(state.activeMessageId).toBe(MESSAGE_ID);
  });

  it("ignores heartbeat and caught-up events", () => {
    const state = createUpdateMappingState();

    const heartbeat = mapWorkspaceChatEventToAcp({ type: "heartbeat" }, state, false);
    const caughtUp = mapWorkspaceChatEventToAcp({ type: "caught-up" }, state, false);

    expect(heartbeat).toEqual({ kind: "ignore" });
    expect(caughtUp).toEqual({ kind: "ignore" });
  });

  it("maps usage-delta to usage_update only when unstable mode is enabled", () => {
    const state = createUpdateMappingState();
    state.activeMessageId = MESSAGE_ID;

    const mappedEnabled = mapWorkspaceChatEventToAcp(usageDeltaEvent(), state, true);
    expect(mappedEnabled).toEqual({
      kind: "update",
      update: {
        sessionUpdate: "usage_update",
        used: 15,
        size: 15,
      },
    });

    const mappedDisabled = mapWorkspaceChatEventToAcp(usageDeltaEvent(), state, false);
    expect(mappedDisabled).toEqual({ kind: "ignore" });
  });
});
