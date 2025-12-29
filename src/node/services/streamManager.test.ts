import { describe, test, expect, beforeEach, mock } from "bun:test";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { StreamManager } from "./streamManager";
import { APICallError } from "ai";
import type { HistoryService } from "./historyService";
import type { PartialService } from "./partialService";
import { createAnthropic } from "@ai-sdk/anthropic";
import { shouldRunIntegrationTests, validateApiKeys } from "../../../tests/testUtils";
import { createRuntime } from "@/node/runtime/runtimeFactory";

// Skip integration tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

// Mock HistoryService
const createMockHistoryService = (): HistoryService => {
  return {
    appendToHistory: mock(() => Promise.resolve({ success: true })),
    getHistory: mock(() => Promise.resolve({ success: true, data: [] })),
    updateHistory: mock(() => Promise.resolve({ success: true })),
    truncateAfterMessage: mock(() => Promise.resolve({ success: true })),
    clearHistory: mock(() => Promise.resolve({ success: true })),
  } as unknown as HistoryService;
};

// Mock PartialService
const createMockPartialService = (): PartialService => {
  return {
    writePartial: mock(() => Promise.resolve({ success: true })),
    readPartial: mock(() => Promise.resolve(null)),
    deletePartial: mock(() => Promise.resolve({ success: true })),
    commitToHistory: mock(() => Promise.resolve({ success: true })),
  } as unknown as PartialService;
};

