import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import * as fs from "node:fs/promises";

import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { StreamManager, stripEncryptedContent } from "./streamManager";
import { APICallError, RetryError, type ModelMessage } from "ai";
import type { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";
import { createAnthropic } from "@ai-sdk/anthropic";
import { shouldRunIntegrationTests, validateApiKeys } from "../../../tests/testUtils";
import { DisposableTempDir } from "@/node/services/tempDir";
import { createRuntime } from "@/node/runtime/runtimeFactory";

// Skip integration tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

// Real HistoryService backed by a temp directory (created fresh per test)
let historyService: HistoryService;
let historyCleanup: () => Promise<void>;

beforeEach(async () => {
  ({ historyService, cleanup: historyCleanup } = await createTestHistoryService());
});

afterEach(async () => {
  await historyCleanup();
});

describe("StreamManager - createTempDirForStream", () => {
  test("creates ~/.mux-tmp/<token> under the runtime's home", async () => {
    using home = new DisposableTempDir("stream-home");

    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;

    process.env.HOME = home.path;
    process.env.USERPROFILE = home.path;

    try {
      const streamManager = new StreamManager(historyService);
      const runtime = createRuntime({ type: "local", srcBaseDir: "/tmp" });

      const token = streamManager.generateStreamToken();
      const resolved = await streamManager.createTempDirForStream(token, runtime);

      // StreamManager normalizes Windows paths to forward slashes.
      const normalizedHomePath = home.path.replace(/\\/g, "/");
      expect(resolved.startsWith(normalizedHomePath)).toBe(true);
      expect(resolved).toContain(`/.mux-tmp/${token}`);

      const stat = await fs.stat(resolved);
      expect(stat.isDirectory()).toBe(true);
    } finally {
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }

      if (prevUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = prevUserProfile;
      }
    }
  });
});

