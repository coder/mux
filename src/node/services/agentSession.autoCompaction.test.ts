import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";

import type { ProvidersConfigMap, WorkspaceChatMessage } from "@/common/orpc/types";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { Ok, Err } from "@/common/types/result";
import type { Config } from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { CompactionMonitor } from "./compactionMonitor";
import { AgentSession } from "./agentSession";
import { createTestHistoryService } from "./testHistoryService";

describe("AgentSession on-send auto-compaction snapshot deferral", () => {
  let historyCleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await historyCleanup?.();
  });

  test("does not persist or emit snapshots before forced on-send compaction", async () => {
    const workspaceId = "ws-auto-compaction-snapshot-deferral";

    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const aiEmitter = new EventEmitter();
    const streamMessage = mock((_history: MuxMessage[]) => Promise.resolve(Ok(undefined)));
    const aiService = Object.assign(aiEmitter, {
      isStreaming: mock((_workspaceId: string) => false),
      stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
      streamMessage: streamMessage as unknown as (
        ...args: Parameters<AIService["streamMessage"]>
      ) => Promise<unknown>,
    }) as unknown as AIService;

    const initStateManager = new EventEmitter() as unknown as InitStateManager;

    const backgroundProcessManager = {
      cleanup: mock((_workspaceId: string) => Promise.resolve()),
      setMessageQueued: mock((_workspaceId: string, _queued: boolean) => {
        void _queued;
      }),
    } as unknown as BackgroundProcessManager;

    const config = {
      srcDir: "/tmp",
      getSessionDir: (_workspaceId: string) => "/tmp",
    } as unknown as Config;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const syntheticSnapshot = createMuxMessage(
      "file-snapshot-1",
      "user",
      "<snapshot>@foo.ts</snapshot>",
      {
        timestamp: Date.now(),
        synthetic: true,
        fileAtMentionSnapshot: ["@foo.ts"],
      }
    );

    const internals = session as unknown as {
      materializeFileAtMentionsSnapshot: (
        text: string
      ) => Promise<{ snapshotMessage: MuxMessage; materializedTokens: string[] } | null>;
      compactionMonitor: CompactionMonitor;
    };

    internals.materializeFileAtMentionsSnapshot = mock((_text: string) =>
      Promise.resolve({
        snapshotMessage: syntheticSnapshot,
        materializedTokens: ["@foo.ts"],
      })
    );

    internals.compactionMonitor = {
      checkBeforeSend: mock(() => ({
        shouldShowWarning: true,
        shouldForceCompact: true,
        usagePercentage: 99,
        thresholdPercentage: 85,
      })),
      checkMidStream: mock(() => false),
      resetForNewStream: mock(() => undefined),
      setThreshold: mock(() => undefined),
      getThreshold: mock(() => 0.85),
    } as unknown as CompactionMonitor;

    const events: WorkspaceChatMessage[] = [];
    session.onChatEvent((event) => {
      events.push(event.message);
    });

    const result = await session.sendMessage("please inspect @foo.ts", {
      model: "openai:gpt-4o",
      agentId: "exec",
      disableWorkspaceAgents: true,
    });

    expect(result.success).toBe(true);
    expect(streamMessage).toHaveBeenCalledTimes(1);

    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(`failed to load history: ${String(historyResult.error)}`);
    }

    const persistedSnapshot = historyResult.data.some(
      (message) => message.metadata?.fileAtMentionSnapshot?.includes("@foo.ts") === true
    );
    expect(persistedSnapshot).toBe(false);

    const persistedCompactionMessage = historyResult.data.find(
      (message) => message.metadata?.muxMetadata?.type === "compaction-request"
    );
    expect(persistedCompactionMessage).toBeDefined();
    expect(persistedCompactionMessage?.metadata?.disableWorkspaceAgents).toBe(true);

    const emittedSnapshot = events.some(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "id" in message &&
        message.id === "file-snapshot-1"
    );
    expect(emittedSnapshot).toBe(false);

    session.dispose();
  });

  test("triggers on-send compaction at threshold even before force buffer", async () => {
    const workspaceId = "ws-auto-compaction-on-send-threshold";

    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const aiEmitter = new EventEmitter();
    const streamRequests: unknown[] = [];
    const streamMessage = mock((request: unknown) => {
      streamRequests.push(request);
      return Promise.resolve(Ok(undefined));
    });
    const aiService = Object.assign(aiEmitter, {
      isStreaming: mock((_workspaceId: string) => false),
      stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
      streamMessage: streamMessage as unknown as (
        ...args: Parameters<AIService["streamMessage"]>
      ) => Promise<unknown>,
    }) as unknown as AIService;

    const initStateManager = new EventEmitter() as unknown as InitStateManager;

    const backgroundProcessManager = {
      cleanup: mock((_workspaceId: string) => Promise.resolve()),
      setMessageQueued: mock((_workspaceId: string, _queued: boolean) => {
        void _queued;
      }),
    } as unknown as BackgroundProcessManager;

    const config = {
      srcDir: "/tmp",
      getSessionDir: (_workspaceId: string) => "/tmp",
    } as unknown as Config;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    (session as unknown as { compactionMonitor: CompactionMonitor }).compactionMonitor = {
      checkBeforeSend: mock(() => ({
        shouldShowWarning: true,
        shouldForceCompact: false,
        usagePercentage: 72,
        thresholdPercentage: 70,
      })),
      checkMidStream: mock(() => false),
      resetForNewStream: mock(() => undefined),
      setThreshold: mock(() => undefined),
      getThreshold: mock(() => 0.7),
    } as unknown as CompactionMonitor;

    const result = await session.sendMessage("hello", {
      model: "openai:gpt-4o",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(streamMessage).toHaveBeenCalledTimes(1);

    const firstRequest = streamRequests[0] as { messages?: MuxMessage[] } | undefined;
    const requestMessages = Array.isArray(firstRequest?.messages) ? firstRequest.messages : [];
    const hasCompactionRequest = requestMessages.some(
      (message) => message.metadata?.muxMetadata?.type === "compaction-request"
    );
    expect(hasCompactionRequest).toBe(true);

    session.dispose();
  });

  test("uses preferred compaction model for on-send auto-compaction requests", async () => {
    const workspaceId = "ws-auto-compaction-preferred-model";

    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const aiEmitter = new EventEmitter();
    const streamRequests: unknown[] = [];
    const streamMessage = mock((request: unknown) => {
      streamRequests.push(request);
      return Promise.resolve(Ok(undefined));
    });
    const aiService = Object.assign(aiEmitter, {
      isStreaming: mock((_workspaceId: string) => false),
      stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
      streamMessage: streamMessage as unknown as (
        ...args: Parameters<AIService["streamMessage"]>
      ) => Promise<unknown>,
    }) as unknown as AIService;

    const initStateManager = new EventEmitter() as unknown as InitStateManager;

    const backgroundProcessManager = {
      cleanup: mock((_workspaceId: string) => Promise.resolve()),
      setMessageQueued: mock((_workspaceId: string, _queued: boolean) => {
        void _queued;
      }),
    } as unknown as BackgroundProcessManager;

    const compactionModel = "openai:gpt-4o-mini";
    const config = {
      srcDir: "/tmp",
      getSessionDir: (_workspaceId: string) => "/tmp",
      loadConfigOrDefault: () => ({
        agentAiDefaults: { compact: { modelString: compactionModel } },
      }),
    } as unknown as Config;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    (session as unknown as { compactionMonitor: CompactionMonitor }).compactionMonitor = {
      checkBeforeSend: mock(() => ({
        shouldShowWarning: true,
        shouldForceCompact: true,
        usagePercentage: 95,
        thresholdPercentage: 70,
      })),
      checkMidStream: mock(() => false),
      resetForNewStream: mock(() => undefined),
      setThreshold: mock(() => undefined),
      getThreshold: mock(() => 0.7),
    } as unknown as CompactionMonitor;

    const result = await session.sendMessage("hello", {
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(streamMessage).toHaveBeenCalledTimes(1);

    const firstRequest = streamRequests[0] as { messages?: MuxMessage[] } | undefined;
    const requestMessages = Array.isArray(firstRequest?.messages) ? firstRequest.messages : [];
    const compactionRequestMessage = requestMessages.find(
      (message) => message.metadata?.muxMetadata?.type === "compaction-request"
    );

    expect(compactionRequestMessage?.metadata?.muxMetadata?.requestedModel).toBe(compactionModel);

    session.dispose();
  });

  test("threads providers config into pre-send and mid-stream compaction checks", async () => {
    const workspaceId = "ws-auto-compaction-providers-config";

    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const providersConfig = {
      openai: {
        models: [
          {
            id: "openai:gpt-4o",
            contextWindow: 222_222,
          },
        ],
      },
    } as unknown as ProvidersConfigMap;

    const aiEmitter = new EventEmitter();
    const streamMessage = mock((_history: MuxMessage[]) => {
      const usage = {
        inputTokens: 42,
        outputTokens: 1,
        totalTokens: 43,
      };

      aiEmitter.emit("usage-delta", {
        type: "usage-delta",
        workspaceId,
        messageId: "assistant-providers-config",
        usage,
      });

      aiEmitter.emit("stream-end", {
        type: "stream-end",
        workspaceId,
        messageId: "assistant-providers-config",
        parts: [],
        metadata: {
          model: "openai:gpt-4o",
          contextUsage: usage,
          providerMetadata: {},
        },
      });

      return Promise.resolve(Ok(undefined));
    });

    const aiService = Object.assign(aiEmitter, {
      isStreaming: mock((_workspaceId: string) => false),
      stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
      streamMessage: streamMessage as unknown as (
        ...args: Parameters<AIService["streamMessage"]>
      ) => Promise<unknown>,
    }) as unknown as AIService;

    const initStateManager = new EventEmitter() as unknown as InitStateManager;

    const backgroundProcessManager = {
      cleanup: mock((_workspaceId: string) => Promise.resolve()),
      setMessageQueued: mock((_workspaceId: string, _queued: boolean) => {
        void _queued;
      }),
    } as unknown as BackgroundProcessManager;

    const config = {
      srcDir: "/tmp",
      getSessionDir: (_workspaceId: string) => "/tmp",
      loadProvidersConfig: () => providersConfig,
    } as unknown as Config;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const checkBeforeSend = mock((_params: unknown) => ({
      shouldShowWarning: false,
      shouldForceCompact: false,
      usagePercentage: 0,
      thresholdPercentage: 85,
    }));
    const checkMidStream = mock((_params: unknown) => false);

    (session as unknown as { compactionMonitor: CompactionMonitor }).compactionMonitor = {
      checkBeforeSend,
      checkMidStream,
      resetForNewStream: mock(() => undefined),
      setThreshold: mock(() => undefined),
      getThreshold: mock(() => 0.85),
    } as unknown as CompactionMonitor;

    const result = await session.sendMessage("hello", {
      model: "openai:gpt-4o",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(checkBeforeSend).toHaveBeenCalledTimes(1);
    expect(checkBeforeSend.mock.calls[0]?.[0]).toMatchObject({
      providersConfig,
    });

    expect(checkMidStream).toHaveBeenCalledTimes(1);
    expect(checkMidStream.mock.calls[0]?.[0]).toMatchObject({
      providersConfig,
    });

    session.dispose();
  });

  test("seeds on-send compaction usage from the active compaction epoch only", async () => {
    const workspaceId = "ws-auto-compaction-seed-active-epoch";

    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const oldUsage = {
      inputTokens: 95_000,
      outputTokens: 100,
      totalTokens: 95_100,
    };

    const appendOldUser = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-old-before-boundary", "user", "old prompt", {
        timestamp: Date.now() - 4_000,
      })
    );
    expect(appendOldUser.success).toBe(true);

    const appendOldAssistant = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("assistant-old-before-boundary", "assistant", "old reply", {
        timestamp: Date.now() - 3_000,
        model: "openai:gpt-4o",
        contextUsage: oldUsage,
      })
    );
    expect(appendOldAssistant.success).toBe(true);

    const appendBoundary = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("assistant-compaction-boundary", "assistant", "compacted summary", {
        timestamp: Date.now() - 2_000,
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 7,
      })
    );
    expect(appendBoundary.success).toBe(true);

    const appendCurrentEpochUser = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-after-boundary", "user", "fresh prompt after compaction", {
        timestamp: Date.now() - 1_000,
      })
    );
    expect(appendCurrentEpochUser.success).toBe(true);

    const aiEmitter = new EventEmitter();
    const streamMessage = mock((_history: MuxMessage[]) => Promise.resolve(Ok(undefined)));
    const aiService = Object.assign(aiEmitter, {
      isStreaming: mock((_workspaceId: string) => false),
      stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
      streamMessage: streamMessage as unknown as (
        ...args: Parameters<AIService["streamMessage"]>
      ) => Promise<unknown>,
    }) as unknown as AIService;

    const initStateManager = new EventEmitter() as unknown as InitStateManager;

    const backgroundProcessManager = {
      cleanup: mock((_workspaceId: string) => Promise.resolve()),
      setMessageQueued: mock((_workspaceId: string, _queued: boolean) => {
        void _queued;
      }),
    } as unknown as BackgroundProcessManager;

    const config = {
      srcDir: "/tmp",
      getSessionDir: (_workspaceId: string) => "/tmp",
    } as unknown as Config;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const checkBeforeSend = mock((params: unknown) => {
      expect((params as { usage?: unknown }).usage).toBeUndefined();
      return {
        shouldShowWarning: false,
        shouldForceCompact: false,
        usagePercentage: 0,
        thresholdPercentage: 85,
      };
    });

    (session as unknown as { compactionMonitor: CompactionMonitor }).compactionMonitor = {
      checkBeforeSend,
      checkMidStream: mock(() => false),
      resetForNewStream: mock(() => undefined),
      setThreshold: mock(() => undefined),
      getThreshold: mock(() => 0.85),
    } as unknown as CompactionMonitor;

    const result = await session.sendMessage("new prompt after restart", {
      model: "openai:gpt-4o",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(checkBeforeSend).toHaveBeenCalledTimes(1);

    session.dispose();
  });

  test("surfaces nested dispatch failures after mid-stream compaction interrupt", async () => {
    const workspaceId = "ws-auto-compaction-mid-stream-dispatch-failure";

    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const aiEmitter = new EventEmitter();
    let streamCallCount = 0;
    const streamMessage = mock((_request: unknown) => {
      streamCallCount += 1;
      if (streamCallCount === 1) {
        const usage = {
          inputTokens: 42,
          outputTokens: 1,
          totalTokens: 43,
        };

        aiEmitter.emit("stream-start", {
          type: "stream-start",
          workspaceId,
          messageId: "assistant-mid-stream",
          model: "openai:gpt-4o",
          historySequence: 1,
          startTime: Date.now(),
        });

        aiEmitter.emit("usage-delta", {
          type: "usage-delta",
          workspaceId,
          messageId: "assistant-mid-stream",
          usage,
          cumulativeUsage: usage,
        });
      }

      return Promise.resolve(Ok(undefined));
    });

    const stopStream = mock((_workspaceId: string) => {
      aiEmitter.emit("stream-abort", {
        type: "stream-abort",
        workspaceId,
        messageId: "assistant-mid-stream",
        abortReason: "system",
      });

      return Promise.resolve(Ok(undefined));
    });

    const aiService = Object.assign(aiEmitter, {
      isStreaming: mock((_workspaceId: string) => false),
      stopStream,
      streamMessage: streamMessage as unknown as (
        ...args: Parameters<AIService["streamMessage"]>
      ) => Promise<unknown>,
    }) as unknown as AIService;

    const initStateManager = new EventEmitter() as unknown as InitStateManager;

    const backgroundProcessManager = {
      cleanup: mock((_workspaceId: string) => Promise.resolve()),
      setMessageQueued: mock((_workspaceId: string, _queued: boolean) => {
        void _queued;
      }),
    } as unknown as BackgroundProcessManager;

    const config = {
      srcDir: "/tmp",
      getSessionDir: (_workspaceId: string) => "/tmp",
    } as unknown as Config;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const internals = session as unknown as {
      compactionMonitor: CompactionMonitor;
      sendMessage: AgentSession["sendMessage"];
    };

    let midStreamChecks = 0;
    internals.compactionMonitor = {
      checkBeforeSend: mock(() => ({
        shouldShowWarning: false,
        shouldForceCompact: false,
        usagePercentage: 0,
        thresholdPercentage: 85,
      })),
      checkMidStream: mock((_params: unknown) => {
        midStreamChecks += 1;
        return midStreamChecks === 1;
      }),
      resetForNewStream: mock(() => undefined),
      setThreshold: mock(() => undefined),
      getThreshold: mock(() => 0.85),
    } as unknown as CompactionMonitor;

    const originalSendMessage = session.sendMessage.bind(session);
    let sendCallCount = 0;
    internals.sendMessage = (async (...args: Parameters<AgentSession["sendMessage"]>) => {
      sendCallCount += 1;
      if (sendCallCount === 1) {
        return originalSendMessage(...args);
      }

      return Err({ type: "unknown", raw: "mid-stream compaction dispatch failed" });
    }) as AgentSession["sendMessage"];

    const events: WorkspaceChatMessage[] = [];
    session.onChatEvent(({ message }) => {
      events.push(message);
    });

    const result = await internals.sendMessage("hello", {
      model: "openai:gpt-4o",
      agentId: "exec",
    });

    expect(result.success).toBe(true);

    const deadline = Date.now() + 1500;
    while (!events.some((event) => event.type === "stream-error") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const streamError = events.find(
      (event): event is Extract<WorkspaceChatMessage, { type: "stream-error" }> =>
        event.type === "stream-error"
    );
    expect(streamError).toBeDefined();
    expect(streamError?.error).toContain("mid-stream compaction dispatch failed");
    expect(stopStream).toHaveBeenCalledTimes(1);

    session.dispose();
  });

  test("hides default follow-up sentinel in mid-stream auto-compaction prompts", async () => {
    const workspaceId = "ws-auto-compaction-mid-stream-sentinel";

    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const aiEmitter = new EventEmitter();
    const streamHistories: MuxMessage[][] = [];
    let streamCallCount = 0;
    const streamMessage = mock((request: unknown) => {
      const requestMessages =
        typeof request === "object" && request !== null && "messages" in request
          ? (request as { messages?: unknown }).messages
          : undefined;
      streamHistories.push(Array.isArray(requestMessages) ? (requestMessages as MuxMessage[]) : []);
      streamCallCount += 1;

      if (streamCallCount === 1) {
        const usage = {
          inputTokens: 42,
          outputTokens: 1,
          totalTokens: 43,
        };

        aiEmitter.emit("stream-start", {
          type: "stream-start",
          workspaceId,
          messageId: "assistant-mid-stream",
          model: "openai:gpt-4o",
          historySequence: 1,
          startTime: Date.now(),
        });

        aiEmitter.emit("usage-delta", {
          type: "usage-delta",
          workspaceId,
          messageId: "assistant-mid-stream",
          usage,
          cumulativeUsage: usage,
        });
      }

      return Promise.resolve(Ok(undefined));
    });

    const stopStream = mock((_workspaceId: string) => {
      aiEmitter.emit("stream-abort", {
        type: "stream-abort",
        workspaceId,
        messageId: "assistant-mid-stream",
        abortReason: "system",
      });

      return Promise.resolve(Ok(undefined));
    });

    const aiService = Object.assign(aiEmitter, {
      isStreaming: mock((_workspaceId: string) => false),
      stopStream,
      streamMessage: streamMessage as unknown as (
        ...args: Parameters<AIService["streamMessage"]>
      ) => Promise<unknown>,
    }) as unknown as AIService;

    const initStateManager = new EventEmitter() as unknown as InitStateManager;

    const backgroundProcessManager = {
      cleanup: mock((_workspaceId: string) => Promise.resolve()),
      setMessageQueued: mock((_workspaceId: string, _queued: boolean) => {
        void _queued;
      }),
    } as unknown as BackgroundProcessManager;

    const config = {
      srcDir: "/tmp",
      getSessionDir: (_workspaceId: string) => "/tmp",
    } as unknown as Config;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    let midStreamChecks = 0;
    const checkMidStream = mock((_params: unknown) => {
      midStreamChecks += 1;
      return midStreamChecks === 1;
    });

    (session as unknown as { compactionMonitor: CompactionMonitor }).compactionMonitor = {
      checkBeforeSend: mock(() => ({
        shouldShowWarning: false,
        shouldForceCompact: false,
        usagePercentage: 0,
        thresholdPercentage: 85,
      })),
      checkMidStream,
      resetForNewStream: mock(() => undefined),
      setThreshold: mock(() => undefined),
      getThreshold: mock(() => 0.85),
    } as unknown as CompactionMonitor;

    const result = await session.sendMessage("hello", {
      model: "openai:gpt-4o",
      agentId: "exec",
    });

    expect(result.success).toBe(true);

    const deadline = Date.now() + 1500;
    while (streamHistories.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(streamHistories.length).toBeGreaterThanOrEqual(2);
    const compactionHistory = streamHistories[1];
    const compactionRequestMessage = [...compactionHistory]
      .reverse()
      .find((message) => message.metadata?.muxMetadata?.type === "compaction-request");

    expect(compactionRequestMessage).toBeDefined();

    const compactionRequestText =
      compactionRequestMessage?.parts.find((part) => part.type === "text")?.text ?? "";
    expect(compactionRequestText).not.toContain("The user wants to continue with:");
    expect(compactionRequestText).not.toContain("[CONTINUE]");
    expect(stopStream).toHaveBeenCalledTimes(1);

    session.dispose();
  });
});