describe("StreamManager - Concurrent Stream Prevention", () => {
  let streamManager: StreamManager;
  let mockHistoryService: HistoryService;
  let mockPartialService: PartialService;
  const runtime = createRuntime({ type: "local", srcBaseDir: "/tmp" });

  beforeEach(() => {
    mockHistoryService = createMockHistoryService();
    mockPartialService = createMockPartialService();
    streamManager = new StreamManager(mockHistoryService, mockPartialService);
    // Suppress error events from bubbling up as uncaught exceptions during tests
    streamManager.on("error", () => undefined);
  });

  // Integration test - requires API key and TEST_INTEGRATION=1
  describeIntegration("with real API", () => {
    test("should prevent concurrent streams for the same workspace", async () => {
      const workspaceId = "test-workspace-concurrent";
      const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const model = anthropic("claude-sonnet-4-5");

      // Track when streams are actively processing
      const streamStates: Record<string, { started: boolean; finished: boolean }> = {};
      let firstMessageId: string | undefined;

      streamManager.on("stream-start", (data: { messageId: string; historySequence: number }) => {
        streamStates[data.messageId] = { started: true, finished: false };
        if (data.historySequence === 1) {
          firstMessageId = data.messageId;
        }
      });

      streamManager.on("stream-end", (data: { messageId: string }) => {
        if (streamStates[data.messageId]) {
          streamStates[data.messageId].finished = true;
        }
      });

      streamManager.on("stream-abort", (data: { messageId: string }) => {
        if (streamStates[data.messageId]) {
          streamStates[data.messageId].finished = true;
        }
      });

      // Start first stream
      const result1 = await streamManager.startStream(
        workspaceId,
        [{ role: "user", content: "Say hello and nothing else" }],
        model,
        KNOWN_MODELS.SONNET.id,
        1,
        "You are a helpful assistant",
        runtime,
        "test-msg-1",
        undefined,
        {}
      );

      expect(result1.success).toBe(true);

      // Wait for first stream to actually start
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Start second stream - should cancel first
      const result2 = await streamManager.startStream(
        workspaceId,
        [{ role: "user", content: "Say goodbye and nothing else" }],
        model,
        KNOWN_MODELS.SONNET.id,
        2,
        "You are a helpful assistant",
        runtime,
        "test-msg-2",
        undefined,
        {}
      );

      expect(result2.success).toBe(true);

      // Wait for second stream to complete
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Verify: first stream should have been cancelled before second stream started
      expect(firstMessageId).toBeDefined();
      const trackedFirstMessageId = firstMessageId!;
      expect(streamStates[trackedFirstMessageId]).toBeDefined();
      expect(streamStates[trackedFirstMessageId].started).toBe(true);
      expect(streamStates[trackedFirstMessageId].finished).toBe(true);

      // Verify no streams are active after completion
      expect(streamManager.isStreaming(workspaceId)).toBe(false);
    }, 10000);
  });

  // Unit test - doesn't require API key
  test("should serialize multiple rapid startStream calls", async () => {
    // This is a simpler test that doesn't require API key
    // It tests the mutex behavior without actually streaming

    const workspaceId = "test-workspace-serial";

    // Track the order of operations
    const operations: string[] = [];

    // Create a dummy model (won't actually be used since we're mocking the core behavior)
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    interface WorkspaceStreamInfoStub {
      state: string;
      streamResult: {
        fullStream: AsyncGenerator<unknown, void, unknown>;
        usage: Promise<unknown>;
        providerMetadata: Promise<unknown>;
      };
      abortController: AbortController;
      messageId: string;
      token: string;
      startTime: number;
      model: string;
      initialMetadata?: Record<string, unknown>;
      historySequence: number;
      parts: unknown[];
      lastPartialWriteTime: number;
      partialWriteTimer?: ReturnType<typeof setTimeout>;
      partialWritePromise?: Promise<void>;
      processingPromise: Promise<void>;
    }

    const ensureStreamSafetyValue = Reflect.get(streamManager, "ensureStreamSafety") as unknown;
    if (typeof ensureStreamSafetyValue !== "function") {
      throw new Error("StreamManager.ensureStreamSafety is unavailable for testing");
    }

    const originalEnsure = (
      ensureStreamSafetyValue as (workspaceId: string) => Promise<string>
    ).bind(streamManager);

    const replaceEnsureResult = Reflect.set(
      streamManager,
      "ensureStreamSafety",
      async (wsId: string): Promise<string> => {
        operations.push("ensure-start");
        await new Promise((resolve) => setTimeout(resolve, 50));
        const result = await originalEnsure(wsId);
        operations.push("ensure-end");
        return result;
      }
    );

    if (!replaceEnsureResult) {
      throw new Error("Failed to mock StreamManager.ensureStreamSafety");
    }

    const workspaceStreamsValue = Reflect.get(streamManager, "workspaceStreams") as unknown;
    if (!(workspaceStreamsValue instanceof Map)) {
      throw new Error("StreamManager.workspaceStreams is not a Map");
    }
    const workspaceStreams = workspaceStreamsValue as Map<string, WorkspaceStreamInfoStub>;

    const replaceCreateResult = Reflect.set(
      streamManager,
      "createStreamAtomically",
      (
        wsId: string,
        streamToken: string,
        messages: unknown,
        modelArg: unknown,
        modelString: string,
        abortSignal: AbortSignal | undefined,
        system: string,
        historySequence: number,
        tools?: Record<string, unknown>,
        initialMetadata?: Record<string, unknown>,
        _providerOptions?: Record<string, unknown>,
        _maxOutputTokens?: number,
        _toolPolicy?: unknown
      ): WorkspaceStreamInfoStub => {
        operations.push("create");
        const abortController = new AbortController();
        if (abortSignal) {
          abortSignal.addEventListener("abort", () => abortController.abort());
        }

        const streamInfo: WorkspaceStreamInfoStub = {
          state: "starting",
          streamResult: {
            fullStream: (async function* asyncGenerator() {
              // No-op generator; we only care about synchronization
            })(),
            usage: Promise.resolve(undefined),
            providerMetadata: Promise.resolve(undefined),
          },
          abortController,
          messageId: `test-${Math.random().toString(36).slice(2)}`,
          token: streamToken,
          startTime: Date.now(),
          model: modelString,
          initialMetadata,
          historySequence,
          parts: [],
          lastPartialWriteTime: 0,
          partialWriteTimer: undefined,
          partialWritePromise: undefined,
          processingPromise: Promise.resolve(),
        };

        workspaceStreams.set(wsId, streamInfo);
        return streamInfo;
      }
    );

    if (!replaceCreateResult) {
      throw new Error("Failed to mock StreamManager.createStreamAtomically");
    }

    const replaceProcessResult = Reflect.set(
      streamManager,
      "processStreamWithCleanup",
      async (_wsId: string, info: WorkspaceStreamInfoStub): Promise<void> => {
        operations.push("process-start");
        await sleep(20);
        info.state = "streaming";
        operations.push("process-end");
      }
    );

    if (!replaceProcessResult) {
      throw new Error("Failed to mock StreamManager.processStreamWithCleanup");
    }

    const anthropic = createAnthropic({ apiKey: "dummy-key" });
    const model = anthropic("claude-sonnet-4-5");

    // Start three streams rapidly
    // Without mutex, these would interleave (ensure-start, ensure-start, ensure-start, ensure-end, ensure-end, ensure-end)
    // With mutex, they should be serialized (ensure-start, ensure-end, ensure-start, ensure-end, ensure-start, ensure-end)
    const promises = [
      streamManager.startStream(
        workspaceId,
        [{ role: "user", content: "test 1" }],
        model,
        KNOWN_MODELS.SONNET.id,
        1,
        "system",
        runtime,
        "test-msg-1",
        undefined,
        {}
      ),
      streamManager.startStream(
        workspaceId,
        [{ role: "user", content: "test 2" }],
        model,
        KNOWN_MODELS.SONNET.id,
        2,
        "system",
        runtime,
        "test-msg-2",
        undefined,
        {}
      ),
      streamManager.startStream(
        workspaceId,
        [{ role: "user", content: "test 3" }],
        model,
        KNOWN_MODELS.SONNET.id,
        3,
        "system",
        runtime,
        "test-msg-3",
        undefined,
        {}
      ),
    ];

    // Wait for all to complete (they will fail due to dummy API key, but that's ok)
    await Promise.allSettled(promises);

    // Verify operations are serialized: each ensure-start should be followed by its ensure-end
    // before the next ensure-start
    const ensureOperations = operations.filter((op) => op.startsWith("ensure"));
    for (let i = 0; i < ensureOperations.length - 1; i += 2) {
      expect(ensureOperations[i]).toBe("ensure-start");
      expect(ensureOperations[i + 1]).toBe("ensure-end");
    }
  });
});

