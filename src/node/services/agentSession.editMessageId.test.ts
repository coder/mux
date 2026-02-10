import { describe, expect, it, mock, afterEach, spyOn } from "bun:test";
import { EventEmitter } from "events";
import type { AIService } from "@/node/services/aiService";
import type { PartialService } from "@/node/services/partialService";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { Config } from "@/node/config";
import { createMuxMessage } from "@/common/types/message";
import type { MuxMessage } from "@/common/types/message";
import type { SendMessageError } from "@/common/types/errors";
import type { Result } from "@/common/types/result";
import { Ok } from "@/common/types/result";
import { AgentSession } from "./agentSession";
import { createTestHistoryService } from "./testHistoryService";

describe("AgentSession.sendMessage (editMessageId)", () => {
  let historyCleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await historyCleanup?.();
  });

  it("treats missing edit target as no-op (allows recovery after compaction)", async () => {
    const workspaceId = "ws-test";

    const config = {
      srcDir: "/tmp",
      getSessionDir: (_workspaceId: string) => "/tmp",
    } as unknown as Config;

    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const truncateAfterMessage = spyOn(historyService, "truncateAfterMessage");
    const appendToHistory = spyOn(historyService, "appendToHistory");

    const partialService = {
      commitToHistory: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
    } as unknown as PartialService;

    const aiEmitter = new EventEmitter();
    const streamMessage = mock((_messages: MuxMessage[]) => {
      return Promise.resolve(Ok(undefined));
    });
    const aiService = Object.assign(aiEmitter, {
      isStreaming: mock((_workspaceId: string) => false),
      stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
      streamMessage: streamMessage as unknown as (
        ...args: Parameters<AIService["streamMessage"]>
      ) => Promise<Result<void, SendMessageError>>,
    }) as unknown as AIService;

    const initStateManager = new EventEmitter() as unknown as InitStateManager;

    const backgroundProcessManager = {
      cleanup: mock((_workspaceId: string) => Promise.resolve()),
      setMessageQueued: mock((_workspaceId: string, _queued: boolean) => {
        void _queued;
      }),
    } as unknown as BackgroundProcessManager;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      partialService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const result = await session.sendMessage("hello", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      editMessageId: "missing-user-message-id",
    });

    expect(result.success).toBe(true);
    expect(truncateAfterMessage.mock.calls).toHaveLength(1);
    expect(appendToHistory.mock.calls).toHaveLength(1);
    expect(streamMessage.mock.calls).toHaveLength(1);
  });

  it("clears image parts when editing with explicit empty fileParts", async () => {
    const workspaceId = "ws-test";

    const config = {
      srcDir: "/tmp",
      getSessionDir: (_workspaceId: string) => "/tmp",
    } as unknown as Config;

    const originalMessageId = "user-message-with-image";
    const originalImageUrl = "data:image/png;base64,AAAA";

    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    // Seed original message before setting up spies
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage(originalMessageId, "user", "original", { historySequence: 0 }, [
        { type: "file" as const, mediaType: "image/png", url: originalImageUrl },
      ])
    );

    const truncateAfterMessage = spyOn(historyService, "truncateAfterMessage");
    const appendToHistory = spyOn(historyService, "appendToHistory");

    const partialService = {
      commitToHistory: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
    } as unknown as PartialService;

    const aiEmitter = new EventEmitter();
    const streamMessage = mock((_messages: MuxMessage[]) => {
      return Promise.resolve(Ok(undefined));
    });
    const aiService = Object.assign(aiEmitter, {
      isStreaming: mock((_workspaceId: string) => false),
      stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
      streamMessage: streamMessage as unknown as (
        ...args: Parameters<AIService["streamMessage"]>
      ) => Promise<Result<void, SendMessageError>>,
    }) as unknown as AIService;

    const initStateManager = new EventEmitter() as unknown as InitStateManager;

    const backgroundProcessManager = {
      cleanup: mock((_workspaceId: string) => Promise.resolve()),
      setMessageQueued: mock((_workspaceId: string, _queued: boolean) => {
        void _queued;
      }),
    } as unknown as BackgroundProcessManager;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      partialService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const result = await session.sendMessage("edited", {
      model: "anthropic:claude-3-5-sonnet-latest",
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

    const config = {
      srcDir: "/tmp",
      getSessionDir: (_workspaceId: string) => "/tmp",
    } as unknown as Config;

    const originalMessageId = "user-message-with-image";
    const originalImageUrl = "data:image/png;base64,AAAA";

    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    // Seed original message before setting up spies
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage(originalMessageId, "user", "original", { historySequence: 0 }, [
        { type: "file" as const, mediaType: "image/png", url: originalImageUrl },
      ])
    );

    const truncateAfterMessage = spyOn(historyService, "truncateAfterMessage");
    const appendToHistory = spyOn(historyService, "appendToHistory");
    const getHistoryFromLatestBoundary = spyOn(historyService, "getHistoryFromLatestBoundary");

    const partialService = {
      commitToHistory: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
    } as unknown as PartialService;

    const aiEmitter = new EventEmitter();
    const streamMessage = mock((_messages: MuxMessage[]) => {
      return Promise.resolve(Ok(undefined));
    });
    const aiService = Object.assign(aiEmitter, {
      isStreaming: mock((_workspaceId: string) => false),
      stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
      streamMessage: streamMessage as unknown as (
        ...args: Parameters<AIService["streamMessage"]>
      ) => Promise<Result<void, SendMessageError>>,
    }) as unknown as AIService;

    const initStateManager = new EventEmitter() as unknown as InitStateManager;

    const backgroundProcessManager = {
      cleanup: mock((_workspaceId: string) => Promise.resolve()),
      setMessageQueued: mock((_workspaceId: string, _queued: boolean) => {
        void _queued;
      }),
    } as unknown as BackgroundProcessManager;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      partialService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const result = await session.sendMessage("edited", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      editMessageId: originalMessageId,
    });

    expect(result.success).toBe(true);
    expect(getHistoryFromLatestBoundary.mock.calls.length).toBeGreaterThan(0);
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
});
