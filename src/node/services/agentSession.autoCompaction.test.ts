import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";

import type { ProvidersConfigMap, WorkspaceChatMessage } from "@/common/orpc/types";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { Ok } from "@/common/types/result";
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