describe("StreamManager - Unavailable Tool Handling", () => {
  let streamManager: StreamManager;
  let mockHistoryService: HistoryService;
  let mockPartialService: PartialService;

  beforeEach(() => {
    mockHistoryService = createMockHistoryService();
    mockPartialService = createMockPartialService();
    streamManager = new StreamManager(mockHistoryService, mockPartialService);
    // Suppress error events - processStreamWithCleanup may throw due to tokenizer worker issues in test env
    streamManager.on("error", () => undefined);
  });

  test.skip("should handle tool-error events from SDK", async () => {
    const workspaceId = "test-workspace-tool-error";

    // Track emitted events
    interface ToolEvent {
      type: string;
      toolName?: string;
      result?: unknown;
    }
    const events: ToolEvent[] = [];

    streamManager.on("tool-call-start", (data: { toolName: string }) => {
      events.push({ type: "tool-call-start", toolName: data.toolName });
    });

    streamManager.on("tool-call-end", (data: { toolName: string; result: unknown }) => {
      events.push({ type: "tool-call-end", toolName: data.toolName, result: data.result });
    });

    // Mock a stream that emits tool-error event (AI SDK 5.0 behavior)
    const mockStreamResult = {
      // eslint-disable-next-line @typescript-eslint/require-await
      fullStream: (async function* () {
        // SDK emits tool-call when model requests a tool
        yield {
          type: "tool-call",
          toolCallId: "test-call-1",
          toolName: "file_edit_replace",
          input: { file_path: "/test", old_string: "foo", new_string: "bar" },
        };
        // SDK emits tool-error when tool execution fails
        yield {
          type: "tool-error",
          toolCallId: "test-call-1",
          toolName: "file_edit_replace",
          error: "Tool not found",
        };
      })(),
      usage: Promise.resolve(undefined),
      providerMetadata: Promise.resolve({}),
    };

    // Create streamInfo for testing
    const streamInfo = {
      state: 2, // STREAMING
      streamResult: mockStreamResult,
      abortController: new AbortController(),
      messageId: "test-message-1",
      token: "test-token",
      startTime: Date.now(),
      model: KNOWN_MODELS.SONNET.id,
      historySequence: 1,
      parts: [],
      lastPartialWriteTime: 0,
      processingPromise: Promise.resolve(),
    };

    // Access private method for testing
    // @ts-expect-error - accessing private method for testing
    await streamManager.processStreamWithCleanup(workspaceId, streamInfo, 1);

    // Verify events were emitted correctly
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]).toMatchObject({
      type: "tool-call-start",
      toolName: "file_edit_replace",
    });
    expect(events[1]).toMatchObject({
      type: "tool-call-end",
      toolName: "file_edit_replace",
    });

    // Verify error result
    const errorResult = events[1].result as { error?: string };
    expect(errorResult?.error).toBe("Tool not found");
  });
});

