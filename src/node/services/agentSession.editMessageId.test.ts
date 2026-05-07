import { describe, expect, it, mock, afterEach, spyOn } from "bun:test";
import { EventEmitter } from "events";
import type { AIService } from "@/node/services/aiService";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { Config } from "@/node/config";
import { createMuxMessage } from "@/common/types/message";
import type { SendMessageError } from "@/common/types/errors";
import type { Result } from "@/common/types/result";
import { Ok } from "@/common/types/result";
import { AgentSession } from "./agentSession";
import { createTestHistoryService } from "./testHistoryService";

type StreamMessageHandler = AIService["streamMessage"];

const TEST_MODEL = "anthropic:claude-3-5-sonnet-latest";
const config = {
  srcDir: "/tmp",
  getSessionDir: (_workspaceId: string) => "/tmp",
} as unknown as Config;

async function waitForCondition(condition: () => boolean, timeoutMs = 1000): Promise<boolean> {
  if (condition()) {
    return true;
  }
  if (timeoutMs <= 0) {
    return false;
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  return waitForCondition(condition, timeoutMs - 10);
}

describe("AgentSession.sendMessage (editMessageId)", () => {
  let historyCleanup: (() => Promise<void>) | undefined;

  async function createSessionHarness(
    workspaceId: string,
    streamHandler: StreamMessageHandler = () => Promise.resolve(Ok(undefined))
  ) {
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const streamMessage = mock(streamHandler);
    const aiService = Object.assign(new EventEmitter(), {
      isStreaming: mock((_workspaceId: string) => false),
      stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
      streamMessage: streamMessage as unknown as AIService["streamMessage"],
    }) as unknown as AIService;

    return {
      historyService,
      streamMessage,
      session: new AgentSession({
        workspaceId,
        config,
        historyService,
        aiService,
        initStateManager: new EventEmitter() as unknown as InitStateManager,
        backgroundProcessManager: {
          cleanup: mock((_workspaceId: string) => Promise.resolve()),
          setMessageQueued: mock((_workspaceId: string, _queued: boolean) => {
            void _queued;
          }),
        } as unknown as BackgroundProcessManager,
      }),
    };
  }

  async function seedImageMessage(
    workspaceId: string,
    historyService: Awaited<ReturnType<typeof createTestHistoryService>>["historyService"],
    messageId = "user-message-with-image"
  ): Promise<string> {
    const originalImageUrl = "data:image/png;base64,AAAA";
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage(messageId, "user", "original", { historySequence: 0 }, [
        { type: "file", mediaType: "image/png", url: originalImageUrl },
      ])
    );
    return originalImageUrl;
  }

  afterEach(async () => {
    await historyCleanup?.();
  });

  it("treats missing edit target as no-op (allows recovery after compaction)", async () => {
    const { session, historyService, streamMessage } = await createSessionHarness("ws-test");
    const truncateAfterMessage = spyOn(historyService, "truncateAfterMessage");
    const appendToHistory = spyOn(historyService, "appendToHistory");

    const result = await session.sendMessage("hello", {
      model: TEST_MODEL,
      agentId: "exec",
      editMessageId: "missing-user-message-id",
    });

    expect(result.success).toBe(true);
    expect(truncateAfterMessage.mock.calls).toHaveLength(1);
    expect(appendToHistory.mock.calls).toHaveLength(1);

    await session.waitForIdle();
    expect(streamMessage.mock.calls).toHaveLength(1);
  });

  it("does not truncate history when edit validation fails", async () => {
    const workspaceId = "ws-edit-validation";
    const { session, historyService, streamMessage } = await createSessionHarness(workspaceId);
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-original", "user", "original", { historySequence: 0 })
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("assistant-original", "assistant", "reply", { historySequence: 1 })
    );
    const truncateAfterMessage = spyOn(historyService, "truncateAfterMessage");
    const appendToHistory = spyOn(historyService, "appendToHistory");

    const result = await session.sendMessage("edited", {
      model: "invalid-model",
      agentId: "exec",
      editMessageId: "user-original",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe("invalid_model_string");
    }
    expect(truncateAfterMessage).not.toHaveBeenCalled();
    expect(appendToHistory).not.toHaveBeenCalled();
    expect(streamMessage).not.toHaveBeenCalled();

    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success).toBe(true);
    if (history.success) {
      expect(history.data.map((message) => message.id)).toEqual([
        "user-original",
        "assistant-original",
      ]);
    }
  });

  it("clears image parts when editing with explicit empty fileParts", async () => {
    const workspaceId = "ws-test";
    const { session, historyService } = await createSessionHarness(workspaceId);
    const originalMessageId = "user-message-with-image";
    await seedImageMessage(workspaceId, historyService, originalMessageId);
    const truncateAfterMessage = spyOn(historyService, "truncateAfterMessage");
    const appendToHistory = spyOn(historyService, "appendToHistory");

    const result = await session.sendMessage("edited", {
      model: TEST_MODEL,
      agentId: "exec",
      editMessageId: originalMessageId,
      fileParts: [],
    });

    expect(result.success).toBe(true);
    expect(truncateAfterMessage.mock.calls).toHaveLength(1);
    expect(appendToHistory.mock.calls).toHaveLength(1);

    const appendedMessage = appendToHistory.mock.calls[0][1];
    const appendedFileParts = appendedMessage.parts.filter(
      (part) => part.type === "file"
    ) as Array<{ type: "file"; url: string; mediaType: string }>;

    expect(appendedFileParts).toHaveLength(0);
  });

  it("preserves image parts when editing and fileParts are omitted", async () => {
    const workspaceId = "ws-test";
    const { session, historyService } = await createSessionHarness(workspaceId);
    const originalMessageId = "user-message-with-image";
    const originalImageUrl = await seedImageMessage(workspaceId, historyService, originalMessageId);
    const truncateAfterMessage = spyOn(historyService, "truncateAfterMessage");
    const appendToHistory = spyOn(historyService, "appendToHistory");
    const result = await session.sendMessage("edited", {
      model: TEST_MODEL,
      agentId: "exec",
      editMessageId: originalMessageId,
    });

    expect(result.success).toBe(true);
    expect(truncateAfterMessage.mock.calls).toHaveLength(1);
    expect(appendToHistory.mock.calls).toHaveLength(1);

    const appendedMessage = appendToHistory.mock.calls[0][1];
    const appendedFileParts = appendedMessage.parts.filter(
      (part) => part.type === "file"
    ) as Array<{ type: "file"; url: string; mediaType: string }>;

    expect(appendedFileParts).toHaveLength(1);
    expect(appendedFileParts[0].url).toBe(originalImageUrl);
    expect(appendedFileParts[0].mediaType).toBe("image/png");
  });

  it("preempts a still-preparing turn when editing its last user message", async () => {
    const workspaceId = "ws-edit-preparing";
    const streamResolves: Array<() => void> = [];
    const streamHandler: StreamMessageHandler = (opts) => {
      return new Promise<Result<void, SendMessageError>>((resolve) => {
        const resolveOk = () => resolve(Ok(undefined));
        if (opts.abortSignal?.aborted === true) {
          resolveOk();
          return;
        }
        opts.abortSignal?.addEventListener("abort", resolveOk, { once: true });
        streamResolves.push(resolveOk);
      });
    };
    const { session, historyService, streamMessage } = await createSessionHarness(
      workspaceId,
      streamHandler
    );
    const appendToHistory = spyOn(historyService, "appendToHistory");

    try {
      const firstSendPromise = session.sendMessage("original", {
        model: TEST_MODEL,
        agentId: "exec",
      });

      const sawPreparingTurn = await waitForCondition(
        () => streamMessage.mock.calls.length === 1 && session.isPreparingTurn()
      );
      expect(sawPreparingTurn).toBe(true);

      const originalMessage = appendToHistory.mock.calls
        .map((call) => call[1])
        .find((message) => message.role === "user" && message.parts[0]?.type === "text");
      const originalMessageId = originalMessage?.id;
      expect(typeof originalMessageId).toBe("string");

      const editResult = await Promise.race([
        session.sendMessage("edited", {
          model: TEST_MODEL,
          agentId: "exec",
          editMessageId: originalMessageId,
        }),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 250)),
      ]);

      expect(editResult).not.toBe("timeout");
      expect(editResult).toEqual(Ok(undefined));

      const sawReplacementStartup = await waitForCondition(
        () => streamMessage.mock.calls.length === 2 && session.isPreparingTurn()
      );
      expect(sawReplacementStartup).toBe(true);

      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        const userTexts = history.data
          .filter((message) => message.role === "user")
          .map((message) =>
            message.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("")
          );
        expect(userTexts).toEqual(["edited"]);
      }

      for (const resolve of streamResolves) {
        resolve();
      }
      await firstSendPromise;
    } finally {
      session.dispose();
      for (const resolve of streamResolves) {
        resolve();
      }
    }
  });
});
