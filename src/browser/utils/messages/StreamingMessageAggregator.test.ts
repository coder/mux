import { describe, test, expect } from "bun:test";
import { StreamingMessageAggregator } from "./StreamingMessageAggregator";

// Test helper: create aggregator with default createdAt for tests
const TEST_CREATED_AT = "2024-01-01T00:00:00.000Z";

describe("StreamingMessageAggregator", () => {
  describe("init state reference stability", () => {
    test("should return new array reference when state changes", () => {
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

      const messages2 = aggregator.getDisplayedMessages();

      // Array references should be different when state changes
      expect(messages1).not.toBe(messages2);
    });

    test("should return new lines array reference when init state changes", () => {
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

    test("should create new init message object on each state change", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      // Start init hook
      aggregator.handleMessage({
        type: "init-start",
        hookPath: "/test/init",
        timestamp: Date.now(),
      });

      const messages1 = aggregator.getDisplayedMessages();
      const initMsg1 = messages1.find((m) => m.type === "workspace-init");

      // Add multiple outputs
      aggregator.handleMessage({
        type: "init-output",
        line: "Line 1",
        isError: false,
        timestamp: Date.now(),
      });

      const messages2 = aggregator.getDisplayedMessages();
      const initMsg2 = messages2.find((m) => m.type === "workspace-init");

      aggregator.handleMessage({
        type: "init-output",
        line: "Line 2",
        isError: false,
        timestamp: Date.now(),
      });

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
});