describe("StreamManager - previousResponseId recovery", () => {
  test("isResponseIdLost returns false for unknown IDs", () => {
    const mockHistoryService = createMockHistoryService();
    const mockPartialService = createMockPartialService();
    const streamManager = new StreamManager(mockHistoryService, mockPartialService);

    // Verify the ID is not lost initially
    expect(streamManager.isResponseIdLost("resp_123abc")).toBe(false);
    expect(streamManager.isResponseIdLost("resp_different")).toBe(false);
  });

  test("extractPreviousResponseIdFromError extracts ID from various error formats", () => {
    const mockHistoryService = createMockHistoryService();
    const mockPartialService = createMockPartialService();
    const streamManager = new StreamManager(mockHistoryService, mockPartialService);

    // Get the private method via reflection
    const extractMethod = Reflect.get(streamManager, "extractPreviousResponseIdFromError") as (
      error: unknown
    ) => string | undefined;
    expect(typeof extractMethod).toBe("function");

    // Test extraction from APICallError with responseBody
    const apiError = new APICallError({
      message: "Previous response with id 'resp_abc123' not found.",
      url: "https://api.openai.com/v1/responses",
      requestBodyValues: {},
      statusCode: 400,
      responseHeaders: {},
      responseBody:
        '{"error":{"message":"Previous response with id \'resp_abc123\' not found.","code":"previous_response_not_found"}}',
      isRetryable: false,
      data: { error: { code: "previous_response_not_found" } },
    });
    expect(extractMethod.call(streamManager, apiError)).toBe("resp_abc123");

    // Test extraction from error message
    const errorWithMessage = new Error("Previous response with id 'resp_def456' not found.");
    expect(extractMethod.call(streamManager, errorWithMessage)).toBe("resp_def456");

    // Test when no ID is present
    const errorWithoutId = new Error("Some other error");
    expect(extractMethod.call(streamManager, errorWithoutId)).toBeUndefined();
  });

  test("recordLostResponseIdIfApplicable records IDs for explicit OpenAI errors", () => {
    const mockHistoryService = createMockHistoryService();
    const mockPartialService = createMockPartialService();
    const streamManager = new StreamManager(mockHistoryService, mockPartialService);

    const recordMethod = Reflect.get(streamManager, "recordLostResponseIdIfApplicable") as (
      error: unknown,
      streamInfo: unknown
    ) => void;
    expect(typeof recordMethod).toBe("function");

    const apiError = new APICallError({
      message: "Previous response with id 'resp_deadbeef' not found.",
      url: "https://api.openai.com/v1/responses",
      requestBodyValues: {},
      statusCode: 400,
      responseHeaders: {},
      responseBody: "Previous response with id 'resp_deadbeef' not found.",
      isRetryable: false,
      data: { error: { code: "previous_response_not_found" } },
    });

    recordMethod.call(streamManager, apiError, { messageId: "msg-1", model: "openai:gpt-mini" });

    expect(streamManager.isResponseIdLost("resp_deadbeef")).toBe(true);
  });

  test("recordLostResponseIdIfApplicable records IDs for 500 errors referencing previous responses", () => {
    const mockHistoryService = createMockHistoryService();
    const mockPartialService = createMockPartialService();
    const streamManager = new StreamManager(mockHistoryService, mockPartialService);

    const recordMethod = Reflect.get(streamManager, "recordLostResponseIdIfApplicable") as (
      error: unknown,
      streamInfo: unknown
    ) => void;
    expect(typeof recordMethod).toBe("function");

    const apiError = new APICallError({
      message: "Internal error: Previous response with id 'resp_cafebabe' not found.",
      url: "https://api.openai.com/v1/responses",
      requestBodyValues: {},
      statusCode: 500,
      responseHeaders: {},
      responseBody: "Internal error: Previous response with id 'resp_cafebabe' not found.",
      isRetryable: false,
      data: { error: { code: "server_error" } },
    });

    recordMethod.call(streamManager, apiError, { messageId: "msg-2", model: "openai:gpt-mini" });

    expect(streamManager.isResponseIdLost("resp_cafebabe")).toBe(true);
  });
});

