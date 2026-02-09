import { describe, expect, mock, test } from "bun:test";

import { StreamManager } from "./streamManager";

import type { HistoryService } from "./historyService";
import type { PartialService } from "./partialService";

describe("StreamManager - model-only tool notifications", () => {
  test("strips __mux_notifications before emitting tool-call-end", async () => {
    const historyService: HistoryService = {
      appendToHistory: mock(() => Promise.resolve({ success: true })),
      getHistoryFromLatestBoundary: mock(() => Promise.resolve({ success: true, data: [] })),
      getLastMessages: mock(() => Promise.resolve({ success: true as const, data: [] })),
      updateHistory: mock(() => Promise.resolve({ success: true })),
      truncateAfterMessage: mock(() => Promise.resolve({ success: true })),
      clearHistory: mock(() => Promise.resolve({ success: true })),
    } as unknown as HistoryService;

    const partialService: PartialService = {
      writePartial: mock(() => Promise.resolve({ success: true })),
      readPartial: mock(() => Promise.resolve(null)),
      deletePartial: mock(() => Promise.resolve({ success: true })),
      commitToHistory: mock(() => Promise.resolve({ success: true })),
    } as unknown as PartialService;

    const streamManager = new StreamManager(historyService, partialService);

    // Avoid tokenizer worker usage in unit tests.
    (streamManager as unknown as { tokenTracker: unknown }).tokenTracker = {
      // eslint-disable-next-line @typescript-eslint/require-await
      setModel: async () => undefined,
      // eslint-disable-next-line @typescript-eslint/require-await
      countTokens: async () => 0,
    };

    const events: Array<{ toolName?: string; result?: unknown }> = [];
    streamManager.on("tool-call-end", (data: { toolName: string; result: unknown }) => {
      events.push({ toolName: data.toolName, result: data.result });
    });

    const mockStreamResult = {
      // eslint-disable-next-line @typescript-eslint/require-await
      fullStream: (async function* () {
        yield {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "bash",
          input: { script: "echo hi" },
        };

        yield {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "bash",
          output: {
            ok: true,
            __mux_notifications: ["<notification>hello</notification>"],
          },
        };
      })(),
      totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      providerMetadata: Promise.resolve({}),
      steps: Promise.resolve([]),
    };

    const streamInfo = {
      state: 2, // STREAMING
      streamResult: mockStreamResult,
      abortController: new AbortController(),
      messageId: "test-message-1",
      token: "test-token",
      startTime: Date.now(),
      model: "noop:model",
      historySequence: 1,
      parts: [],
      lastPartialWriteTime: 0,
      partialWritePromise: undefined,
      partialWriteTimer: undefined,
      processingPromise: Promise.resolve(),
      softInterrupt: { pending: false },
      runtimeTempDir: "", // Skip cleanup rm -rf
      runtime: {},
      cumulativeUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      cumulativeProviderMetadata: undefined,
      lastStepUsage: undefined,
      lastStepProviderMetadata: undefined,
    };

    const method = Reflect.get(streamManager, "processStreamWithCleanup") as unknown;
    expect(typeof method).toBe("function");

    await (
      method as (workspaceId: string, streamInfo: unknown, historySequence: number) => Promise<void>
    ).call(streamManager, "test-workspace", streamInfo, 1);

    const toolEnd = events.find((e) => e.toolName === "bash");
    expect(toolEnd).toBeDefined();

    expect(toolEnd?.result && typeof toolEnd.result === "object").toBe(true);
    expect("__mux_notifications" in (toolEnd!.result as Record<string, unknown>)).toBe(false);
  });
});
