import { describe, expect, spyOn, test } from "bun:test";

import { Ok } from "@/common/types/result";
import { createAgentSessionHarness } from "./agentSession.testHarness";

const TEST_MODEL = "anthropic:claude-sonnet-4-5";

function toolCallEndEvent(
  workspaceId: string,
  overrides?: { replay?: boolean }
): Record<string, unknown> {
  return {
    type: "tool-call-end",
    workspaceId,
    messageId: "assistant-1",
    ...(overrides?.replay === true ? { replay: true } : {}),
    toolCallId: "tool-call-1",
    toolName: "bash",
    result: { success: true },
    timestamp: Date.now(),
  };
}

function streamStartEvent(workspaceId: string): Record<string, unknown> {
  return {
    type: "stream-start",
    workspaceId,
    messageId: "assistant-1",
    model: TEST_MODEL,
    startTime: Date.now(),
  };
}

function streamAbortEvent(
  workspaceId: string,
  abortReason: "system" | "user"
): Record<string, unknown> {
  return {
    type: "stream-abort",
    workspaceId,
    messageId: "assistant-1",
    abortReason,
    metadata: { duration: 1 },
  };
}

async function waitForCondition(condition: () => boolean, timeoutMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return condition();
}

describe("AgentSession queued message tool-call dispatch", () => {
  test("soft-stops the current stream after a real tool call when a tool-end message is queued", async () => {
    const workspaceId = "queue-dispatch-tool-end";
    const { session, cleanup, aiEmitter, aiService } = await createAgentSessionHarness({
      workspaceId,
    });
    const stopStream = spyOn(aiService, "stopStream").mockResolvedValue(Ok(undefined));

    try {
      aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
      session.queueMessage("follow up", { model: TEST_MODEL, agentId: "exec" });

      aiEmitter.emit("tool-call-end", toolCallEndEvent(workspaceId));

      expect(stopStream).toHaveBeenCalledWith(workspaceId, {
        soft: true,
        abortReason: "system",
      });
    } finally {
      stopStream.mockRestore();
      session.dispose();
      await cleanup();
    }
  });

  test("does not stop the stream for turn-end queues or replayed tool events", async () => {
    const turnEndWorkspaceId = "queue-dispatch-turn-end";
    const turnEndHarness = await createAgentSessionHarness({ workspaceId: turnEndWorkspaceId });
    const turnEndStopStream = spyOn(turnEndHarness.aiService, "stopStream").mockResolvedValue(
      Ok(undefined)
    );

    try {
      turnEndHarness.aiEmitter.emit("stream-start", streamStartEvent(turnEndWorkspaceId));
      turnEndHarness.session.queueMessage("later", {
        model: TEST_MODEL,
        agentId: "exec",
        queueDispatchMode: "turn-end",
      });
      turnEndHarness.aiEmitter.emit("tool-call-end", toolCallEndEvent(turnEndWorkspaceId));

      expect(turnEndStopStream).not.toHaveBeenCalled();
    } finally {
      turnEndStopStream.mockRestore();
      turnEndHarness.session.dispose();
      await turnEndHarness.cleanup();
    }

    const replayWorkspaceId = "queue-dispatch-replay";
    const replayHarness = await createAgentSessionHarness({ workspaceId: replayWorkspaceId });
    const replayStopStream = spyOn(replayHarness.aiService, "stopStream").mockResolvedValue(
      Ok(undefined)
    );

    try {
      replayHarness.aiEmitter.emit("stream-start", streamStartEvent(replayWorkspaceId));
      replayHarness.session.queueMessage("follow up", { model: TEST_MODEL, agentId: "exec" });
      replayHarness.aiEmitter.emit(
        "tool-call-end",
        toolCallEndEvent(replayWorkspaceId, { replay: true })
      );

      expect(replayStopStream).not.toHaveBeenCalled();
    } finally {
      replayStopStream.mockRestore();
      replayHarness.session.dispose();
      await replayHarness.cleanup();
    }
  });

  test("sends the queued message after the system abort caused by tool-call dispatch", async () => {
    const workspaceId = "queue-dispatch-after-system-abort";
    const { session, cleanup, aiEmitter, aiService } = await createAgentSessionHarness({
      workspaceId,
    });
    const stopStream = spyOn(aiService, "stopStream").mockResolvedValue(Ok(undefined));
    const sendQueuedMessages = spyOn(session, "sendQueuedMessages").mockImplementation(
      () => undefined
    );

    try {
      aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
      session.queueMessage("follow up", { model: TEST_MODEL, agentId: "exec" });
      aiEmitter.emit("tool-call-end", toolCallEndEvent(workspaceId));
      aiEmitter.emit("stream-abort", streamAbortEvent(workspaceId, "system"));

      const didDispatch = await waitForCondition(() => sendQueuedMessages.mock.calls.length > 0);
      expect(didDispatch).toBe(true);
      expect(sendQueuedMessages).toHaveBeenCalledTimes(1);
    } finally {
      sendQueuedMessages.mockRestore();
      stopStream.mockRestore();
      session.dispose();
      await cleanup();
    }
  });

  test("dispatches a turn-end replacement after editing while abort is in flight", async () => {
    const workspaceId = "queue-dispatch-edited-replacement";
    const { session, cleanup, aiEmitter, aiService } = await createAgentSessionHarness({
      workspaceId,
    });
    const stopStream = spyOn(aiService, "stopStream").mockResolvedValue(Ok(undefined));
    const sendQueuedMessages = spyOn(session, "sendQueuedMessages").mockImplementation(
      () => undefined
    );

    try {
      aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
      session.queueMessage("original follow up", { model: TEST_MODEL, agentId: "exec" });
      aiEmitter.emit("tool-call-end", toolCallEndEvent(workspaceId));

      session.clearQueue();
      session.queueMessage("replacement follow up", {
        model: TEST_MODEL,
        agentId: "exec",
        queueDispatchMode: "turn-end",
      });
      aiEmitter.emit("stream-abort", streamAbortEvent(workspaceId, "system"));

      const didDispatch = await waitForCondition(() => sendQueuedMessages.mock.calls.length > 0);
      expect(didDispatch).toBe(true);
      expect(sendQueuedMessages).toHaveBeenCalledTimes(1);
    } finally {
      sendQueuedMessages.mockRestore();
      stopStream.mockRestore();
      session.dispose();
      await cleanup();
    }
  });

  test("cancels a pending tool-end dispatch when a hard user interrupt starts", async () => {
    const workspaceId = "queue-dispatch-hard-user-interrupt";
    const { session, cleanup, aiEmitter, aiService } = await createAgentSessionHarness({
      workspaceId,
    });
    const stopStream = spyOn(aiService, "stopStream").mockResolvedValue(Ok(undefined));
    const sendQueuedMessages = spyOn(session, "sendQueuedMessages").mockImplementation(
      () => undefined
    );

    try {
      aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
      session.queueMessage("follow up", { model: TEST_MODEL, agentId: "exec" });
      aiEmitter.emit("tool-call-end", toolCallEndEvent(workspaceId));

      const interruptResult = await session.interruptStream();
      expect(interruptResult.success).toBe(true);
      aiEmitter.emit("stream-abort", streamAbortEvent(workspaceId, "system"));

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(sendQueuedMessages).not.toHaveBeenCalled();
    } finally {
      sendQueuedMessages.mockRestore();
      stopStream.mockRestore();
      session.dispose();
      await cleanup();
    }
  });

  // Heartbeat force-queue drain path: a scheduled message queued while the session is IDLE
  // (e.g. a heartbeat deferred behind active descendant tasks) must ride along with the next
  // turn and drain at its stream-end, releasing the dedupe key so the next firing can enqueue.
  test("drains an idle-queued deduped message at the next turn's stream-end", async () => {
    const workspaceId = "queue-dispatch-idle-queued-drain";
    const { session, cleanup, aiEmitter } = await createAgentSessionHarness({
      workspaceId,
    });
    const sendMessage = spyOn(session, "sendMessage").mockResolvedValue(Ok(undefined));

    try {
      expect(session.isBusy()).toBe(false);
      const dispatchMode = session.queueMessage(
        "[Scheduled heartbeat] check in",
        { model: TEST_MODEL, agentId: "exec", queueDispatchMode: "turn-end" },
        { synthetic: true, dedupeKey: "heartbeat-request" }
      );
      expect(dispatchMode).toBe("turn-end");
      expect(session.hasQueuedDedupeKey("heartbeat-request")).toBe(true);

      // A duplicate firing while pending is dropped (coalescing).
      expect(
        session.queueMessage(
          "[Scheduled heartbeat] check in",
          { model: TEST_MODEL, agentId: "exec", queueDispatchMode: "turn-end" },
          { synthetic: true, dedupeKey: "heartbeat-request" }
        )
      ).toBeNull();

      // The next turn (e.g. a descendant-task terminal wake) starts and ends.
      aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
      aiEmitter.emit("stream-end", {
        type: "stream-end",
        workspaceId,
        messageId: "assistant-1",
        parts: [{ type: "text", text: "wake turn done" }],
        metadata: {
          model: TEST_MODEL,
          contextUsage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
          providerMetadata: {},
          finishReason: "stop",
        },
      });

      const didDrain = await waitForCondition(
        () =>
          sendMessage.mock.calls.some((call) => call[0] === "[Scheduled heartbeat] check in") &&
          !session.hasQueuedMessages()
      );
      expect(didDrain).toBe(true);
      // Queue clear released the dedupe key: the next scheduled firing can enqueue again.
      expect(session.hasQueuedDedupeKey("heartbeat-request")).toBe(false);
    } finally {
      sendMessage.mockRestore();
      session.dispose();
      await cleanup();
    }
  });

  test("restoreQueueToInput discards a queued heartbeat instead of restoring it", async () => {
    const workspaceId = "queue-dispatch-restore-discards-heartbeat";
    const { session, cleanup } = await createAgentSessionHarness({ workspaceId });

    try {
      session.queueMessage(
        "[Scheduled heartbeat] check in",
        { model: TEST_MODEL, agentId: "exec", queueDispatchMode: "turn-end" },
        { synthetic: true, dedupeKey: "heartbeat-request" }
      );
      expect(session.hasQueuedMessages()).toBe(true);

      const restoredTexts: string[] = [];
      const unsubscribe = session.onChatEvent((event) => {
        if (event.message.type === "restore-to-input") {
          restoredTexts.push(event.message.text);
        }
      });

      // A user interrupt restores queued input to the composer — the backend-initiated
      // heartbeat must be discarded, not surfaced as editable user text.
      session.restoreQueueToInput();
      unsubscribe();

      expect(restoredTexts).toEqual([]);
      expect(session.hasQueuedMessages()).toBe(false);
      // Dropping released the dedupe key so the next scheduled firing can enqueue again.
      expect(session.hasQueuedDedupeKey("heartbeat-request")).toBe(false);

      // Plain user input still restores.
      session.queueMessage("my own words", { model: TEST_MODEL, agentId: "exec" });
      const unsubscribeUser = session.onChatEvent((event) => {
        if (event.message.type === "restore-to-input") {
          restoredTexts.push(event.message.text);
        }
      });
      session.restoreQueueToInput();
      unsubscribeUser();
      expect(restoredTexts).toEqual(["my own words"]);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("does not send the queued message after a user abort", async () => {
    const workspaceId = "queue-dispatch-user-abort";
    const { session, cleanup, aiEmitter, aiService } = await createAgentSessionHarness({
      workspaceId,
    });
    const stopStream = spyOn(aiService, "stopStream").mockResolvedValue(Ok(undefined));
    const sendQueuedMessages = spyOn(session, "sendQueuedMessages").mockImplementation(
      () => undefined
    );

    try {
      aiEmitter.emit("stream-start", streamStartEvent(workspaceId));
      session.queueMessage("follow up", { model: TEST_MODEL, agentId: "exec" });
      aiEmitter.emit("tool-call-end", toolCallEndEvent(workspaceId));
      aiEmitter.emit("stream-abort", streamAbortEvent(workspaceId, "user"));

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(sendQueuedMessages).not.toHaveBeenCalled();
    } finally {
      sendQueuedMessages.mockRestore();
      stopStream.mockRestore();
      session.dispose();
      await cleanup();
    }
  });
});