describe("StreamManager - stopWhen configuration", () => {
  type StopWhenCondition = (options: { steps: unknown[] }) => boolean;
  type BuildStopWhenCondition = (request: {
    toolChoice?: { type: "tool"; toolName: string } | "required";
    hasQueuedMessage?: () => boolean;
    stopAfterSuccessfulProposePlan?: boolean;
  }) => StopWhenCondition | StopWhenCondition[];

  test("uses single-step stopWhen when a tool is required", () => {
    const streamManager = new StreamManager(historyService);
    const buildStopWhen = Reflect.get(streamManager, "createStopWhenCondition") as
      | BuildStopWhenCondition
      | undefined;
    expect(typeof buildStopWhen).toBe("function");

    const stopWhen = buildStopWhen!({ toolChoice: { type: "tool", toolName: "bash" } });
    if (typeof stopWhen !== "function") {
      throw new Error("Expected required-tool stopWhen to be a single condition function");
    }

    expect(stopWhen({ steps: [] })).toBe(false);
    expect(stopWhen({ steps: [{}] })).toBe(true);
    expect(stopWhen({ steps: [{}, {}] })).toBe(false);
  });

  test("uses autonomous step cap and queued-message interrupt conditions", () => {
    const streamManager = new StreamManager(historyService);
    const buildStopWhen = Reflect.get(streamManager, "createStopWhenCondition") as
      | BuildStopWhenCondition
      | undefined;
    expect(typeof buildStopWhen).toBe("function");

    let queued = false;
    const stopWhen = buildStopWhen!({ hasQueuedMessage: () => queued });
    if (!Array.isArray(stopWhen)) {
      throw new Error("Expected autonomous stopWhen to be an array of conditions");
    }
    expect(stopWhen).toHaveLength(4);

    const [maxStepCondition, queuedMessageCondition, agentReportCondition, switchAgentCondition] =
      stopWhen;
    expect(maxStepCondition({ steps: new Array(99999) })).toBe(false);
    expect(maxStepCondition({ steps: new Array(100000) })).toBe(true);

    expect(queuedMessageCondition({ steps: [] })).toBe(false);
    queued = true;
    expect(queuedMessageCondition({ steps: [] })).toBe(true);

    expect(
      agentReportCondition({
        steps: [{ toolResults: [{ toolName: "agent_report", output: { success: true } }] }],
      })
    ).toBe(true);

    expect(
      switchAgentCondition({
        steps: [{ toolResults: [{ toolName: "switch_agent", output: { ok: true } }] }],
      })
    ).toBe(true);
  });

  test("stops only after successful agent_report tool result in autonomous mode", () => {
    const streamManager = new StreamManager(historyService);
    const buildStopWhen = Reflect.get(streamManager, "createStopWhenCondition") as
      | BuildStopWhenCondition
      | undefined;
    expect(typeof buildStopWhen).toBe("function");

    const stopWhen = buildStopWhen!({ hasQueuedMessage: () => false });
    if (!Array.isArray(stopWhen)) {
      throw new Error("Expected autonomous stopWhen to be an array of conditions");
    }

    const [, , reportStop] = stopWhen;
    if (!reportStop) {
      throw new Error("Expected autonomous stopWhen to include agent_report condition");
    }

    // Returns true when step contains successful agent_report tool result.
    expect(
      reportStop({
        steps: [{ toolResults: [{ toolName: "agent_report", output: { success: true } }] }],
      })
    ).toBe(true);

    // Returns false when step contains failed agent_report output.
    expect(
      reportStop({
        steps: [{ toolResults: [{ toolName: "agent_report", output: { success: false } }] }],
      })
    ).toBe(false);

    // Returns false when step only contains agent_report tool call (no successful result yet).
    expect(
      reportStop({
        steps: [{ toolCalls: [{ toolName: "agent_report" }] }],
      })
    ).toBe(false);

    // Returns false when step contains other tool results.
    expect(
      reportStop({
        steps: [{ toolResults: [{ toolName: "bash", output: { success: true } }] }],
      })
    ).toBe(false);

    // Returns false when no steps.
    expect(reportStop({ steps: [] })).toBe(false);
  });

  test("stops only after successful switch_agent tool result in autonomous mode", () => {
    const streamManager = new StreamManager(historyService);
    const buildStopWhen = Reflect.get(streamManager, "createStopWhenCondition") as
      | BuildStopWhenCondition
      | undefined;
    expect(typeof buildStopWhen).toBe("function");

    const stopWhen = buildStopWhen!({ hasQueuedMessage: () => false });
    if (!Array.isArray(stopWhen)) {
      throw new Error("Expected autonomous stopWhen to be an array of conditions");
    }

    const [, , , switchStop] = stopWhen;
    if (!switchStop) {
      throw new Error("Expected autonomous stopWhen to include switch_agent condition");
    }

    // Returns true when step contains successful switch_agent tool result.
    expect(
      switchStop({
        steps: [{ toolResults: [{ toolName: "switch_agent", output: { ok: true } }] }],
      })
    ).toBe(true);

    // Returns false when step contains failed switch_agent output.
    expect(
      switchStop({
        steps: [{ toolResults: [{ toolName: "switch_agent", output: { ok: false } }] }],
      })
    ).toBe(false);

    // Returns false when step only contains switch_agent tool call (no successful result yet).
    expect(
      switchStop({
        steps: [{ toolCalls: [{ toolName: "switch_agent" }] }],
      })
    ).toBe(false);

    // Returns false when step contains other tool results.
    expect(
      switchStop({
        steps: [{ toolResults: [{ toolName: "bash", output: { ok: true } }] }],
      })
    ).toBe(false);

    // Returns false when no steps.
    expect(switchStop({ steps: [] })).toBe(false);
  });

  test("stops when propose_plan succeeds and flag is enabled", () => {
    const streamManager = new StreamManager(historyService);
    const buildStopWhen = Reflect.get(streamManager, "createStopWhenCondition") as
      | BuildStopWhenCondition
      | undefined;
    expect(typeof buildStopWhen).toBe("function");

    const stopWhen = buildStopWhen!({
      hasQueuedMessage: () => false,
      stopAfterSuccessfulProposePlan: true,
    });
    if (!Array.isArray(stopWhen)) {
      throw new Error("Expected autonomous stopWhen to be an array of conditions");
    }
    expect(stopWhen).toHaveLength(5);

    const proposePlanSuccessSteps = [
      {
        toolResults: [
          {
            toolName: "propose_plan",
            output: { success: true, planPath: "/tmp/plan.md" },
          },
        ],
      },
    ];

    const proposePlanCondition = stopWhen[4];
    if (!proposePlanCondition) {
      throw new Error("Expected stopWhen to include propose_plan condition");
    }

    expect(proposePlanCondition({ steps: proposePlanSuccessSteps })).toBe(true);
    expect(stopWhen.some((condition) => condition({ steps: proposePlanSuccessSteps }))).toBe(true);
  });

  test("does not stop when propose_plan fails", () => {
    const streamManager = new StreamManager(historyService);
    const buildStopWhen = Reflect.get(streamManager, "createStopWhenCondition") as
      | BuildStopWhenCondition
      | undefined;
    expect(typeof buildStopWhen).toBe("function");

    const stopWhen = buildStopWhen!({
      hasQueuedMessage: () => false,
      stopAfterSuccessfulProposePlan: true,
    });
    if (!Array.isArray(stopWhen)) {
      throw new Error("Expected autonomous stopWhen to be an array of conditions");
    }

    const proposePlanFailedSteps = [
      {
        toolResults: [
          {
            toolName: "propose_plan",
            output: { success: false },
          },
        ],
      },
    ];

    const proposePlanCondition = stopWhen[4];
    if (!proposePlanCondition) {
      throw new Error("Expected stopWhen to include propose_plan condition");
    }

    expect(proposePlanCondition({ steps: proposePlanFailedSteps })).toBe(false);
    expect(stopWhen.some((condition) => condition({ steps: proposePlanFailedSteps }))).toBe(false);
  });

  test("does not stop for propose_plan when flag is false/absent", () => {
    const streamManager = new StreamManager(historyService);
    const buildStopWhen = Reflect.get(streamManager, "createStopWhenCondition") as
      | BuildStopWhenCondition
      | undefined;
    expect(typeof buildStopWhen).toBe("function");

    const proposePlanSuccessSteps = [
      {
        toolResults: [
          {
            toolName: "propose_plan",
            output: { success: true, planPath: "/tmp/plan.md" },
          },
        ],
      },
    ];

    const stopWhenWithoutProposePlanFlag = [
      buildStopWhen!({ hasQueuedMessage: () => false, stopAfterSuccessfulProposePlan: false }),
      buildStopWhen!({ hasQueuedMessage: () => false }),
    ];

    for (const stopWhen of stopWhenWithoutProposePlanFlag) {
      if (!Array.isArray(stopWhen)) {
        throw new Error("Expected autonomous stopWhen to be an array of conditions");
      }
      expect(stopWhen).toHaveLength(4);
      expect(stopWhen.some((condition) => condition({ steps: proposePlanSuccessSteps }))).toBe(
        false
      );
    }
  });

  test("treats missing queued-message callback as not queued", () => {
    const streamManager = new StreamManager(historyService);
    const buildStopWhen = Reflect.get(streamManager, "createStopWhenCondition") as
      | BuildStopWhenCondition
      | undefined;
    expect(typeof buildStopWhen).toBe("function");

    const stopWhen = buildStopWhen!({});
    if (!Array.isArray(stopWhen)) {
      throw new Error("Expected autonomous stopWhen to remain array-based without callback");
    }

    const [, queuedMessageCondition] = stopWhen;
    expect(queuedMessageCondition({ steps: [] })).toBe(false);
  });
});

