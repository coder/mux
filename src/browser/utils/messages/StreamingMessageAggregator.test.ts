import { describe, test, expect } from "bun:test";
import { StreamingMessageAggregator } from "./StreamingMessageAggregator";

// Test helper: create aggregator with default createdAt for tests
const TEST_CREATED_AT = "2024-01-01T00:00:00.000Z";

// Helper to wait for throttled init output updates (100ms throttle + buffer)
const waitForInitThrottle = () => new Promise((r) => setTimeout(r, 120));

describe("StreamingMessageAggregator", () => {
  describe("init state reference stability", () => {
    test("should return new array reference when state changes", async () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      // Start init hook
      aggregator.handleMessage({
        type: "init-start",
        hookPath: "/test/init",
        timestamp: Date.now(),
      });

      const messages1 = aggregator.getDisplayedMessages();

      // Add output to change state
      aggregator.handleMessage({
        type: "init-output",
        line: "Line 1",
        isError: false,
        timestamp: Date.now(),
      });

      // Wait for throttled cache invalidation
      await waitForInitThrottle();

      const messages2 = aggregator.getDisplayedMessages();

      // Array references should be different when state changes
      expect(messages1).not.toBe(messages2);
    });

    test("should return new lines array reference when init state changes", async () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      // Start init hook
      aggregator.handleMessage({
        type: "init-start",
        hookPath: "/test/init",
        timestamp: Date.now(),
      });

      const messages1 = aggregator.getDisplayedMessages();
      const initMsg1 = messages1.find((m) => m.type === "workspace-init");
      expect(initMsg1).toBeDefined();

      // Add output
      aggregator.handleMessage({
        type: "init-output",
        line: "Line 1",
        isError: false,
        timestamp: Date.now(),
      });

      // Wait for throttled cache invalidation
      await waitForInitThrottle();

      const messages2 = aggregator.getDisplayedMessages();
      const initMsg2 = messages2.find((m) => m.type === "workspace-init");
      expect(initMsg2).toBeDefined();

      // Lines array should be a NEW reference (critical for React.memo)
      if (initMsg1?.type === "workspace-init" && initMsg2?.type === "workspace-init") {
        expect(initMsg1.lines).not.toBe(initMsg2.lines);
        expect(initMsg2.lines).toHaveLength(1);
        expect(initMsg2.lines[0]).toBe("Line 1");
      }
    });

    test("should create new init message object on each state change", async () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      // Start init hook
      aggregator.handleMessage({
        type: "init-start",
        hookPath: "/test/init",
        timestamp: Date.now(),
      });

      const messages1 = aggregator.getDisplayedMessages();
      const initMsg1 = messages1.find((m) => m.type === "workspace-init");

      // Add first output
      aggregator.handleMessage({
        type: "init-output",
        line: "Line 1",
        isError: false,
        timestamp: Date.now(),
      });

      // Wait for throttled cache invalidation
      await waitForInitThrottle();

      const messages2 = aggregator.getDisplayedMessages();
      const initMsg2 = messages2.find((m) => m.type === "workspace-init");

      // Add second output
      aggregator.handleMessage({
        type: "init-output",
        line: "Line 2",
        isError: false,
        timestamp: Date.now(),
      });

      // Wait for throttled cache invalidation
      await waitForInitThrottle();

      const messages3 = aggregator.getDisplayedMessages();
      const initMsg3 = messages3.find((m) => m.type === "workspace-init");

      // Each message object should be a new reference
      expect(initMsg1).not.toBe(initMsg2);
      expect(initMsg2).not.toBe(initMsg3);

      // Lines arrays should be different references
      if (
        initMsg1?.type === "workspace-init" &&
        initMsg2?.type === "workspace-init" &&
        initMsg3?.type === "workspace-init"
      ) {
        expect(initMsg1.lines).not.toBe(initMsg2.lines);
        expect(initMsg2.lines).not.toBe(initMsg3.lines);

        // Verify content progression
        expect(initMsg1.lines).toHaveLength(0);
        expect(initMsg2.lines).toHaveLength(1);
        expect(initMsg3.lines).toHaveLength(2);
      }
    });

    test("should return same cached reference when state has not changed", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      // Start init hook
      aggregator.handleMessage({
        type: "init-start",
        hookPath: "/test/init",
        timestamp: Date.now(),
      });

      const messages1 = aggregator.getDisplayedMessages();
      const messages2 = aggregator.getDisplayedMessages();

      // When no state changes, cache should return same reference
      expect(messages1).toBe(messages2);
    });
  });

  describe("todo lifecycle", () => {
    test("should clear todos when stream ends", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      // Start a stream
      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg1",
        historySequence: 1,
        model: "claude-3-5-sonnet-20241022",
        startTime: Date.now(),
      });

      // Simulate todo_write tool call
      aggregator.handleToolCallStart({
        messageId: "msg1",
        toolCallId: "tool1",
        toolName: "todo_write",
        args: {
          todos: [
            { content: "Do task 1", status: "in_progress" },
            { content: "Do task 2", status: "pending" },
          ],
        },
        tokens: 10,
        timestamp: Date.now(),
        type: "tool-call-start",
        workspaceId: "test-workspace",
      });

      aggregator.handleToolCallEnd({
        type: "tool-call-end",
        workspaceId: "test-workspace",
        messageId: "msg1",
        toolCallId: "tool1",
        toolName: "todo_write",
        result: { success: true },
        timestamp: Date.now(),
      });

      // Verify todos are set
      expect(aggregator.getCurrentTodos()).toHaveLength(2);
      expect(aggregator.getCurrentTodos()[0].content).toBe("Do task 1");

      // End the stream
      aggregator.handleStreamEnd({
        type: "stream-end",
        workspaceId: "test-workspace",
        messageId: "msg1",
        metadata: {
          historySequence: 1,
          timestamp: Date.now(),
          model: "claude-3-5-sonnet-20241022",
        },
        parts: [],
      });

      // Todos should be cleared
      expect(aggregator.getCurrentTodos()).toHaveLength(0);
    });

    test("should clear todos when stream aborts", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg1",
        historySequence: 1,
        model: "claude-3-5-sonnet-20241022",
        startTime: Date.now(),
      });

      // Simulate todo_write
      aggregator.handleToolCallStart({
        messageId: "msg1",
        toolCallId: "tool1",
        toolName: "todo_write",
        args: {
          todos: [{ content: "Task", status: "in_progress" }],
        },
        tokens: 10,
        timestamp: Date.now(),
        type: "tool-call-start",
        workspaceId: "test-workspace",
      });

      aggregator.handleToolCallEnd({
        type: "tool-call-end",
        workspaceId: "test-workspace",
        messageId: "msg1",
        toolCallId: "tool1",
        toolName: "todo_write",
        result: { success: true },
        timestamp: Date.now(),
      });

      expect(aggregator.getCurrentTodos()).toHaveLength(1);

      // Abort the stream
      aggregator.handleStreamAbort({
        type: "stream-abort",
        workspaceId: "test-workspace",
        messageId: "msg1",
        metadata: {},
      });

      // Todos should be cleared
      expect(aggregator.getCurrentTodos()).toHaveLength(0);
    });

    test("should reconstruct todos on reload ONLY when reconnecting to active stream", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      const historicalMessage = {
        id: "msg1",
        role: "assistant" as const,
        parts: [
          {
            type: "dynamic-tool" as const,
            toolCallId: "tool1",
            toolName: "todo_write",
            state: "output-available" as const,
            input: {
              todos: [
                { content: "Historical task 1", status: "completed" },
                { content: "Historical task 2", status: "completed" },
              ],
            },
            output: { success: true },
          },
        ],
        metadata: {
          historySequence: 1,
          timestamp: Date.now(),
          model: "claude-3-5-sonnet-20241022",
        },
      };

      // Scenario 1: Reload with active stream (hasActiveStream = true)
      aggregator.loadHistoricalMessages([historicalMessage], true);
      expect(aggregator.getCurrentTodos()).toHaveLength(2);
      expect(aggregator.getCurrentTodos()[0].content).toBe("Historical task 1");

      // Reset for next scenario
      const aggregator2 = new StreamingMessageAggregator(TEST_CREATED_AT);

      // Scenario 2: Reload without active stream (hasActiveStream = false)
      aggregator2.loadHistoricalMessages([historicalMessage], false);
      expect(aggregator2.getCurrentTodos()).toHaveLength(0);
    });

    test("should reconstruct agentStatus but NOT todos when no active stream", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      const historicalMessage = {
        type: "message" as const,
        id: "msg1",
        role: "assistant" as const,
        parts: [
          {
            type: "dynamic-tool" as const,
            toolCallId: "tool1",
            toolName: "todo_write",
            state: "output-available" as const,
            input: {
              todos: [{ content: "Task 1", status: "completed" }],
            },
            output: { success: true },
          },
          {
            type: "dynamic-tool" as const,
            toolCallId: "tool2",
            toolName: "status_set",
            state: "output-available" as const,
            input: { emoji: "🔧", message: "Working on it" },
            output: { success: true, emoji: "🔧", message: "Working on it" },
          },
        ],
        metadata: {
          historySequence: 1,
          timestamp: Date.now(),
          model: "claude-3-5-sonnet-20241022",
        },
      };

      // Load without active stream
      aggregator.loadHistoricalMessages([historicalMessage], false);

      // agentStatus should be reconstructed (persists across sessions)
      expect(aggregator.getAgentStatus()).toEqual({ emoji: "🔧", message: "Working on it" });

      // TODOs should NOT be reconstructed (stream-scoped)
      expect(aggregator.getCurrentTodos()).toHaveLength(0);
    });

    test("should clear todos when new user message arrives during active stream", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      // Simulate an active stream with todos
      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg1",
        historySequence: 1,
        model: "claude-3-5-sonnet-20241022",
        startTime: Date.now(),
      });

      aggregator.handleToolCallStart({
        messageId: "msg1",
        toolCallId: "tool1",
        toolName: "todo_write",
        args: {
          todos: [{ content: "Task", status: "completed" }],
        },
        tokens: 10,
        timestamp: Date.now(),
        type: "tool-call-start",
        workspaceId: "test-workspace",
      });

      aggregator.handleToolCallEnd({
        type: "tool-call-end",
        workspaceId: "test-workspace",
        messageId: "msg1",
        toolCallId: "tool1",
        toolName: "todo_write",
        result: { success: true },
        timestamp: Date.now(),
      });

      // TODOs should be set
      expect(aggregator.getCurrentTodos()).toHaveLength(1);

      // Add new user message (simulating user sending a new message)
      aggregator.handleMessage({
        type: "message",
        id: "msg2",
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
        metadata: { historySequence: 2, timestamp: Date.now() },
      });

      // Todos should be cleared when new user message arrives
      expect(aggregator.getCurrentTodos()).toHaveLength(0);
    });
  });

  describe("usage-delta handling", () => {
    test("handleUsageDelta stores usage by messageId", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleUsageDelta({
        type: "usage-delta",
        workspaceId: "ws-1",
        messageId: "msg-1",
        usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        cumulativeUsage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
      });

      expect(aggregator.getActiveStreamUsage("msg-1")).toEqual({
        inputTokens: 1000,
        outputTokens: 50,
        totalTokens: 1050,
      });
    });

    test("clearTokenState removes usage", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleUsageDelta({
        type: "usage-delta",
        workspaceId: "ws-1",
        messageId: "msg-1",
        usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        cumulativeUsage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
      });

      expect(aggregator.getActiveStreamUsage("msg-1")).toBeDefined();

      aggregator.clearTokenState("msg-1");

      expect(aggregator.getActiveStreamUsage("msg-1")).toBeUndefined();
    });

    test("latest usage-delta replaces previous for same messageId", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      // First step usage
      aggregator.handleUsageDelta({
        type: "usage-delta",
        workspaceId: "ws-1",
        messageId: "msg-1",
        usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        cumulativeUsage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
      });

      // Second step usage (larger context after tool result added)
      aggregator.handleUsageDelta({
        type: "usage-delta",
        workspaceId: "ws-1",
        messageId: "msg-1",
        usage: { inputTokens: 1500, outputTokens: 100, totalTokens: 1600 },
        cumulativeUsage: { inputTokens: 2500, outputTokens: 150, totalTokens: 2650 },
      });

      // Should have latest step's values (for context window display)
      expect(aggregator.getActiveStreamUsage("msg-1")).toEqual({
        inputTokens: 1500,
        outputTokens: 100,
        totalTokens: 1600,
      });
      // Cumulative should be sum of all steps (for cost display)
      expect(aggregator.getActiveStreamCumulativeUsage("msg-1")).toEqual({
        inputTokens: 2500,
        outputTokens: 150,
        totalTokens: 2650,
      });
    });

    test("tracks usage independently per messageId", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleUsageDelta({
        type: "usage-delta",
        workspaceId: "ws-1",
        messageId: "msg-1",
        usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        cumulativeUsage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
      });

      aggregator.handleUsageDelta({
        type: "usage-delta",
        workspaceId: "ws-1",
        messageId: "msg-2",
        usage: { inputTokens: 2000, outputTokens: 100, totalTokens: 2100 },
        cumulativeUsage: { inputTokens: 2000, outputTokens: 100, totalTokens: 2100 },
      });

      expect(aggregator.getActiveStreamUsage("msg-1")).toEqual({
        inputTokens: 1000,
        outputTokens: 50,
        totalTokens: 1050,
      });
      expect(aggregator.getActiveStreamUsage("msg-2")).toEqual({
        inputTokens: 2000,
        outputTokens: 100,
        totalTokens: 2100,
      });
    });

    test("stores and retrieves cumulativeProviderMetadata", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleUsageDelta({
        type: "usage-delta",
        workspaceId: "ws-1",
        messageId: "msg-1",
        usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        cumulativeUsage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        cumulativeProviderMetadata: {
          anthropic: { cacheCreationInputTokens: 500, cacheReadInputTokens: 200 },
        },
      });

      expect(aggregator.getActiveStreamCumulativeProviderMetadata("msg-1")).toEqual({
        anthropic: { cacheCreationInputTokens: 500, cacheReadInputTokens: 200 },
      });
    });

    test("cumulativeProviderMetadata is undefined when not provided", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleUsageDelta({
        type: "usage-delta",
        workspaceId: "ws-1",
        messageId: "msg-1",
        usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        cumulativeUsage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        // No cumulativeProviderMetadata
      });

      expect(aggregator.getActiveStreamCumulativeProviderMetadata("msg-1")).toBeUndefined();
    });

    test("stores and retrieves step providerMetadata for cache creation display", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleUsageDelta({
        type: "usage-delta",
        workspaceId: "ws-1",
        messageId: "msg-1",
        usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        cumulativeUsage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        providerMetadata: {
          anthropic: { cacheCreationInputTokens: 800 },
        },
      });

      expect(aggregator.getActiveStreamStepProviderMetadata("msg-1")).toEqual({
        anthropic: { cacheCreationInputTokens: 800 },
      });
    });

    test("step providerMetadata is undefined when not provided", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleUsageDelta({
        type: "usage-delta",
        workspaceId: "ws-1",
        messageId: "msg-1",
        usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        cumulativeUsage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        // No providerMetadata
      });

      expect(aggregator.getActiveStreamStepProviderMetadata("msg-1")).toBeUndefined();
    });

    test("clearTokenState clears all usage tracking (step, cumulative, metadata)", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleUsageDelta({
        type: "usage-delta",
        workspaceId: "ws-1",
        messageId: "msg-1",
        usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        cumulativeUsage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        providerMetadata: { anthropic: { cacheCreationInputTokens: 300 } },
        cumulativeProviderMetadata: { anthropic: { cacheCreationInputTokens: 500 } },
      });

      // All should be defined
      expect(aggregator.getActiveStreamUsage("msg-1")).toBeDefined();
      expect(aggregator.getActiveStreamStepProviderMetadata("msg-1")).toBeDefined();
      expect(aggregator.getActiveStreamCumulativeUsage("msg-1")).toBeDefined();
      expect(aggregator.getActiveStreamCumulativeProviderMetadata("msg-1")).toBeDefined();

      aggregator.clearTokenState("msg-1");

      // All should be cleared
      expect(aggregator.getActiveStreamUsage("msg-1")).toBeUndefined();
      expect(aggregator.getActiveStreamStepProviderMetadata("msg-1")).toBeUndefined();
      expect(aggregator.getActiveStreamCumulativeUsage("msg-1")).toBeUndefined();
      expect(aggregator.getActiveStreamCumulativeProviderMetadata("msg-1")).toBeUndefined();
    });

    test("multi-step scenario: step usage replaced, cumulative accumulated", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      // Step 1: Initial request with cache creation
      aggregator.handleUsageDelta({
        type: "usage-delta",
        workspaceId: "ws-1",
        messageId: "msg-1",
        usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        cumulativeUsage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        cumulativeProviderMetadata: { anthropic: { cacheCreationInputTokens: 800 } },
      });

      // Verify step 1 state
      expect(aggregator.getActiveStreamUsage("msg-1")?.inputTokens).toBe(1000);
      expect(aggregator.getActiveStreamCumulativeUsage("msg-1")?.inputTokens).toBe(1000);
      expect(
        (
          aggregator.getActiveStreamCumulativeProviderMetadata("msg-1")?.anthropic as {
            cacheCreationInputTokens: number;
          }
        ).cacheCreationInputTokens
      ).toBe(800);

      // Step 2: After tool call, larger context, more cache creation
      aggregator.handleUsageDelta({
        type: "usage-delta",
        workspaceId: "ws-1",
        messageId: "msg-1",
        usage: { inputTokens: 1500, outputTokens: 100, totalTokens: 1600 }, // Last step only
        cumulativeUsage: { inputTokens: 2500, outputTokens: 150, totalTokens: 2650 }, // Sum of all
        cumulativeProviderMetadata: { anthropic: { cacheCreationInputTokens: 1200 } }, // Sum of all
      });

      // Step usage should be REPLACED (last step only)
      expect(aggregator.getActiveStreamUsage("msg-1")).toEqual({
        inputTokens: 1500,
        outputTokens: 100,
        totalTokens: 1600,
      });

      // Cumulative usage should show SUM of all steps
      expect(aggregator.getActiveStreamCumulativeUsage("msg-1")).toEqual({
        inputTokens: 2500,
        outputTokens: 150,
        totalTokens: 2650,
      });

      // Cumulative metadata should show SUM of cache creation tokens
      expect(aggregator.getActiveStreamCumulativeProviderMetadata("msg-1")).toEqual({
        anthropic: { cacheCreationInputTokens: 1200 },
      });
    });
  });

  describe("nested tool calls (PTC code_execution)", () => {
    test("adds nested call to parent tool part on tool-call-start with parentToolCallId", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      // Start a stream with a code_execution tool call
      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg-1",
        historySequence: 1,
        model: "claude-3-5-sonnet-20241022",
        startTime: Date.now(),
      });

      // Start parent code_execution tool
      aggregator.handleToolCallStart({
        type: "tool-call-start",
        workspaceId: "test-workspace",
        messageId: "msg-1",
        toolCallId: "parent-tool-1",
        toolName: "code_execution",
        args: { code: "mux.file_read({ filePath: 'test.txt' })" },
        tokens: 10,
        timestamp: 1000,
      });

      // Start nested tool call with parentToolCallId
      aggregator.handleToolCallStart({
        type: "tool-call-start",
        workspaceId: "test-workspace",
        messageId: "msg-1",
        toolCallId: "nested-tool-1",
        toolName: "file_read",
        args: { filePath: "test.txt" },
        tokens: 0,
        timestamp: 1100,
        parentToolCallId: "parent-tool-1",
      });

      // Tool parts become "tool" type in displayed messages (not "assistant")
      const messages = aggregator.getDisplayedMessages();
      const toolMsg = messages.find((m) => m.type === "tool" && m.toolCallId === "parent-tool-1");
      expect(toolMsg).toBeDefined();

      if (toolMsg?.type === "tool") {
        expect(toolMsg.nestedCalls).toHaveLength(1);
        expect(toolMsg.nestedCalls![0]).toEqual({
          toolCallId: "nested-tool-1",
          toolName: "file_read",
          state: "input-available",
          input: { filePath: "test.txt" },
          timestamp: 1100,
        });
      }
    });

    test("updates nested call with output on tool-call-end with parentToolCallId", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      // Setup: stream with parent and nested tool
      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg-1",
        historySequence: 1,
        model: "claude-3-5-sonnet-20241022",
        startTime: Date.now(),
      });

      aggregator.handleToolCallStart({
        type: "tool-call-start",
        workspaceId: "test-workspace",
        messageId: "msg-1",
        toolCallId: "parent-tool-1",
        toolName: "code_execution",
        args: { code: "test" },
        tokens: 10,
        timestamp: 1000,
      });

      aggregator.handleToolCallStart({
        type: "tool-call-start",
        workspaceId: "test-workspace",
        messageId: "msg-1",
        toolCallId: "nested-tool-1",
        toolName: "file_read",
        args: { filePath: "test.txt" },
        tokens: 0,
        timestamp: 1100,
        parentToolCallId: "parent-tool-1",
      });

      // End nested tool call with result
      aggregator.handleToolCallEnd({
        type: "tool-call-end",
        workspaceId: "test-workspace",
        messageId: "msg-1",
        toolCallId: "nested-tool-1",
        toolName: "file_read",
        result: { success: true, content: "file content" },
        timestamp: 1200,
        parentToolCallId: "parent-tool-1",
      });

      const messages = aggregator.getDisplayedMessages();
      const toolMsg = messages.find((m) => m.type === "tool" && m.toolCallId === "parent-tool-1");

      if (toolMsg?.type === "tool") {
        expect(toolMsg.nestedCalls).toHaveLength(1);
        expect(toolMsg.nestedCalls![0].state).toBe("output-available");
        expect(toolMsg.nestedCalls![0].output).toEqual({
          success: true,
          content: "file content",
        });
      }
    });

    test("handles multiple nested calls in sequence", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg-1",
        historySequence: 1,
        model: "claude-3-5-sonnet-20241022",
        startTime: Date.now(),
      });

      aggregator.handleToolCallStart({
        type: "tool-call-start",
        workspaceId: "test-workspace",
        messageId: "msg-1",
        toolCallId: "parent-tool-1",
        toolName: "code_execution",
        args: { code: "multi-tool code" },
        tokens: 10,
        timestamp: 1000,
      });

      // First nested call
      aggregator.handleToolCallStart({
        type: "tool-call-start",
        workspaceId: "test-workspace",
        messageId: "msg-1",
        toolCallId: "nested-1",
        toolName: "file_read",
        args: { filePath: "a.txt" },
        tokens: 0,
        timestamp: 1100,
        parentToolCallId: "parent-tool-1",
      });

      aggregator.handleToolCallEnd({
        type: "tool-call-end",
        workspaceId: "test-workspace",
        messageId: "msg-1",
        toolCallId: "nested-1",
        toolName: "file_read",
        result: { success: true, content: "content A" },
        timestamp: 1150,
        parentToolCallId: "parent-tool-1",
      });

      // Second nested call
      aggregator.handleToolCallStart({
        type: "tool-call-start",
        workspaceId: "test-workspace",
        messageId: "msg-1",
        toolCallId: "nested-2",
        toolName: "bash",
        args: { script: "echo hello" },
        tokens: 0,
        timestamp: 1200,
        parentToolCallId: "parent-tool-1",
      });

      aggregator.handleToolCallEnd({
        type: "tool-call-end",
        workspaceId: "test-workspace",
        messageId: "msg-1",
        toolCallId: "nested-2",
        toolName: "bash",
        result: { success: true, output: "hello" },
        timestamp: 1250,
        parentToolCallId: "parent-tool-1",
      });

      const messages = aggregator.getDisplayedMessages();
      const toolMsg = messages.find((m) => m.type === "tool" && m.toolCallId === "parent-tool-1");

      if (toolMsg?.type === "tool") {
        expect(toolMsg.nestedCalls).toHaveLength(2);

        expect(toolMsg.nestedCalls![0].toolName).toBe("file_read");
        expect(toolMsg.nestedCalls![0].state).toBe("output-available");

        expect(toolMsg.nestedCalls![1].toolName).toBe("bash");
        expect(toolMsg.nestedCalls![1].state).toBe("output-available");
      }
    });

    test("falls through to create regular tool if parent not found", () => {
      // Note: This is defensive behavior - if parentToolCallId is provided but parent
      // doesn't exist, we fall through and create a regular tool part rather than dropping it.
      // This handles edge cases where events arrive out of order.
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg-1",
        historySequence: 1,
        model: "claude-3-5-sonnet-20241022",
        startTime: Date.now(),
      });

      // Try to add nested call with non-existent parent
      aggregator.handleToolCallStart({
        type: "tool-call-start",
        workspaceId: "test-workspace",
        messageId: "msg-1",
        toolCallId: "nested-orphan",
        toolName: "file_read",
        args: { filePath: "test.txt" },
        tokens: 0,
        timestamp: 1000,
        parentToolCallId: "non-existent-parent",
      });

      // Falls through and creates a regular tool part (defensive behavior)
      const messages = aggregator.getDisplayedMessages();
      const toolParts = messages.filter((m) => m.type === "tool");
      expect(toolParts).toHaveLength(1);
      expect(toolParts[0].toolCallId).toBe("nested-orphan");
    });

    test("nested call end is ignored if nested call not found in parent", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg-1",
        historySequence: 1,
        model: "claude-3-5-sonnet-20241022",
        startTime: Date.now(),
      });

      aggregator.handleToolCallStart({
        type: "tool-call-start",
        workspaceId: "test-workspace",
        messageId: "msg-1",
        toolCallId: "parent-tool-1",
        toolName: "code_execution",
        args: { code: "test" },
        tokens: 10,
        timestamp: 1000,
      });

      // Try to end a nested call that was never started - should not throw
      aggregator.handleToolCallEnd({
        type: "tool-call-end",
        workspaceId: "test-workspace",
        messageId: "msg-1",
        toolCallId: "unknown-nested",
        toolName: "file_read",
        result: { success: true },
        timestamp: 1100,
        parentToolCallId: "parent-tool-1",
      });

      // Parent should still exist with empty nestedCalls
      const messages = aggregator.getDisplayedMessages();
      const toolMsg = messages.find((m) => m.type === "tool" && m.toolCallId === "parent-tool-1");
      expect(toolMsg).toBeDefined();

      // nestedCalls may be undefined or empty, both are fine
      if (toolMsg?.type === "tool") {
        expect(toolMsg.nestedCalls ?? []).toHaveLength(0);
      }
    });
  });
});