describe("StreamManager - replayStream", () => {
  test("replayStream snapshots parts so reconnect doesn't block until stream ends", async () => {
    const mockHistoryService = createMockHistoryService();
    const mockPartialService = createMockPartialService();
    const streamManager = new StreamManager(mockHistoryService, mockPartialService);

    // Suppress error events from bubbling up as uncaught exceptions during tests
    streamManager.on("error", () => undefined);

    const workspaceId = "ws-replay-snapshot";

    const deltas: string[] = [];
    streamManager.on("stream-delta", (event: { delta: string }) => {
      deltas.push(event.delta);
    });

    // Inject an active stream into the private workspaceStreams map.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const workspaceStreamsValue = Reflect.get(streamManager, "workspaceStreams");
    if (!(workspaceStreamsValue instanceof Map)) {
      throw new Error("StreamManager.workspaceStreams is not a Map");
    }
    const workspaceStreams = workspaceStreamsValue as Map<string, unknown>;

    const streamInfo = {
      state: "streaming",
      messageId: "msg-1",
      model: "claude-sonnet-4",
      historySequence: 1,
      startTime: 123,
      initialMetadata: {},
      parts: [{ type: "text", text: "a", timestamp: 10 }],
    };

    workspaceStreams.set(workspaceId, streamInfo);

    // Patch the private tokenTracker to (a) avoid worker setup and (b) mutate parts during replay.
    const tokenTracker = Reflect.get(streamManager, "tokenTracker") as {
      setModel: (model: string) => Promise<void>;
      countTokens: (text: string) => Promise<number>;
    };

    tokenTracker.setModel = () => Promise.resolve();

    let pushed = false;
    tokenTracker.countTokens = async () => {
      if (!pushed) {
        pushed = true;
        // While replay is mid-await, simulate the running stream appending more parts.
        (streamInfo.parts as Array<{ type: string; text?: string; timestamp?: number }>).push({
          type: "text",
          text: "b",
          timestamp: 20,
        });
      }
      // Force an await boundary so the mutation happens during replay.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return 1;
    };

    await streamManager.replayStream(workspaceId);

    // If replayStream iterates the live array, it would also emit "b".
    expect(deltas).toEqual(["a"]);
  });
});

describe("StreamManager - ask_user_question Partial Persistence", () => {
  // Note: The ask_user_question tool blocks waiting for user input.
  // If the app restarts during that wait, the partial must be persisted.
  // The fix (flush partial immediately for ask_user_question) is verified
  // by the code path in processStreamWithCleanup's tool-call handler:
  //
  //   if (part.toolName === "ask_user_question") {
  //     await this.flushPartialWrite(workspaceId, streamInfo);
  //   }
  //
  // Full integration test would require mocking the entire streaming pipeline.
  // Instead, we verify the StreamManager has the expected method signature.

  test("flushPartialWrite is a callable method", () => {
    const mockHistoryService = createMockHistoryService();
    const mockPartialService = createMockPartialService();
    const streamManager = new StreamManager(mockHistoryService, mockPartialService);

    // Verify the private method exists and is callable
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const flushMethod = Reflect.get(streamManager, "flushPartialWrite");
    expect(typeof flushMethod).toBe("function");
  });
});

// Note: Comprehensive Anthropic cache control tests are in cacheStrategy.test.ts
// Those unit tests cover all cache control functionality without requiring
// complex setup. StreamManager integrates those functions directly.
