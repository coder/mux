import { describe, expect, it, mock, afterEach } from "bun:test";
import { EventEmitter } from "events";
import { PROVIDER_DISPLAY_NAMES } from "@/common/constants/providers";
import type { Config } from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { SendMessageError } from "@/common/types/errors";
import type { MuxMessage } from "@/common/types/message";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import type { StreamErrorMessage, WorkspaceChatMessage } from "@/common/orpc/types";
import { AgentSession } from "./agentSession";
import { createTestHistoryService } from "./testHistoryService";

async function createReplaySessionHarness(workspaceId: string) {
  const config = {
    srcDir: "/tmp",
    getSessionDir: (_workspaceId: string) => "/tmp",
  } as unknown as Config;

  const { historyService, cleanup } = await createTestHistoryService();

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
    getStreamInfo: mock((_workspaceId: string) => undefined),
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

  return { session, cleanup, replayInit, replayStream };
}
describe("AgentSession pre-stream errors", () => {
  let historyCleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await historyCleanup?.();
  });

  it("emits stream-error when stream startup fails", async () => {
    const workspaceId = "ws-test";

    const config = {
      srcDir: "/tmp",
      getSessionDir: (_workspaceId: string) => "/tmp",
    } as unknown as Config;

    const { historyService, cleanup } = await createTestHistoryService();
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
