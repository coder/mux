import { describe, expect, it, mock, afterEach } from "bun:test";
import { EventEmitter } from "events";
import { PROVIDER_DISPLAY_NAMES } from "@/common/constants/providers";
import type { AIService } from "@/node/services/aiService";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { SendMessageError } from "@/common/types/errors";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import { computePriorHistoryFingerprint } from "@/common/orpc/onChatCursorFingerprint";
import {
  isMuxMessage,
  type StreamErrorMessage,
  type WorkspaceChatMessage,
} from "@/common/orpc/types";
import { AgentSession } from "./agentSession";
import { createTestHistoryService } from "./testHistoryService";

interface ReplayHarnessStreamInfo {
  messageId: string;
  startTime: number;
  parts: Array<{ timestamp?: number }>;
  toolCompletionTimestamps: Map<string, number>;
}

async function createReplaySessionHarness(
  workspaceId: string,
  options?: { streamInfo?: ReplayHarnessStreamInfo }
) {
  const { historyService, config, cleanup } = await createTestHistoryService();
  const streamInfo = options?.streamInfo;

  const aiEmitter = new EventEmitter();
  const replayStream = mock((_workspaceId: string, _opts?: { afterTimestamp?: number }) =>
    Promise.resolve()
  );
  const aiService = Object.assign(aiEmitter, {
    isStreaming: mock((_workspaceId: string) => false),
    stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
    streamMessage: mock((_history: MuxMessage[]) =>
      Promise.resolve(Err({ type: "unknown", raw: "unused" }))
    ) as unknown as (...args: Parameters<AIService["streamMessage"]>) => Promise<unknown>,
    getStreamInfo: mock((_workspaceId: string) => streamInfo),
    replayStream,
  }) as unknown as AIService;

  const replayInit = mock((_workspaceId: string) => Promise.resolve());
  const initStateManager = Object.assign(new EventEmitter(), {
    replayInit,
  }) as unknown as InitStateManager;

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
    aiService,
    initStateManager,
    backgroundProcessManager,
  });

  return { session, cleanup, replayInit, replayStream, historyService, aiEmitter };
}
describe("AgentSession pre-stream errors", () => {
  let historyCleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await historyCleanup?.();
  });

  it("emits stream-error when stream startup fails", async () => {
    const workspaceId = "ws-test";

    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const aiEmitter = new EventEmitter();
    const streamMessage = mock((_history: MuxMessage[]) => {
      return Promise.resolve(
        Err({
          type: "api_key_not_found",
          provider: "anthropic",
        })
      );
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
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const events: WorkspaceChatMessage[] = [];
    session.onChatEvent((event) => {
      events.push(event.message);
    });

    const result = await session.sendMessage("hello", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
    });

    expect(result.success).toBe(false);
    expect(streamMessage.mock.calls).toHaveLength(1);

    const streamError = events.find(
      (event): event is StreamErrorMessage => event.type === "stream-error"
    );

    expect(streamError).toBeDefined();
    expect(streamError?.errorType).toBe("authentication");
    expect(streamError?.error).toContain(PROVIDER_DISPLAY_NAMES.anthropic);
    expect(streamError?.messageId).toMatch(/^assistant-/);
  });

  it("schedules auto-retry when runtime startup fails before stream events", async () => {
    const workspaceId = "ws-runtime-start-failed";

    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const aiEmitter = new EventEmitter();
    const streamMessage = mock((_history: MuxMessage[]) => {
      return Promise.resolve(
        Err({
          type: "runtime_start_failed",
          message: "Runtime is starting",
        })
      );
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
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const events: WorkspaceChatMessage[] = [];
    session.onChatEvent((event) => {
      events.push(event.message);
    });

    const result = await session.sendMessage("hello", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
    });

    expect(result.success).toBe(false);

    const scheduledRetry = events.find(
      (event): event is Extract<WorkspaceChatMessage, { type: "auto-retry-scheduled" }> =>
        event.type === "auto-retry-scheduled"
    );
    expect(scheduledRetry).toBeDefined();
    expect(events.some((event) => event.type === "stream-error")).toBe(false);
  });

  it("honors persisted auto-retry opt-out for synthetic startup-time failures", async () => {
    const workspaceId = "ws-runtime-start-failed-persisted-opt-out";

    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const aiEmitter = new EventEmitter();
    const streamMessage = mock((_history: MuxMessage[]) => {
      return Promise.resolve(
        Err({
          type: "runtime_start_failed",
          message: "Runtime is starting",
        })
      );
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

    const sessionWithPersistedPreference = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });
    await sessionWithPersistedPreference.setAutoRetryEnabled(false);
    sessionWithPersistedPreference.dispose();

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const events: WorkspaceChatMessage[] = [];
    session.onChatEvent((event) => {
      events.push(event.message);
    });

    // Synthetic sends mirror backend-driven startup/compaction paths that can fail
    // before subscribeChat-based startup recovery loads persisted retry preference.
    const result = await session.sendMessage(
      "hello",
      {
        model: "anthropic:claude-3-5-sonnet-latest",
        agentId: "exec",
      },
      { synthetic: true }
    );

    expect(result.success).toBe(false);
    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);

    session.dispose();
  });

  it("does not double-schedule auto-retry when runtime startup failure already emitted", async () => {
    const workspaceId = "ws-runtime-start-failed-pre-emitted-error";

    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const aiEmitter = new EventEmitter();
    const streamMessage = mock((_history: MuxMessage[]) => {
      aiEmitter.emit("error", {
        workspaceId,
        messageId: "assistant-stream-startup-failed",
        error: "Runtime is still starting",
        errorType: "runtime_start_failed",
      });

      return Promise.resolve(
        Err({
          type: "runtime_start_failed",
          message: "Runtime is still starting",
        })
      );
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
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const events: WorkspaceChatMessage[] = [];
    session.onChatEvent((event) => {
      events.push(event.message);
    });

    const result = await session.sendMessage("hello", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
    });

    expect(result.success).toBe(false);

    await session.waitForIdle();

    const scheduledRetries = events.filter(
      (event): event is Extract<WorkspaceChatMessage, { type: "auto-retry-scheduled" }> =>
        event.type === "auto-retry-scheduled"
    );

    expect(scheduledRetries).toHaveLength(1);
    expect(scheduledRetries[0]?.attempt).toBe(1);

    session.dispose();
  });

  it("replays init state for since-mode reconnects", async () => {
    const workspaceId = "ws-replay-init-since";
    const { session, cleanup, replayInit } = await createReplaySessionHarness(workspaceId);
    historyCleanup = cleanup;

    const events: WorkspaceChatMessage[] = [];
    await session.replayHistory(
      ({ message }) => {
        events.push(message);
      },
      {
        type: "since",
        cursor: {
          history: {
            messageId: "missing-message",
            historySequence: 123,
            oldestHistorySequence: 123,
          },
        },
      }
    );

    expect(replayInit).toHaveBeenCalledWith(workspaceId);
    expect(events.some((event) => "type" in event && event.type === "caught-up")).toBe(true);
  });

  it("keeps since replay when stream cursor is stale but history cursor is valid", async () => {
    const workspaceId = "ws-replay-since-stale-stream-cursor";
    const { session, cleanup, replayInit, historyService } =
      await createReplaySessionHarness(workspaceId);
    historyCleanup = cleanup;

    const firstMessage = createMuxMessage("msg-history-1", "user", "first");
    const secondMessage = createMuxMessage("msg-history-2", "assistant", "second");

    const appendFirst = await historyService.appendToHistory(workspaceId, firstMessage);
    expect(appendFirst.success).toBe(true);
    const appendSecond = await historyService.appendToHistory(workspaceId, secondMessage);
    expect(appendSecond.success).toBe(true);

    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!historyResult.success) {
      throw new Error(`Failed to read history: ${historyResult.error}`);
    }

    const firstPersisted = historyResult.data.find((message) => message.id === firstMessage.id);
    const secondPersisted = historyResult.data.find((message) => message.id === secondMessage.id);
    if (!firstPersisted || !secondPersisted) {
      throw new Error("Expected persisted history messages for since replay test");
    }

    const firstHistorySequence = firstPersisted.metadata?.historySequence;
    if (firstHistorySequence === undefined) {
      throw new Error("Expected first persisted message to have historySequence");
    }

    const historySequences = historyResult.data
      .map((message) => message.metadata?.historySequence)
      .filter((historySequence): historySequence is number => historySequence !== undefined);
    if (historySequences.length === 0) {
      throw new Error("Expected persisted history sequences for since replay test");
    }
    const oldestHistorySequence = Math.min(...historySequences);

    const events: WorkspaceChatMessage[] = [];
    await session.replayHistory(
      ({ message }) => {
        events.push(message);
      },
      {
        type: "since",
        cursor: {
          history: {
            messageId: firstPersisted.id,
            historySequence: firstHistorySequence,
            oldestHistorySequence,
          },
          stream: {
            messageId: "ended-stream",
            lastTimestamp: 9_999,
          },
        },
      }
    );

    expect(replayInit).toHaveBeenCalledWith(workspaceId);

    const caughtUp = events.find(
      (event): event is Extract<WorkspaceChatMessage, { type: "caught-up" }> =>
        "type" in event && event.type === "caught-up"
    );
    expect(caughtUp).toBeDefined();
    expect(caughtUp?.replay).toBe("since");

    const replayedMessageIds = events.reduce<string[]>((ids, event) => {
      if (
        "role" in event &&
        (event.role === "user" || event.role === "assistant") &&
        "id" in event &&
        typeof event.id === "string"
      ) {
        ids.push(event.id);
      }
      return ids;
    }, []);

    expect(replayedMessageIds).toEqual([firstPersisted.id, secondPersisted.id]);
  });

  it("clamps since stream cursor timestamp to current server stream timeline", async () => {
    const workspaceId = "ws-replay-since-clamp-stream-cursor";
    const { session, cleanup, replayStream, historyService } = await createReplaySessionHarness(
      workspaceId,
      {
        streamInfo: {
          messageId: "msg-live-clamp",
          startTime: 1_000,
          parts: [{ timestamp: 100 }],
          toolCompletionTimestamps: new Map(),
        },
      }
    );
    historyCleanup = cleanup;

    const seedMessage = createMuxMessage("msg-history-seed", "assistant", "seed");
    expect((await historyService.appendToHistory(workspaceId, seedMessage)).success).toBe(true);

    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!historyResult.success) {
      throw new Error(`Failed to read seeded history: ${historyResult.error}`);
    }

    const persistedSeed = historyResult.data.find((message) => message.id === seedMessage.id);
    if (!persistedSeed) {
      throw new Error("Expected seeded history message");
    }

    const seedHistorySequence = persistedSeed.metadata?.historySequence;
    if (seedHistorySequence === undefined) {
      throw new Error("Expected seeded history message to include historySequence");
    }

    const events: WorkspaceChatMessage[] = [];
    await session.replayHistory(
      ({ message }) => {
        events.push(message);
      },
      {
        type: "since",
        cursor: {
          history: {
            messageId: persistedSeed.id,
            historySequence: seedHistorySequence,
            oldestHistorySequence: seedHistorySequence,
          },
          stream: {
            messageId: "msg-live-clamp",
            lastTimestamp: 9_999,
          },
        },
      }
    );

    expect(replayStream).toHaveBeenCalledWith(workspaceId, { afterTimestamp: 100 });

    const caughtUp = events.find(
      (event): event is Extract<WorkspaceChatMessage, { type: "caught-up" }> =>
        "type" in event && event.type === "caught-up"
    );
    expect(caughtUp?.replay).toBe("since");
  });

  it("falls back to full replay when history below since cursor changed", async () => {
    const workspaceId = "ws-replay-since-history-changed-below-cursor";
    const { session, cleanup, historyService } = await createReplaySessionHarness(workspaceId);
    historyCleanup = cleanup;

    const firstMessage = createMuxMessage("msg-history-a", "user", "first");
    const secondMessage = createMuxMessage("msg-history-b", "assistant", "second");
    const thirdMessage = createMuxMessage("msg-history-c", "assistant", "third");

    expect((await historyService.appendToHistory(workspaceId, firstMessage)).success).toBe(true);
    expect((await historyService.appendToHistory(workspaceId, secondMessage)).success).toBe(true);
    expect((await historyService.appendToHistory(workspaceId, thirdMessage)).success).toBe(true);

    const beforeDeleteHistory = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!beforeDeleteHistory.success) {
      throw new Error(`Failed to read seeded history: ${beforeDeleteHistory.error}`);
    }

    const persistedFirst = beforeDeleteHistory.data.find(
      (message) => message.id === firstMessage.id
    );
    const persistedSecond = beforeDeleteHistory.data.find(
      (message) => message.id === secondMessage.id
    );
    const persistedThird = beforeDeleteHistory.data.find(
      (message) => message.id === thirdMessage.id
    );
    if (!persistedFirst || !persistedSecond || !persistedThird) {
      throw new Error("Expected all seeded history rows to persist");
    }

    const thirdHistorySequence = persistedThird.metadata?.historySequence;
    if (thirdHistorySequence === undefined) {
      throw new Error("Expected cursor-boundary message to have historySequence");
    }

    const oldestHistorySequence = Math.min(
      ...beforeDeleteHistory.data
        .map((message) => message.metadata?.historySequence)
        .filter((historySequence): historySequence is number => historySequence !== undefined)
    );
    const priorHistoryFingerprint = computePriorHistoryFingerprint(
      beforeDeleteHistory.data,
      thirdHistorySequence
    );
    if (priorHistoryFingerprint === undefined) {
      throw new Error("Expected priorHistoryFingerprint for rows below cursor");
    }

    expect((await historyService.deleteMessage(workspaceId, persistedSecond.id)).success).toBe(
      true
    );

    const events: WorkspaceChatMessage[] = [];
    await session.replayHistory(
      ({ message }) => {
        events.push(message);
      },
      {
        type: "since",
        cursor: {
          history: {
            messageId: persistedThird.id,
            historySequence: thirdHistorySequence,
            oldestHistorySequence,
            priorHistoryFingerprint,
          },
          stream: {
            messageId: "ended-stream",
            lastTimestamp: 9_999,
          },
        },
      }
    );

    const caughtUp = events.find(
      (event): event is Extract<WorkspaceChatMessage, { type: "caught-up" }> =>
        "type" in event && event.type === "caught-up"
    );
    expect(caughtUp).toBeDefined();
    expect(caughtUp?.replay).toBe("full");

    const replayedMessageIds = events.filter(isMuxMessage).map((message) => message.id);
    expect(replayedMessageIds).toContain(persistedFirst.id);
    expect(replayedMessageIds).toContain(persistedThird.id);
    expect(replayedMessageIds).not.toContain(persistedSecond.id);
  });

  it("keeps since replay mode when failure occurs after incremental payload is emitted", async () => {
    const workspaceId = "ws-replay-since-error-downgrade";
    const { session, cleanup, historyService, replayStream } = await createReplaySessionHarness(
      workspaceId,
      {
        streamInfo: {
          messageId: "msg-live-replay",
          startTime: 9_000,
          parts: [],
          toolCompletionTimestamps: new Map(),
        },
      }
    );
    historyCleanup = cleanup;

    const seededMessage = createMuxMessage("msg-history-d", "assistant", "seed");
    expect((await historyService.appendToHistory(workspaceId, seededMessage)).success).toBe(true);

    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!historyResult.success) {
      throw new Error(`Failed to read seeded history: ${historyResult.error}`);
    }

    const persistedSeeded = historyResult.data.find((message) => message.id === seededMessage.id);
    if (!persistedSeeded) {
      throw new Error("Expected seeded message to persist");
    }

    const seededHistorySequence = persistedSeeded.metadata?.historySequence;
    if (seededHistorySequence === undefined) {
      throw new Error("Expected seeded message to have historySequence");
    }

    replayStream.mockImplementationOnce(() => Promise.reject(new Error("replay stream failed")));

    const events: WorkspaceChatMessage[] = [];
    await session.replayHistory(
      ({ message }) => {
        events.push(message);
      },
      {
        type: "since",
        cursor: {
          history: {
            messageId: persistedSeeded.id,
            historySequence: seededHistorySequence,
            oldestHistorySequence: seededHistorySequence,
          },
        },
      }
    );

    const caughtUp = events.find(
      (event): event is Extract<WorkspaceChatMessage, { type: "caught-up" }> =>
        "type" in event && event.type === "caught-up"
    );
    expect(caughtUp).toBeDefined();
    expect(caughtUp?.replay).toBe("since");
    expect(caughtUp?.cursor).toBeUndefined();
  });

  it("keeps incremental replay mode when replay stream events were already emitted", async () => {
    const workspaceId = "ws-replay-since-error-after-stream-events";
    const { session, cleanup, historyService, replayStream, aiEmitter } =
      await createReplaySessionHarness(workspaceId, {
        streamInfo: {
          messageId: "msg-live-stream-events",
          startTime: 8_500,
          parts: [],
          toolCompletionTimestamps: new Map(),
        },
      });
    historyCleanup = cleanup;

    const placeholder = createMuxMessage("msg-history-stream-events", "assistant", "placeholder");
    expect((await historyService.appendToHistory(workspaceId, placeholder)).success).toBe(true);

    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!historyResult.success) {
      throw new Error(`Failed to read seeded history: ${historyResult.error}`);
    }

    const persistedPlaceholder = historyResult.data.find(
      (message) => message.id === placeholder.id
    );
    if (!persistedPlaceholder) {
      throw new Error("Expected placeholder history row");
    }

    const placeholderHistorySequence = persistedPlaceholder.metadata?.historySequence;
    if (placeholderHistorySequence === undefined) {
      throw new Error("Expected placeholder row to include historySequence");
    }

    const partial = createMuxMessage("msg-partial-stream-events", "assistant", "partial", {
      historySequence: placeholderHistorySequence,
    });
    expect((await historyService.writePartial(workspaceId, partial)).success).toBe(true);

    replayStream.mockImplementationOnce(() => {
      aiEmitter.emit("stream-start", {
        type: "stream-start",
        workspaceId,
        messageId: "msg-live-stream-events",
        replay: true,
        model: "claude-3-5-sonnet-20241022",
        historySequence: placeholderHistorySequence,
        startTime: 8_500,
      });
      return Promise.reject(new Error("replay stream failed after events"));
    });

    const events: WorkspaceChatMessage[] = [];
    await session.replayHistory(
      ({ message }) => {
        events.push(message);
      },
      {
        type: "since",
        cursor: {
          history: {
            messageId: persistedPlaceholder.id,
            historySequence: placeholderHistorySequence,
            oldestHistorySequence: placeholderHistorySequence,
          },
        },
      }
    );

    const caughtUp = events.find(
      (event): event is Extract<WorkspaceChatMessage, { type: "caught-up" }> =>
        "type" in event && event.type === "caught-up"
    );
    expect(caughtUp).toBeDefined();
    expect(caughtUp?.replay).toBe("since");
    expect(caughtUp?.cursor).toBeUndefined();
  });

  it("reports full replay when since replay fails before emitting incremental payload", async () => {
    const workspaceId = "ws-replay-since-error-before-payload";
    const { session, cleanup, historyService, replayStream } = await createReplaySessionHarness(
      workspaceId,
      {
        streamInfo: {
          messageId: "msg-live-prepayload",
          startTime: 8_000,
          parts: [],
          toolCompletionTimestamps: new Map(),
        },
      }
    );
    historyCleanup = cleanup;

    const placeholder = createMuxMessage("msg-history-placeholder", "assistant", "placeholder");
    expect((await historyService.appendToHistory(workspaceId, placeholder)).success).toBe(true);

    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!historyResult.success) {
      throw new Error(`Failed to read seeded history: ${historyResult.error}`);
    }

    const persistedPlaceholder = historyResult.data.find(
      (message) => message.id === placeholder.id
    );
    if (!persistedPlaceholder) {
      throw new Error("Expected placeholder history row");
    }

    const placeholderHistorySequence = persistedPlaceholder.metadata?.historySequence;
    if (placeholderHistorySequence === undefined) {
      throw new Error("Expected placeholder row to include historySequence");
    }

    const partial = createMuxMessage("msg-partial-prepayload", "assistant", "partial", {
      historySequence: placeholderHistorySequence,
    });
    expect((await historyService.writePartial(workspaceId, partial)).success).toBe(true);

    replayStream.mockImplementationOnce(() => Promise.reject(new Error("replay stream failed")));

    const events: WorkspaceChatMessage[] = [];
    await session.replayHistory(
      ({ message }) => {
        events.push(message);
      },
      {
        type: "since",
        cursor: {
          history: {
            messageId: persistedPlaceholder.id,
            historySequence: placeholderHistorySequence,
            oldestHistorySequence: placeholderHistorySequence,
          },
        },
      }
    );

    const caughtUp = events.find(
      (event): event is Extract<WorkspaceChatMessage, { type: "caught-up" }> =>
        "type" in event && event.type === "caught-up"
    );
    expect(caughtUp).toBeDefined();
    expect(caughtUp?.replay).toBe("full");
    expect(caughtUp?.cursor).toBeUndefined();
  });

  it("replays cursor-boundary message when stream completed while offline", async () => {
    const workspaceId = "ws-replay-since-boundary-message";
    const { session, cleanup, replayInit, historyService } =
      await createReplaySessionHarness(workspaceId);
    historyCleanup = cleanup;

    const inFlightPlaceholder = createMuxMessage("msg-stream-1", "assistant", "partial");
    const appendPlaceholder = await historyService.appendToHistory(
      workspaceId,
      inFlightPlaceholder
    );
    expect(appendPlaceholder.success).toBe(true);

    const beforeUpdateHistory = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!beforeUpdateHistory.success) {
      throw new Error(`Failed to read history before update: ${beforeUpdateHistory.error}`);
    }

    const persistedPlaceholder = beforeUpdateHistory.data.find(
      (message) => message.id === inFlightPlaceholder.id
    );
    if (!persistedPlaceholder) {
      throw new Error("Expected persisted placeholder message before update");
    }

    const placeholderHistorySequence = persistedPlaceholder.metadata?.historySequence;
    if (placeholderHistorySequence === undefined) {
      throw new Error("Expected persisted placeholder to have historySequence");
    }

    const finalizedMessage = createMuxMessage("msg-stream-1", "assistant", "finalized", {
      historySequence: placeholderHistorySequence,
    });
    const updateResult = await historyService.updateHistory(workspaceId, finalizedMessage);
    expect(updateResult.success).toBe(true);

    const events: WorkspaceChatMessage[] = [];
    await session.replayHistory(
      ({ message }) => {
        events.push(message);
      },
      {
        type: "since",
        cursor: {
          history: {
            messageId: persistedPlaceholder.id,
            historySequence: placeholderHistorySequence,
            oldestHistorySequence: placeholderHistorySequence,
          },
          stream: {
            messageId: "ended-stream",
            lastTimestamp: 9_999,
          },
        },
      }
    );

    expect(replayInit).toHaveBeenCalledWith(workspaceId);

    const caughtUp = events.find(
      (event): event is Extract<WorkspaceChatMessage, { type: "caught-up" }> =>
        "type" in event && event.type === "caught-up"
    );
    expect(caughtUp).toBeDefined();
    expect(caughtUp?.replay).toBe("since");

    const replayedMessages = events
      .filter(isMuxMessage)
      .filter((event) => event.role === "assistant");
    expect(replayedMessages).toHaveLength(1);
    expect(replayedMessages[0].id).toBe("msg-stream-1");

    const replayedText = replayedMessages[0].parts
      .filter(
        (
          part
        ): part is Extract<(typeof replayedMessages)[number]["parts"][number], { type: "text" }> =>
          part.type === "text"
      )
      .map((part) => part.text)
      .join("");
    expect(replayedText).toContain("finalized");
  });

  it("uses stream start timestamp baseline for live replay when no parts exist", async () => {
    const workspaceId = "ws-replay-live-start-baseline";
    const streamStartTime = 4_321;
    const { session, cleanup, replayStream } = await createReplaySessionHarness(workspaceId, {
      streamInfo: {
        messageId: "live-msg-1",
        startTime: streamStartTime,
        parts: [],
        toolCompletionTimestamps: new Map(),
      },
    });
    historyCleanup = cleanup;

    const events: WorkspaceChatMessage[] = [];
    await session.replayHistory(
      ({ message }) => {
        events.push(message);
      },
      {
        type: "live",
      }
    );

    expect(replayStream).toHaveBeenCalledWith(workspaceId, { afterTimestamp: streamStartTime });
    expect(events.some((event) => "type" in event && event.type === "caught-up")).toBe(true);
  });

  it("replays init state for live-mode reconnects", async () => {
    const workspaceId = "ws-replay-init-live";
    const { session, cleanup, replayInit } = await createReplaySessionHarness(workspaceId);
    historyCleanup = cleanup;

    const events: WorkspaceChatMessage[] = [];
    await session.replayHistory(
      ({ message }) => {
        events.push(message);
      },
      {
        type: "live",
      }
    );

    expect(replayInit).toHaveBeenCalledWith(workspaceId);
    expect(events.some((event) => "type" in event && event.type === "caught-up")).toBe(true);
  });
});