describe("StreamManager - stripEncryptedContent", () => {
  test("strips encryptedContent from array output shape", () => {
    const output = [
      {
        url: "https://example.com/a",
        title: "Result A",
        pageAge: "2d",
        encryptedContent: "secret-a",
      },
      {
        url: "https://example.com/b",
        title: "Result B",
      },
      "non-object-item",
    ];

    expect(stripEncryptedContent(output)).toEqual([
      {
        url: "https://example.com/a",
        title: "Result A",
        pageAge: "2d",
      },
      {
        url: "https://example.com/b",
        title: "Result B",
      },
      "non-object-item",
    ]);
  });

  test("strips encryptedContent from json value output shape", () => {
    const output = {
      type: "json",
      value: [
        {
          url: "https://example.com/c",
          title: "Result C",
          encryptedContent: "secret-c",
        },
        {
          url: "https://example.com/d",
          title: "Result D",
          pageAge: "5h",
        },
      ],
      source: "web_search",
    };

    expect(stripEncryptedContent(output)).toEqual({
      type: "json",
      value: [
        {
          url: "https://example.com/c",
          title: "Result C",
        },
        {
          url: "https://example.com/d",
          title: "Result D",
          pageAge: "5h",
        },
      ],
      source: "web_search",
    });
  });
});

