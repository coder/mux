import { describe, expect, test, mock } from "bun:test";
import { AgentSession } from "./agentSession";
import type { Config } from "@/node/config";
import type { HistoryService } from "./historyService";
import type { AIService } from "./aiService";
import type { InitStateManager } from "./initStateManager";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { Result } from "@/common/types/result";
import { Ok } from "@/common/types/result";

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("AgentSession disposal race conditions", () => {
  test("does not crash if disposed while auto-sending a queued message", async () => {
    const aiHandlers = new Map<string, (...args: unknown[]) => void>();

    const streamMessage = mock(() => Promise.resolve(Ok(undefined)));

    const aiService: AIService = {
      on(eventName: string | symbol, listener: (...args: unknown[]) => void) {
        aiHandlers.set(String(eventName), listener);
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      stopStream: mock(() => Promise.resolve(Ok(undefined))),
      isStreaming: mock(() => false),
      streamMessage,
    } as unknown as AIService;

    // Justified mock: deferred promise is essential for testing the dispose-during-write race.
    // A real HistoryService completes appendToHistory synchronously (sub-ms), so we can't
    // reproduce the race window without controlling when the promise resolves.
    const appendDeferred = createDeferred<Result<void>>();
    const historyService: HistoryService = {
      appendToHistory: mock(() => appendDeferred.promise),
      // seedUsageStateFromHistory reads the last few messages on first send;
      // return empty history so the test exercises the real code path.
      getLastMessages: mock(() => Promise.resolve(Ok([]))),
    } as unknown as HistoryService;

    const initStateManager: InitStateManager = {
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as InitStateManager;

    const backgroundProcessManager: BackgroundProcessManager = {
      cleanup: mock(() => Promise.resolve()),
      setMessageQueued: mock(() => undefined),
    } as unknown as BackgroundProcessManager;

    const config: Config = {
      srcDir: "/tmp",
      getSessionDir: mock(() => "/tmp"),
    } as unknown as Config;

    const session = new AgentSession({
      workspaceId: "ws",
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    // Capture the fire-and-forget sendMessage() promise that sendQueuedMessages() creates.
    const originalSendMessage = session.sendMessage.bind(session);
    let inFlight: Promise<unknown> | undefined;
    (session as unknown as { sendMessage: typeof originalSendMessage }).sendMessage = (
      ...args: Parameters<typeof originalSendMessage>
    ) => {
      const promise = originalSendMessage(...args);
      inFlight = promise;
      return promise;
    };

    session.queueMessage("Queued message", {
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
    });
    session.sendQueuedMessages();

    expect(inFlight).toBeDefined();

    // Dispose while sendMessage() is awaiting appendToHistory.
    session.dispose();
    appendDeferred.resolve(Ok(undefined));

    const result = await (inFlight as Promise<Result<void>>);
    expect(result.success).toBe(true);

    // We should not attempt to stream once disposal has begun.
    expect(streamMessage).toHaveBeenCalledTimes(0);

    // Sanity: invoking a forwarded handler after dispose should be a no-op.
    const streamStart = aiHandlers.get("stream-start");
    expect(() =>
      streamStart?.({
        type: "stream-start",
        workspaceId: "ws",
        messageId: "m1",
        model: "anthropic:claude-sonnet-4-5",
        historySequence: 1,
        startTime: Date.now(),
      })
    ).not.toThrow();
  });

  test("does not reset auto-retry intent for synthetic or rejected sends", async () => {
    const aiService: AIService = {
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      stopStream: mock(() => Promise.resolve(Ok(undefined))),
      isStreaming: mock(() => false),
      streamMessage: mock(() => Promise.resolve(Ok(undefined))),
    } as unknown as AIService;

    const historyService: HistoryService = {
      appendToHistory: mock(() => Promise.resolve(Ok(undefined))),
    } as unknown as HistoryService;

    const initStateManager: InitStateManager = {
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as InitStateManager;

    const backgroundProcessManager: BackgroundProcessManager = {
      cleanup: mock(() => Promise.resolve()),
      setMessageQueued: mock(() => undefined),
    } as unknown as BackgroundProcessManager;

    const config: Config = {
      srcDir: "/tmp",
      getSessionDir: mock(() => "/tmp"),
    } as unknown as Config;

    const session = new AgentSession({
      workspaceId: "ws",
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const cancel = mock(() => undefined);
    const setEnabled = mock((_enabled: boolean) => undefined);
    (
      session as unknown as {
        retryManager: {
          cancel: typeof cancel;
          setEnabled: typeof setEnabled;
        };
      }
    ).retryManager = {
      cancel,
      setEnabled,
    };

    const options = {
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
    };

    const syntheticResult = await session.sendMessage("", options, { synthetic: true });
    expect(syntheticResult.success).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(0);
    expect(setEnabled).toHaveBeenCalledTimes(0);

    const userResult = await session.sendMessage("", options);
    expect(userResult.success).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(0);
    expect(setEnabled).toHaveBeenCalledTimes(0);
  });

  test("preserves synthetic flag when flushing queued messages", () => {
    const aiService: AIService = {
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      stopStream: mock(() => Promise.resolve(Ok(undefined))),
      isStreaming: mock(() => false),
      streamMessage: mock(() => Promise.resolve(Ok(undefined))),
    } as unknown as AIService;

    const historyService: HistoryService = {
      appendToHistory: mock(() => Promise.resolve(Ok(undefined))),
    } as unknown as HistoryService;

    const initStateManager: InitStateManager = {
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as InitStateManager;

    const backgroundProcessManager: BackgroundProcessManager = {
      cleanup: mock(() => Promise.resolve()),
      setMessageQueued: mock(() => undefined),
    } as unknown as BackgroundProcessManager;

    const config: Config = {
      srcDir: "/tmp",
      getSessionDir: mock(() => "/tmp"),
    } as unknown as Config;

    const session = new AgentSession({
      workspaceId: "ws",
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const sendMessage = mock(
      (
        _message: string,
        _options?: { model: string; agentId: string },
        _internal?: { synthetic?: boolean }
      ) => Promise.resolve(Ok(undefined))
    );

    (session as unknown as { sendMessage: typeof sendMessage }).sendMessage = sendMessage;

    session.queueMessage(
      "Background compaction request",
      { model: "anthropic:claude-sonnet-4-5", agentId: "compact" },
      { synthetic: true }
    );
    session.sendQueuedMessages();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "Background compaction request",
      expect.objectContaining({ model: "anthropic:claude-sonnet-4-5", agentId: "compact" }),
      { synthetic: true }
    );
  });
});
