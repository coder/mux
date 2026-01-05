import { describe, expect, test, mock } from "bun:test";
import { AgentSession } from "./agentSession";
import type { Config } from "@/node/config";
import type { HistoryService } from "./historyService";
import type { PartialService } from "./partialService";
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

    const appendDeferred = createDeferred<Result<void>>();
    const historyService: HistoryService = {
      appendToHistory: mock(() => appendDeferred.promise),
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

    const config: Config = { srcDir: "/tmp" } as unknown as Config;
    const partialService: PartialService = {} as unknown as PartialService;

    const session = new AgentSession({
      workspaceId: "ws",
      config,
      historyService,
      partialService,
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

    session.queueMessage("Queued message", { model: "anthropic:claude-sonnet-4-5" });
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
});