describe("StreamManager - Concurrent Stream Prevention", () => {
  let streamManager: StreamManager;
  const runtime = createRuntime({ type: "local", srcBaseDir: "/tmp" });

  beforeEach(() => {
    streamManager = new StreamManager(historyService);
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

    const replaceEnsureResult = Reflect.set(
      streamManager,
      "ensureStreamSafety",
      async (_wsId: string): Promise<string> => {
        operations.push("ensure-start");
        await new Promise((resolve) => setTimeout(resolve, 50));
        operations.push("ensure-end");
        return "test-token";
      }
    );

    const replaceTempDirResult = Reflect.set(
      streamManager,
      "createTempDirForStream",
      (_streamToken: string, _runtime: unknown): Promise<string> => {
        return Promise.resolve("/tmp/mock-stream-temp");
      }
    );

    if (!replaceTempDirResult) {
      throw new Error("Failed to mock StreamManager.createTempDirForStream");
    }
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
        _runtimeTempDir: string,
        _runtime: unknown,
        _messages: unknown,
        _modelArg: unknown,
        modelString: string,
        abortController: AbortController,
        _system: string,
        historySequence: number,
        _messageId: string,
        _tools?: Record<string, unknown>,
        initialMetadata?: Record<string, unknown>,
        _providerOptions?: Record<string, unknown>,
        _maxOutputTokens?: number,
        _toolPolicy?: unknown
      ): WorkspaceStreamInfoStub => {
        operations.push("create");

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

  test("should honor abortSignal before atomic stream creation", async () => {
    const workspaceId = "test-workspace-abort-before-create";

    let createCalled = false;
    let processCalled = false;
    let streamStartEmitted = false;

    streamManager.on("stream-start", () => {
      streamStartEmitted = true;
    });

    const abortController = new AbortController();

    let tempDirStartedResolve: (() => void) | undefined;
    const tempDirStarted = new Promise<void>((resolve) => {
      tempDirStartedResolve = resolve;
    });

    const replaceTempDirResult = Reflect.set(
      streamManager,
      "createTempDirForStream",
      (_streamToken: string, _runtime: unknown): Promise<string> => {
        tempDirStartedResolve?.();
        return new Promise((resolve) => {
          abortController.signal.addEventListener("abort", () => resolve("/tmp/mock-stream-temp"), {
            once: true,
          });
        });
      }
    );

    if (!replaceTempDirResult) {
      throw new Error("Failed to mock StreamManager.createTempDirForStream");
    }

    let cleanupCalled = false;
    const replaceCleanupResult = Reflect.set(
      streamManager,
      "cleanupStreamTempDir",
      (..._args: unknown[]): void => {
        cleanupCalled = true;
      }
    );

    if (!replaceCleanupResult) {
      throw new Error("Failed to mock StreamManager.cleanupStreamTempDir");
    }

    const replaceCreateResult = Reflect.set(
      streamManager,
      "createStreamAtomically",
      (..._args: unknown[]): never => {
        createCalled = true;
        throw new Error("createStreamAtomically should not be called");
      }
    );

    if (!replaceCreateResult) {
      throw new Error("Failed to mock StreamManager.createStreamAtomically");
    }

    const replaceProcessResult = Reflect.set(
      streamManager,
      "processStreamWithCleanup",
      (..._args: unknown[]): Promise<void> => {
        processCalled = true;
        return Promise.resolve();
      }
    );

    if (!replaceProcessResult) {
      throw new Error("Failed to mock StreamManager.processStreamWithCleanup");
    }

    const anthropic = createAnthropic({ apiKey: "dummy-key" });
    const model = anthropic("claude-sonnet-4-5");

    const startPromise = streamManager.startStream(
      workspaceId,
      [{ role: "user", content: "test" }],
      model,
      KNOWN_MODELS.SONNET.id,
      1,
      "system",
      runtime,
      "test-msg-abort",
      abortController.signal,
      {}
    );

    await tempDirStarted;
    abortController.abort();

    const result = await startPromise;
    expect(result.success).toBe(true);
    expect(createCalled).toBe(false);
    expect(cleanupCalled).toBe(true);
    expect(processCalled).toBe(false);
    expect(streamStartEmitted).toBe(false);
    expect(streamManager.isStreaming(workspaceId)).toBe(false);
  });
});

describe("StreamManager - Unavailable Tool Handling", () => {
  let streamManager: StreamManager;

  beforeEach(() => {
    streamManager = new StreamManager(historyService);
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
          input: { path: "/test", old_string: "foo", new_string: "bar" },
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

describe("StreamManager - TTFT metadata persistence", () => {
  const runtime = createRuntime({ type: "local", srcBaseDir: "/tmp" });

  async function finalizeStreamAndReadMessage(params: {
    workspaceId: string;
    messageId: string;
    historySequence: number;
    startTime: number;
    parts: unknown[];
  }) {
    const streamManager = new StreamManager(historyService);
    // Suppress error events from bubbling up as uncaught exceptions during tests
    streamManager.on("error", () => undefined);

    const replaceTokenTrackerResult = Reflect.set(streamManager, "tokenTracker", {
      setModel: () => Promise.resolve(undefined),
      countTokens: () => Promise.resolve(0),
    });
    if (!replaceTokenTrackerResult) {
      throw new Error("Failed to mock StreamManager.tokenTracker");
    }

    const appendResult = await historyService.appendToHistory(params.workspaceId, {
      id: params.messageId,
      role: "assistant",
      metadata: {
        historySequence: params.historySequence,
        partial: true,
      },
      parts: [],
    });
    expect(appendResult.success).toBe(true);
    if (!appendResult.success) {
      throw new Error(appendResult.error);
    }

    const processStreamWithCleanup = Reflect.get(streamManager, "processStreamWithCleanup") as (
      workspaceId: string,
      streamInfo: unknown,
      historySequence: number
    ) => Promise<void>;
    expect(typeof processStreamWithCleanup).toBe("function");

    const streamInfo = {
      state: "streaming",
      streamResult: {
        fullStream: (async function* () {
          // No-op stream: tests verify stream-end finalization behavior from pre-populated parts.
        })(),
        totalUsage: Promise.resolve({ inputTokens: 4, outputTokens: 6, totalTokens: 10 }),
        usage: Promise.resolve({ inputTokens: 4, outputTokens: 6, totalTokens: 10 }),
        providerMetadata: Promise.resolve(undefined),
        steps: Promise.resolve([]),
      },
      abortController: new AbortController(),
      messageId: params.messageId,
      token: "test-token",
      startTime: params.startTime,
      lastPartTimestamp: params.startTime,
      toolCompletionTimestamps: new Map<string, number>(),
      model: KNOWN_MODELS.SONNET.id,
      historySequence: params.historySequence,
      parts: params.parts,
      lastPartialWriteTime: 0,
      partialWriteTimer: undefined,
      partialWritePromise: undefined,
      processingPromise: Promise.resolve(),
      softInterrupt: { pending: false as const },
      runtimeTempDir: "",
      runtime,
      cumulativeUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      cumulativeProviderMetadata: undefined,
      didRetryPreviousResponseIdAtStep: false,
      currentStepStartIndex: 0,
      stepTracker: {},
    };

    await processStreamWithCleanup.call(
      streamManager,
      params.workspaceId,
      streamInfo,
      params.historySequence
    );

    const historyResult = await historyService.getHistoryFromLatestBoundary(params.workspaceId);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(historyResult.error);
    }

    const updatedMessage = historyResult.data.find((message) => message.id === params.messageId);
    expect(updatedMessage).toBeDefined();
    if (!updatedMessage) {
      throw new Error(`Expected updated message ${params.messageId} in history`);
    }

    return updatedMessage;
  }

  test("persists ttftMs in final assistant metadata when first-token timing is available", async () => {
    const startTime = Date.now() - 1000;
    const updatedMessage = await finalizeStreamAndReadMessage({
      workspaceId: "ttft-present-workspace",
      messageId: "ttft-present-message",
      historySequence: 1,
      startTime,
      parts: [
        {
          type: "text",
          text: "hello",
          timestamp: startTime + 250,
        },
      ],
    });

    expect(updatedMessage.metadata?.ttftMs).toBe(250);
  });

  test("omits ttftMs in final assistant metadata when first-token timing is unavailable", async () => {
    const startTime = Date.now() - 1000;
    const updatedMessage = await finalizeStreamAndReadMessage({
      workspaceId: "ttft-missing-workspace",
      messageId: "ttft-missing-message",
      historySequence: 1,
      startTime,
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "tool-1",
          toolName: "bash",
          state: "output-available",
          input: { script: "echo hi" },
          output: { ok: true },
          timestamp: startTime + 100,
        },
      ],
    });

    expect(updatedMessage.metadata?.ttftMs).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(updatedMessage.metadata ?? {}, "ttftMs")).toBe(
      false
    );
  });
});

describe("StreamManager - previousResponseId recovery", () => {
  test("isResponseIdLost returns false for unknown IDs", () => {
    const streamManager = new StreamManager(historyService);

    // Verify the ID is not lost initially
    expect(streamManager.isResponseIdLost("resp_123abc")).toBe(false);
    expect(streamManager.isResponseIdLost("resp_different")).toBe(false);
  });

  test("extractPreviousResponseIdFromError extracts ID from various error formats", () => {
    const streamManager = new StreamManager(historyService);

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
    const streamManager = new StreamManager(historyService);

    const recordMethod = Reflect.get(streamManager, "recordLostResponseIdIfApplicable") as (
      workspaceId: string,
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

    recordMethod.call(streamManager, "workspace-1", apiError, {
      messageId: "msg-1",
      model: "openai:gpt-mini",
    });

    expect(streamManager.isResponseIdLost("resp_deadbeef")).toBe(true);
  });

  test("recordLostResponseIdIfApplicable records IDs for 500 errors referencing previous responses", () => {
    const streamManager = new StreamManager(historyService);

    const recordMethod = Reflect.get(streamManager, "recordLostResponseIdIfApplicable") as (
      workspaceId: string,
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

    recordMethod.call(streamManager, "workspace-2", apiError, {
      messageId: "msg-2",
      model: "openai:gpt-mini",
    });

    expect(streamManager.isResponseIdLost("resp_cafebabe")).toBe(true);
  });

  test("retryStreamWithoutPreviousResponseId retries at step boundary with existing parts", async () => {
    const streamManager = new StreamManager(historyService);

    const retryMethod = Reflect.get(streamManager, "retryStreamWithoutPreviousResponseId") as (
      workspaceId: string,
      streamInfo: unknown,
      error: unknown,
      hasRetried: boolean
    ) => Promise<boolean>;

    const model = createAnthropic({ apiKey: "test" })("claude-sonnet-4-5");
    const runtime = createRuntime({ type: "local", srcBaseDir: "/tmp" });
    const stepMessages: ModelMessage[] = [{ role: "user", content: "next step" }];

    const streamInfo = {
      state: "streaming",
      streamResult: {},
      abortController: new AbortController(),
      messageId: "msg-1",
      token: "token",
      startTime: Date.now(),
      model: "mux-gateway:openai/gpt-5.2-codex",
      historySequence: 1,
      stepTracker: { latestMessages: stepMessages },
      didRetryPreviousResponseIdAtStep: false,
      currentStepStartIndex: 1,
      request: {
        model,
        messages: [{ role: "user", content: "original" }],
        system: "system",
        providerOptions: { openai: { previousResponseId: "resp_abc123" } },
      },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "tool-1",
          toolName: "test",
          state: "output-available",
          input: {},
          output: {},
        },
      ],
      lastPartialWriteTime: 0,
      processingPromise: Promise.resolve(),
      softInterrupt: { pending: false },
      runtimeTempDir: "/tmp",
      runtime,
      cumulativeUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      cumulativeProviderMetadata: { openai: {} },
    };

    (streamManager as unknown as { createStreamResult: () => unknown }).createStreamResult =
      () => ({
        fullStream: (async function* () {
          await Promise.resolve();
          yield* [];
        })(),
        totalUsage: Promise.resolve(undefined),
        usage: Promise.resolve(undefined),
        providerMetadata: Promise.resolve(undefined),
        steps: Promise.resolve([]),
      });

    const apiError = new APICallError({
      message: "Previous response with id 'resp_abc123' not found.",
      url: "https://api.openai.com/v1/responses",
      requestBodyValues: {},
      statusCode: 400,
      responseHeaders: {},
      responseBody: "Previous response with id 'resp_abc123' not found.",
      isRetryable: false,
      data: { error: { code: "previous_response_not_found" } },
    });

    const retried = await retryMethod.call(streamManager, "ws-step", streamInfo, apiError, false);
    expect(retried).toBe(true);
    expect(streamInfo.parts).toHaveLength(1);
    expect(streamInfo.didRetryPreviousResponseIdAtStep).toBe(true);
    expect(streamInfo.request.messages as ModelMessage[]).toBe(stepMessages);

    const openaiOptions = streamInfo.request.providerOptions as {
      openai?: Record<string, unknown>;
    };
    expect(openaiOptions.openai?.previousResponseId).toBeUndefined();
  });

  test("resolveTotalUsageForStreamEnd prefers cumulative usage after step retry", () => {
    const streamManager = new StreamManager(historyService);

    const resolveMethod = Reflect.get(streamManager, "resolveTotalUsageForStreamEnd") as (
      streamInfo: unknown,
      totalUsage: unknown
    ) => unknown;
    expect(typeof resolveMethod).toBe("function");

    const cumulativeUsage = { inputTokens: 4, outputTokens: 5, totalTokens: 9 };
    const totalUsage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 };

    const result = resolveMethod.call(
      streamManager,
      { didRetryPreviousResponseIdAtStep: true, cumulativeUsage },
      totalUsage
    );

    expect(result).toEqual(cumulativeUsage);
  });

  test("resolveTotalUsageForStreamEnd treats non-zero fields as valid usage", () => {
    const streamManager = new StreamManager(historyService);

    const resolveMethod = Reflect.get(streamManager, "resolveTotalUsageForStreamEnd") as (
      streamInfo: unknown,
      totalUsage: unknown
    ) => unknown;
    expect(typeof resolveMethod).toBe("function");

    const cumulativeUsage = { inputTokens: 4, outputTokens: 1, totalTokens: 0 };
    const totalUsage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 };

    const result = resolveMethod.call(
      streamManager,
      { didRetryPreviousResponseIdAtStep: true, cumulativeUsage },
      totalUsage
    );

    expect(result).toEqual(cumulativeUsage);
  });

  test("resolveTotalUsageForStreamEnd keeps stream total without step retry", () => {
    const streamManager = new StreamManager(historyService);

    const resolveMethod = Reflect.get(streamManager, "resolveTotalUsageForStreamEnd") as (
      streamInfo: unknown,
      totalUsage: unknown
    ) => unknown;
    expect(typeof resolveMethod).toBe("function");

    const cumulativeUsage = { inputTokens: 4, outputTokens: 5, totalTokens: 9 };
    const totalUsage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 };

    const result = resolveMethod.call(
      streamManager,
      { didRetryPreviousResponseIdAtStep: false, cumulativeUsage },
      totalUsage
    );

    expect(result).toEqual(totalUsage);
  });
});

describe("StreamManager - replayStream", () => {
  test("replayStream snapshots parts so reconnect doesn't block until stream ends", async () => {
    const streamManager = new StreamManager(historyService);

    // Suppress error events from bubbling up as uncaught exceptions during tests
    streamManager.on("error", () => undefined);

    let sawStreamStart = false;
    streamManager.on("stream-start", (event: { replay?: boolean | undefined }) => {
      sawStreamStart = true;
      expect(event.replay).toBe(true);
    });
    const workspaceId = "ws-replay-snapshot";

    const deltas: string[] = [];
    streamManager.on("stream-delta", (event: { delta: string; replay?: boolean | undefined }) => {
      expect(event.replay).toBe(true);
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
    expect(sawStreamStart).toBe(true);

    // If replayStream iterates the live array, it would also emit "b".
    expect(deltas).toEqual(["a"]);
  });

  test("replayStream filters output-available tool parts using completion timestamps", async () => {
    const streamManager = new StreamManager(historyService);

    // Suppress error events from bubbling up as uncaught exceptions during tests
    streamManager.on("error", () => undefined);

    const workspaceId = "ws-replay-tool-filter";

    const replayedToolEnds: string[] = [];
    streamManager.on(
      "tool-call-end",
      (event: { replay?: boolean | undefined; toolCallId: string }) => {
        expect(event.replay).toBe(true);
        replayedToolEnds.push(event.toolCallId);
      }
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const workspaceStreamsValue = Reflect.get(streamManager, "workspaceStreams");
    if (!(workspaceStreamsValue instanceof Map)) {
      throw new Error("StreamManager.workspaceStreams is not a Map");
    }
    const workspaceStreams = workspaceStreamsValue as Map<string, unknown>;

    const streamInfo = {
      state: "streaming",
      messageId: "msg-tools",
      model: "claude-sonnet-4",
      historySequence: 1,
      startTime: 123,
      initialMetadata: {},
      toolCompletionTimestamps: new Map([
        ["tool-old", 15],
        ["tool-new", 30],
      ]),
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "tool-old",
          toolName: "bash",
          input: {},
          state: "output-available",
          output: { ok: true },
          timestamp: 10,
        },
        {
          type: "dynamic-tool",
          toolCallId: "tool-new",
          toolName: "bash",
          input: {},
          state: "output-available",
          output: { ok: true },
          timestamp: 12,
        },
      ],
    };

    workspaceStreams.set(workspaceId, streamInfo);

    const tokenTracker = Reflect.get(streamManager, "tokenTracker") as {
      setModel: (model: string) => Promise<void>;
      countTokens: (text: string) => Promise<number>;
    };

    tokenTracker.setModel = () => Promise.resolve();
    tokenTracker.countTokens = () => Promise.resolve(1);

    await streamManager.replayStream(workspaceId, { afterTimestamp: 20 });

    expect(replayedToolEnds).toEqual(["tool-new"]);
  });
  test("replayStream emits replay usage-delta from tracked step/cumulative usage", async () => {
    const streamManager = new StreamManager(historyService);

    // Suppress error events from bubbling up as uncaught exceptions during tests
    streamManager.on("error", () => undefined);

    const workspaceId = "ws-replay-usage";
    const usageEvents: Array<{
      replay?: boolean;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
      cumulativeUsage: { inputTokens: number; outputTokens: number; totalTokens: number };
    }> = [];

    streamManager.on(
      "usage-delta",
      (event: {
        replay?: boolean;
        usage: { inputTokens: number; outputTokens: number; totalTokens: number };
        cumulativeUsage: { inputTokens: number; outputTokens: number; totalTokens: number };
      }) => {
        usageEvents.push(event);
      }
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const workspaceStreamsValue = Reflect.get(streamManager, "workspaceStreams");
    if (!(workspaceStreamsValue instanceof Map)) {
      throw new Error("StreamManager.workspaceStreams is not a Map");
    }
    const workspaceStreams = workspaceStreamsValue as Map<string, unknown>;

    workspaceStreams.set(workspaceId, {
      state: "streaming",
      messageId: "msg-usage",
      model: "claude-sonnet-4",
      metadataModel: "claude-sonnet-4",
      historySequence: 1,
      startTime: 123,
      initialMetadata: {},
      toolCompletionTimestamps: new Map<string, number>(),
      parts: [{ type: "text", text: "hello", timestamp: 10 }],
      lastStepUsage: { inputTokens: 21, outputTokens: 3, totalTokens: 24 },
      cumulativeUsage: { inputTokens: 55, outputTokens: 11, totalTokens: 66 },
      lastStepProviderMetadata: { anthropic: { cacheReadInputTokens: 2 } },
      cumulativeProviderMetadata: { anthropic: { cacheCreationInputTokens: 9 } },
    });

    const tokenTracker = Reflect.get(streamManager, "tokenTracker") as {
      setModel: (model: string) => Promise<void>;
      countTokens: (text: string) => Promise<number>;
    };

    tokenTracker.setModel = () => Promise.resolve();
    tokenTracker.countTokens = () => Promise.resolve(1);

    await streamManager.replayStream(workspaceId);

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]?.replay).toBe(true);
    expect(usageEvents[0]?.usage).toEqual({ inputTokens: 21, outputTokens: 3, totalTokens: 24 });
    expect(usageEvents[0]?.cumulativeUsage).toEqual({
      inputTokens: 55,
      outputTokens: 11,
      totalTokens: 66,
    });
  });
  test("replayStream skips replay usage-delta for incremental afterTimestamp replays", async () => {
    const streamManager = new StreamManager(historyService);

    // Suppress error events from bubbling up as uncaught exceptions during tests
    streamManager.on("error", () => undefined);

    const workspaceId = "ws-replay-usage-incremental";
    const usageEvents: Array<{ replay?: boolean }> = [];

    streamManager.on("usage-delta", (event: { replay?: boolean }) => {
      usageEvents.push(event);
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const workspaceStreamsValue = Reflect.get(streamManager, "workspaceStreams");
    if (!(workspaceStreamsValue instanceof Map)) {
      throw new Error("StreamManager.workspaceStreams is not a Map");
    }
    const workspaceStreams = workspaceStreamsValue as Map<string, unknown>;

    workspaceStreams.set(workspaceId, {
      state: "streaming",
      messageId: "msg-usage-incremental",
      model: "claude-sonnet-4",
      metadataModel: "claude-sonnet-4",
      historySequence: 1,
      startTime: 123,
      initialMetadata: {},
      toolCompletionTimestamps: new Map<string, number>(),
      parts: [{ type: "text", text: "hello", timestamp: 10 }],
      lastStepUsage: { inputTokens: 21, outputTokens: 3, totalTokens: 24 },
      cumulativeUsage: { inputTokens: 55, outputTokens: 11, totalTokens: 66 },
      lastStepProviderMetadata: { anthropic: { cacheReadInputTokens: 2 } },
      cumulativeProviderMetadata: { anthropic: { cacheCreationInputTokens: 9 } },
    });

    const tokenTracker = Reflect.get(streamManager, "tokenTracker") as {
      setModel: (model: string) => Promise<void>;
      countTokens: (text: string) => Promise<number>;
    };

    tokenTracker.setModel = () => Promise.resolve();
    tokenTracker.countTokens = () => Promise.resolve(1);

    await streamManager.replayStream(workspaceId, { afterTimestamp: 999 });

    expect(usageEvents).toHaveLength(0);
  });
});

describe("StreamManager - getStreamInfo", () => {
  test("returns startTime so reconnect cursors can preserve live-only boundaries", () => {
    const streamManager = new StreamManager(historyService);
    const workspaceId = "ws-get-stream-info";

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const workspaceStreamsValue = Reflect.get(streamManager, "workspaceStreams");
    if (!(workspaceStreamsValue instanceof Map)) {
      throw new Error("StreamManager.workspaceStreams is not a Map");
    }
    const workspaceStreams = workspaceStreamsValue as Map<string, unknown>;

    workspaceStreams.set(workspaceId, {
      state: "starting",
      messageId: "msg-starting",
      model: "claude-sonnet-4",
      historySequence: 1,
      startTime: 4_321,
      initialMetadata: {},
      parts: [],
      toolCompletionTimestamps: new Map<string, number>(),
    });

    const streamInfo = streamManager.getStreamInfo(workspaceId);

    expect(streamInfo?.messageId).toBe("msg-starting");
    expect(streamInfo?.startTime).toBe(4_321);
  });
});

describe("StreamManager - categorizeError", () => {
  test("unwraps RetryError.lastError to classify model_not_found", () => {
    const streamManager = new StreamManager(historyService);

    const categorizeMethod = Reflect.get(streamManager, "categorizeError") as (
      error: unknown
    ) => unknown;
    expect(typeof categorizeMethod).toBe("function");

    const apiError = new APICallError({
      message: "The model `gpt-5.2-codex` does not exist or you do not have access to it.",
      url: "https://api.openai.com/v1/responses",
      requestBodyValues: {},
      statusCode: 400,
      responseHeaders: {},
      responseBody:
        '{"error":{"message":"The model `gpt-5.2-codex` does not exist or you do not have access to it.","code":"model_not_found"}}',
      isRetryable: false,
      data: { error: { code: "model_not_found" } },
    });

    const retryError = new RetryError({
      message: "AI SDK retry exhausted",
      reason: "maxRetriesExceeded",
      errors: [apiError],
    });

    expect(categorizeMethod.call(streamManager, retryError)).toBe("model_not_found");
  });

  test("classifies model_not_found via message fallback", () => {
    const streamManager = new StreamManager(historyService);

    const categorizeMethod = Reflect.get(streamManager, "categorizeError") as (
      error: unknown
    ) => unknown;
    expect(typeof categorizeMethod).toBe("function");

    const error = new Error(
      "The model `gpt-5.2-codex` does not exist or you do not have access to it."
    );

    expect(categorizeMethod.call(streamManager, error)).toBe("model_not_found");
  });

  test("classifies 402 payment required as quota (avoid auto-retry)", () => {
    const streamManager = new StreamManager(historyService);

    const categorizeMethod = Reflect.get(streamManager, "categorizeError") as (
      error: unknown
    ) => unknown;
    expect(typeof categorizeMethod).toBe("function");

    const apiError = new APICallError({
      message: "Insufficient balance. Please add credits to continue.",
      url: "https://gateway.mux.coder.com/api/v1/ai-gateway/v1/ai/language-model",
      requestBodyValues: {},
      statusCode: 402,
      responseHeaders: {},
      responseBody:
        '{"error":{"message":"Insufficient balance. Please add credits to continue.","type":"invalid_request_error"}}',
      isRetryable: false,
      data: {
        error: { message: "Insufficient balance. Please add credits to continue." },
      },
    });

    expect(categorizeMethod.call(streamManager, apiError)).toBe("quota");
  });

  test("classifies 429 insufficient_quota responses as quota", () => {
    const streamManager = new StreamManager(historyService);

    const categorizeMethod = Reflect.get(streamManager, "categorizeError") as (
      error: unknown
    ) => unknown;
    expect(typeof categorizeMethod).toBe("function");

    const apiError = new APICallError({
      message: "Request failed",
      url: "https://api.openai.com/v1/responses",
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: {},
      responseBody:
        '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}',
      isRetryable: false,
      data: {
        error: { code: "insufficient_quota", message: "You exceeded your current quota" },
      },
    });

    expect(categorizeMethod.call(streamManager, apiError)).toBe("quota");
  });

  test("classifies generic 429 throttling as rate_limit", () => {
    const streamManager = new StreamManager(historyService);

    const categorizeMethod = Reflect.get(streamManager, "categorizeError") as (
      error: unknown
    ) => unknown;
    expect(typeof categorizeMethod).toBe("function");

    const apiError = new APICallError({
      message: "Too many requests, please retry shortly",
      url: "https://api.openai.com/v1/responses",
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: {},
      responseBody: '{"error":{"message":"Too many requests"}}',
      isRetryable: true,
    });

    expect(categorizeMethod.call(streamManager, apiError)).toBe("rate_limit");
  });

  test("classifies 429 mentioning quota limits as rate_limit (not billing)", () => {
    const streamManager = new StreamManager(historyService);

    const categorizeMethod = Reflect.get(streamManager, "categorizeError") as (
      error: unknown
    ) => unknown;
    expect(typeof categorizeMethod).toBe("function");

    const apiError = new APICallError({
      message: "Per-minute quota limit reached. Retry in 10s.",
      url: "https://api.openai.com/v1/responses",
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: {},
      responseBody: '{"error":{"message":"Per-minute quota limit reached"}}',
      isRetryable: true,
    });

    expect(categorizeMethod.call(streamManager, apiError)).toBe("rate_limit");
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
    const streamManager = new StreamManager(historyService);

    // Verify the private method exists and is callable
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const flushMethod = Reflect.get(streamManager, "flushPartialWrite");
    expect(typeof flushMethod).toBe("function");
  });
});

describe("StreamManager - stopStream", () => {
  test("emits stream-abort when stopping non-existent stream", async () => {
    const streamManager = new StreamManager(historyService);

    // Track emitted events
    const abortEvents: Array<{ workspaceId: string; messageId: string }> = [];
    streamManager.on("stream-abort", (data: { workspaceId: string; messageId: string }) => {
      abortEvents.push(data);
    });

    // Stop a stream that doesn't exist (simulates interrupt before stream-start)
    const result = await streamManager.stopStream("test-workspace");

    expect(result.success).toBe(true);
    expect(abortEvents).toHaveLength(1);
    expect(abortEvents[0].workspaceId).toBe("test-workspace");
    // messageId is empty for synthetic abort (no actual stream existed)
    expect(abortEvents[0].messageId).toBe("");
  });
});

// Note: Comprehensive Anthropic cache control tests are in cacheStrategy.test.ts
// Those unit tests cover all cache control functionality without requiring
// complex setup. StreamManager integrates those functions directly.
