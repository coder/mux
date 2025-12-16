import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getStatusStateKey } from "@/common/constants/storage";
import { StreamingMessageAggregator } from "./StreamingMessageAggregator";

const originalLocalStorage: Storage | undefined = (globalThis as { localStorage?: Storage })
  .localStorage;

const createMockLocalStorage = () => {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  } satisfies Storage;
};

beforeEach(() => {
  const mock = createMockLocalStorage();
  Object.defineProperty(globalThis, "localStorage", {
    value: mock,
    configurable: true,
  });
});

afterEach(() => {
  const ls = (globalThis as { localStorage?: Storage }).localStorage;
  ls?.clear?.();
});

afterAll(() => {
  if (originalLocalStorage !== undefined) {
    Object.defineProperty(globalThis, "localStorage", { value: originalLocalStorage });
  } else {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});

describe("ask_user_question waiting state", () => {
  it("treats partial ask_user_question as executing (waiting) not interrupted", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");

    aggregator.loadHistoricalMessages([
      {
        id: "assistant-1",
        role: "assistant" as const,
        parts: [
          {
            type: "dynamic-tool" as const,
            toolCallId: "call-ask-1",
            toolName: "ask_user_question",
            state: "input-available" as const,
            input: {
              questions: [
                {
                  header: "Approach",
                  question: "Which approach should we take?",
                  options: [
                    { label: "A", description: "Approach A" },
                    { label: "B", description: "Approach B" },
                  ],
                  multiSelect: false,
                },
              ],
            },
          },
        ],
        metadata: {
          timestamp: 1000,
          historySequence: 1,
          partial: true,
        },
      },
    ]);

    const displayed = aggregator.getDisplayedMessages();
    const toolMsg = displayed.find((m) => m.type === "tool" && m.toolName === "ask_user_question");
    expect(toolMsg).toBeDefined();
    if (toolMsg?.type === "tool") {
      expect(toolMsg.status).toBe("executing");
      expect(toolMsg.isPartial).toBe(true);
    }

    expect(aggregator.hasAwaitingUserQuestion()).toBe(true);
  });
});

describe("StreamingMessageAggregator - Agent Status", () => {
  it("should start with undefined agent status", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");
    expect(aggregator.getAgentStatus()).toBeUndefined();
  });

  it("should update agent status when status_set tool succeeds", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");
    const messageId = "msg1";
    const toolCallId = "tool1";

    // Start a stream
    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId: "workspace1",
      messageId,
      model: "test-model",
      historySequence: 1,
    });

    // Add a status_set tool call
    aggregator.handleToolCallStart({
      type: "tool-call-start",
      workspaceId: "workspace1",
      messageId,
      toolCallId,
      toolName: "status_set",
      args: { emoji: "🔍", message: "Analyzing code" },
      tokens: 10,
      timestamp: Date.now(),
    });

    // Complete the tool call
    aggregator.handleToolCallEnd({
      type: "tool-call-end",
      workspaceId: "workspace1",
      messageId,
      toolCallId,
      toolName: "status_set",
      result: { success: true, emoji: "🔍", message: "Analyzing code" },
      timestamp: Date.now(),
    });

    const status = aggregator.getAgentStatus();
    expect(status).toBeDefined();
    expect(status?.emoji).toBe("🔍");
    expect(status?.message).toBe("Analyzing code");
  });

  it("should update agent status multiple times", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");
    const messageId = "msg1";

    // Start a stream
    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId: "workspace1",
      messageId,
      model: "test-model",
      historySequence: 1,
    });

    // First status_set
    aggregator.handleToolCallStart({
      type: "tool-call-start",
      workspaceId: "workspace1",
      messageId,
      toolCallId: "tool1",
      toolName: "status_set",
      args: { emoji: "🔍", message: "Analyzing" },
      tokens: 10,
      timestamp: Date.now(),
    });

    aggregator.handleToolCallEnd({
      type: "tool-call-end",
      workspaceId: "workspace1",
      messageId,
      toolCallId: "tool1",
      toolName: "status_set",
      result: { success: true, emoji: "🔍", message: "Analyzing" },
      timestamp: Date.now(),
    });

    expect(aggregator.getAgentStatus()?.emoji).toBe("🔍");

    // Second status_set
    aggregator.handleToolCallStart({
      type: "tool-call-start",
      workspaceId: "workspace1",
      messageId,
      toolCallId: "tool2",
      toolName: "status_set",
      args: { emoji: "📝", message: "Writing" },
      tokens: 10,
      timestamp: Date.now(),
    });

    aggregator.handleToolCallEnd({
      type: "tool-call-end",
      workspaceId: "workspace1",
      messageId,
      toolCallId: "tool2",
      toolName: "status_set",
      result: { success: true, emoji: "📝", message: "Writing" },
      timestamp: Date.now(),
    });

    expect(aggregator.getAgentStatus()?.emoji).toBe("📝");
    expect(aggregator.getAgentStatus()?.message).toBe("Writing");
  });

  it("should persist agent status after stream ends", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z", "workspace1");
    const messageId = "msg1";

    // Start a stream
    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId: "workspace1",
      messageId,
      model: "test-model",
      historySequence: 1,
    });

    // Set status
    aggregator.handleToolCallStart({
      type: "tool-call-start",
      workspaceId: "workspace1",
      messageId,
      toolCallId: "tool1",
      toolName: "status_set",
      args: { emoji: "🔍", message: "Working" },
      tokens: 10,
      timestamp: Date.now(),
    });

    aggregator.handleToolCallEnd({
      type: "tool-call-end",
      workspaceId: "workspace1",
      messageId,
      toolCallId: "tool1",
      toolName: "status_set",
      result: { success: true, emoji: "🔍", message: "Working" },
      timestamp: Date.now(),
    });

    expect(aggregator.getAgentStatus()).toBeDefined();

    // End the stream
    aggregator.handleStreamEnd({
      type: "stream-end",
      workspaceId: "workspace1",
      messageId,
      metadata: { model: "test-model" },
      parts: [],
    });

    // Status should persist after stream ends (unlike todos)
    expect(aggregator.getAgentStatus()).toBeDefined();
    expect(aggregator.getAgentStatus()?.emoji).toBe("🔍");
  });

  it("should not update agent status if tool call fails", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");
    const messageId = "msg1";

    // Start a stream
    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId: "workspace1",
      messageId,
      model: "test-model",
      historySequence: 1,
    });

    // Add a status_set tool call
    aggregator.handleToolCallStart({
      type: "tool-call-start",
      workspaceId: "workspace1",
      messageId,
      toolCallId: "tool1",
      toolName: "status_set",
      args: { emoji: "🔍", message: "Analyzing" },
      tokens: 10,
      timestamp: Date.now(),
    });

    // Complete with failure
    aggregator.handleToolCallEnd({
      type: "tool-call-end",
      workspaceId: "workspace1",
      messageId,
      toolCallId: "tool1",
      toolName: "status_set",
      result: { success: false, error: "Something went wrong" },
      timestamp: Date.now(),
    });

    // Status should remain undefined
    expect(aggregator.getAgentStatus()).toBeUndefined();
  });

  it("should clear agent status when new user message arrives", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z", "workspace1");

    // Start first stream and set status
    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId: "workspace1",
      messageId: "msg1",
      model: "test-model",
      historySequence: 1,
    });

    aggregator.handleToolCallStart({
      type: "tool-call-start",
      workspaceId: "workspace1",
      messageId: "msg1",
      toolCallId: "tool1",
      toolName: "status_set",
      args: { emoji: "🔍", message: "First task" },
      tokens: 10,
      timestamp: Date.now(),
    });

    aggregator.handleToolCallEnd({
      type: "tool-call-end",
      workspaceId: "workspace1",
      messageId: "msg1",
      toolCallId: "tool1",
      toolName: "status_set",
      result: { success: true, emoji: "🔍", message: "First task" },
      timestamp: Date.now(),
    });

    expect(aggregator.getAgentStatus()?.message).toBe("First task");

    // End first stream
    aggregator.handleStreamEnd({
      type: "stream-end",
      workspaceId: "workspace1",
      messageId: "msg1",
      metadata: { model: "test-model" },
      parts: [],
    });

    // Status persists after stream ends
    expect(aggregator.getAgentStatus()?.message).toBe("First task");

    // User sends a NEW message - status should be cleared
    const newUserMessage = {
      type: "message" as const,
      id: "msg2",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "What's next?" }],
      metadata: { timestamp: Date.now(), historySequence: 2 },
    };
    aggregator.handleMessage(newUserMessage);

    // Status should be cleared on new user message
    expect(aggregator.getAgentStatus()).toBeUndefined();
  });

  it("should show 'failed' status in UI when status_set validation fails", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");
    const messageId = "msg1";

    // Start a stream
    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId: "workspace1",
      messageId,
      model: "test-model",
      historySequence: 1,
    });

    // Add a status_set tool call with invalid emoji
    aggregator.handleToolCallStart({
      type: "tool-call-start",
      workspaceId: "workspace1",
      messageId,
      toolCallId: "tool1",
      toolName: "status_set",
      args: { emoji: "not-an-emoji", message: "test" },
      tokens: 10,
      timestamp: Date.now(),
    });

    // Complete with validation failure
    aggregator.handleToolCallEnd({
      type: "tool-call-end",
      workspaceId: "workspace1",
      messageId,
      toolCallId: "tool1",
      toolName: "status_set",
      result: { success: false, error: "emoji must be a single emoji character" },
      timestamp: Date.now(),
    });

    // End the stream to finalize message
    aggregator.handleStreamEnd({
      type: "stream-end",
      workspaceId: "workspace1",
      messageId,
      metadata: { model: "test-model" },
      parts: [],
    });

    // Check that the tool message shows 'failed' status in the UI
    const displayedMessages = aggregator.getDisplayedMessages();
    const toolMessage = displayedMessages.find((m) => m.type === "tool");
    expect(toolMessage).toBeDefined();
    expect(toolMessage?.type).toBe("tool");
    if (toolMessage?.type === "tool") {
      expect(toolMessage.status).toBe("failed");
      expect(toolMessage.toolName).toBe("status_set");
    }

    // And status should NOT be updated in aggregator
    expect(aggregator.getAgentStatus()).toBeUndefined();
  });

  it("should show 'completed' status in UI when status_set validation succeeds", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z", "workspace1");
    const messageId = "msg1";

    // Start a stream
    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId: "workspace1",
      messageId,
      model: "test-model",
      historySequence: 1,
    });

    // Add a successful status_set tool call
    aggregator.handleToolCallStart({
      type: "tool-call-start",
      workspaceId: "workspace1",
      messageId,
      toolCallId: "tool1",
      toolName: "status_set",
      args: { emoji: "🔍", message: "Analyzing code" },
      tokens: 10,
      timestamp: Date.now(),
    });

    // Complete successfully
    aggregator.handleToolCallEnd({
      type: "tool-call-end",
      workspaceId: "workspace1",
      messageId,
      toolCallId: "tool1",
      toolName: "status_set",
      result: { success: true, emoji: "🔍", message: "Analyzing code" },
      timestamp: Date.now(),
    });

    // End the stream to finalize message
    aggregator.handleStreamEnd({
      type: "stream-end",
      workspaceId: "workspace1",
      messageId,
      metadata: { model: "test-model" },
      parts: [],
    });

    // Check that the tool message shows 'completed' status in the UI
    const displayedMessages = aggregator.getDisplayedMessages();
    const toolMessage = displayedMessages.find((m) => m.type === "tool");
    expect(toolMessage).toBeDefined();
    expect(toolMessage?.type).toBe("tool");
    if (toolMessage?.type === "tool") {
      expect(toolMessage.status).toBe("completed");
      expect(toolMessage.toolName).toBe("status_set");
    }

    // And status SHOULD be updated in aggregator
    const status = aggregator.getAgentStatus();
    expect(status).toBeDefined();
    expect(status?.emoji).toBe("🔍");
    expect(status?.message).toBe("Analyzing code");
  });

  it("should reconstruct agentStatus when loading historical messages", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");

    // Create historical messages with a completed status_set tool call
    const historicalMessages = [
      {
        id: "msg1",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "Hello" }],
        metadata: { timestamp: Date.now(), historySequence: 1 },
      },
      {
        id: "msg2",
        role: "assistant" as const,
        parts: [
          { type: "text" as const, text: "Working on it..." },
          {
            type: "dynamic-tool" as const,
            toolCallId: "tool1",
            toolName: "status_set",
            state: "output-available" as const,
            input: { emoji: "🔍", message: "Analyzing code" },
            output: { success: true, emoji: "🔍", message: "Analyzing code" },
            timestamp: Date.now(),
          },
        ],
        metadata: { timestamp: Date.now(), historySequence: 2 },
      },
    ];

    // Load historical messages
    aggregator.loadHistoricalMessages(historicalMessages);

    // Status should be reconstructed from the historical tool call
    const status = aggregator.getAgentStatus();
    expect(status).toBeDefined();
    expect(status?.emoji).toBe("🔍");
    expect(status?.message).toBe("Analyzing code");
  });

  it("should use most recent status_set when loading multiple historical messages", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");

    // Create historical messages with multiple status_set calls
    const historicalMessages = [
      {
        id: "msg1",
        role: "assistant" as const,
        parts: [
          {
            type: "dynamic-tool" as const,
            toolCallId: "tool1",
            toolName: "status_set",
            state: "output-available" as const,
            input: { emoji: "🔍", message: "First status" },
            output: { success: true, emoji: "🔍", message: "First status" },
            timestamp: Date.now(),
          },
        ],
        metadata: { timestamp: Date.now(), historySequence: 1 },
      },
      {
        id: "msg2",
        role: "assistant" as const,
        parts: [
          {
            type: "dynamic-tool" as const,
            toolCallId: "tool2",
            toolName: "status_set",
            state: "output-available" as const,
            input: { emoji: "📝", message: "Second status" },
            output: { success: true, emoji: "📝", message: "Second status" },
            timestamp: Date.now(),
          },
        ],
        metadata: { timestamp: Date.now(), historySequence: 2 },
      },
    ];

    // Load historical messages
    aggregator.loadHistoricalMessages(historicalMessages);

    // Should use the most recent (last processed) status
    const status = aggregator.getAgentStatus();
    expect(status?.emoji).toBe("📝");
    expect(status?.message).toBe("Second status");
  });

  it("should not reconstruct status from failed status_set in historical messages", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");

    // Create historical message with failed status_set
    const historicalMessages = [
      {
        id: "msg1",
        role: "assistant" as const,
        parts: [
          {
            type: "dynamic-tool" as const,
            toolCallId: "tool1",
            toolName: "status_set",
            state: "output-available" as const,
            input: { emoji: "not-emoji", message: "test" },
            output: { success: false, error: "emoji must be a single emoji character" },
            timestamp: Date.now(),
          },
        ],
        metadata: { timestamp: Date.now(), historySequence: 1 },
      },
    ];

    // Load historical messages
    aggregator.loadHistoricalMessages(historicalMessages);

    // Status should remain undefined (failed validation)
    expect(aggregator.getAgentStatus()).toBeUndefined();
  });

  it("should retain last status_set even if later assistant messages omit it", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");

    const historicalMessages = [
      {
        id: "assistant1",
        role: "assistant" as const,
        parts: [
          {
            type: "dynamic-tool" as const,
            toolCallId: "tool1",
            toolName: "status_set",
            state: "output-available" as const,
            input: { emoji: "🧪", message: "Running tests" },
            output: { success: true, emoji: "🧪", message: "Running tests" },
            timestamp: 1000,
          },
        ],
        metadata: { timestamp: 1000, historySequence: 1 },
      },
      {
        id: "assistant2",
        role: "assistant" as const,
        parts: [{ type: "text" as const, text: "[compaction summary]" }],
        metadata: { timestamp: 2000, historySequence: 2 },
      },
    ];

    aggregator.loadHistoricalMessages(historicalMessages);

    const status = aggregator.getAgentStatus();
    expect(status?.emoji).toBe("🧪");
    expect(status?.message).toBe("Running tests");
  });

  it("should restore persisted status when history is compacted away", () => {
    const workspaceId = "workspace1";
    const persistedStatus = {
      emoji: "🔗",
      message: "PR open",
      url: "https://example.com/pr/123",
    } as const;
    localStorage.setItem(getStatusStateKey(workspaceId), JSON.stringify(persistedStatus));

    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z", workspaceId);

    // History with no status_set (e.g., after compaction removes older tool calls)
    const historicalMessages = [
      {
        id: "assistant2",
        role: "assistant" as const,
        parts: [{ type: "text" as const, text: "[compacted history]" }],
        metadata: { timestamp: 3000, historySequence: 1 },
      },
    ];

    aggregator.loadHistoricalMessages(historicalMessages);

    expect(aggregator.getAgentStatus()).toEqual(persistedStatus);
  });

  it("should use truncated message from output, not original input", () => {
    const aggregator = new StreamingMessageAggregator(new Date().toISOString());

    const messageId = "msg1";
    const toolCallId = "tool1";

    // Start stream
    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId: "workspace1",
      messageId,
      model: "test-model",
      historySequence: 1,
    });

    // Status_set with long message (would be truncated by backend)
    const longMessage = "a".repeat(100); // 100 chars, exceeds 60 char limit
    const truncatedMessage = "a".repeat(59) + "…"; // What backend returns

    aggregator.handleToolCallStart({
      type: "tool-call-start",
      workspaceId: "workspace1",
      messageId,
      toolCallId,
      toolName: "status_set",
      args: { emoji: "✅", message: longMessage },
      tokens: 10,
      timestamp: Date.now(),
    });

    aggregator.handleToolCallEnd({
      type: "tool-call-end",
      workspaceId: "workspace1",
      messageId,
      toolCallId,
      toolName: "status_set",
      result: { success: true, emoji: "✅", message: truncatedMessage },
      timestamp: Date.now(),
    });

    // Should use truncated message from output, not the original input
    const status = aggregator.getAgentStatus();
    expect(status).toEqual({ emoji: "✅", message: truncatedMessage });
    expect(status?.message.length).toBe(60);
  });

  it("should store URL when provided in status_set", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");
    const messageId = "msg1";
    const toolCallId = "tool1";

    // Start a stream
    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId: "workspace1",
      messageId,
      model: "test-model",
      historySequence: 1,
    });

    // Add a status_set tool call with URL
    const testUrl = "https://github.com/owner/repo/pull/123";
    aggregator.handleToolCallStart({
      type: "tool-call-start",
      workspaceId: "workspace1",
      messageId,
      toolCallId,
      toolName: "status_set",
      args: { emoji: "🔗", message: "PR submitted", url: testUrl },
      tokens: 10,
      timestamp: Date.now(),
    });

    // Complete the tool call
    aggregator.handleToolCallEnd({
      type: "tool-call-end",
      workspaceId: "workspace1",
      messageId,
      toolCallId,
      toolName: "status_set",
      result: { success: true, emoji: "🔗", message: "PR submitted", url: testUrl },
      timestamp: Date.now(),
    });

    const status = aggregator.getAgentStatus();
    expect(status).toBeDefined();
    expect(status?.emoji).toBe("🔗");
    expect(status?.message).toBe("PR submitted");
    expect(status?.url).toBe(testUrl);
  });

  it("should persist URL across status updates until explicitly replaced", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");
    const messageId = "msg1";

    // Start a stream
    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId: "workspace1",
      messageId,
      model: "test-model",
      historySequence: 1,
    });

    // First status with URL
    const testUrl = "https://github.com/owner/repo/pull/123";
    aggregator.handleToolCallStart({
      type: "tool-call-start",
      workspaceId: "workspace1",
      messageId,
      toolCallId: "tool1",
      toolName: "status_set",
      args: { emoji: "🔗", message: "PR submitted", url: testUrl },
      tokens: 10,
      timestamp: Date.now(),
    });

    aggregator.handleToolCallEnd({
      type: "tool-call-end",
      workspaceId: "workspace1",
      messageId,
      toolCallId: "tool1",
      toolName: "status_set",
      result: { success: true, emoji: "🔗", message: "PR submitted", url: testUrl },
      timestamp: Date.now(),
    });

    expect(aggregator.getAgentStatus()?.url).toBe(testUrl);

    // Second status without URL - should keep previous URL
    aggregator.handleToolCallStart({
      type: "tool-call-start",
      workspaceId: "workspace1",
      messageId,
      toolCallId: "tool2",
      toolName: "status_set",
      args: { emoji: "✅", message: "Done" },
      tokens: 10,
      timestamp: Date.now(),
    });

    aggregator.handleToolCallEnd({
      type: "tool-call-end",
      workspaceId: "workspace1",
      messageId,
      toolCallId: "tool2",
      toolName: "status_set",
      result: { success: true, emoji: "✅", message: "Done" },
      timestamp: Date.now(),
    });

    const statusAfterUpdate = aggregator.getAgentStatus();
    expect(statusAfterUpdate?.emoji).toBe("✅");
    expect(statusAfterUpdate?.message).toBe("Done");
    expect(statusAfterUpdate?.url).toBe(testUrl); // URL persists

    // Third status with different URL - should replace
    const newUrl = "https://github.com/owner/repo/pull/456";
    aggregator.handleToolCallStart({
      type: "tool-call-start",
      workspaceId: "workspace1",
      messageId,
      toolCallId: "tool3",
      toolName: "status_set",
      args: { emoji: "🔄", message: "New PR", url: newUrl },
      tokens: 10,
      timestamp: Date.now(),
    });

    aggregator.handleToolCallEnd({
      type: "tool-call-end",
      workspaceId: "workspace1",
      messageId,
      toolCallId: "tool3",
      toolName: "status_set",
      result: { success: true, emoji: "🔄", message: "New PR", url: newUrl },
      timestamp: Date.now(),
    });

    const finalStatus = aggregator.getAgentStatus();
    expect(finalStatus?.emoji).toBe("🔄");
    expect(finalStatus?.message).toBe("New PR");
    expect(finalStatus?.url).toBe(newUrl); // URL replaced
  });

  it("should persist URL even after status is cleared by new stream start", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");
    const messageId1 = "msg1";

    // Start first stream
    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId: "workspace1",
      messageId: messageId1,
      model: "test-model",
      historySequence: 1,
    });

    // Set status with URL in first stream
    const testUrl = "https://github.com/owner/repo/pull/123";
    aggregator.handleToolCallStart({
      type: "tool-call-start",
      workspaceId: "workspace1",
      messageId: messageId1,
      toolCallId: "tool1",
      toolName: "status_set",
      args: { emoji: "🔗", message: "PR submitted", url: testUrl },
      tokens: 10,
      timestamp: Date.now(),
    });

    aggregator.handleToolCallEnd({
      type: "tool-call-end",
      workspaceId: "workspace1",
      messageId: messageId1,
      toolCallId: "tool1",
      toolName: "status_set",
      result: { success: true, emoji: "🔗", message: "PR submitted", url: testUrl },
      timestamp: Date.now(),
    });

    expect(aggregator.getAgentStatus()?.url).toBe(testUrl);

    // User sends a new message, which clears the status
    const userMessage = {
      type: "message" as const,
      id: "user1",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "Continue" }],
      metadata: { timestamp: Date.now(), historySequence: 2 },
    };
    aggregator.handleMessage(userMessage);

    expect(aggregator.getAgentStatus()).toBeUndefined(); // Status cleared

    // Start second stream
    const messageId2 = "msg2";
    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId: "workspace1",
      messageId: messageId2,
      model: "test-model",
      historySequence: 2,
    });

    // Set new status WITHOUT URL - should use the last URL ever seen
    aggregator.handleToolCallStart({
      type: "tool-call-start",
      workspaceId: "workspace1",
      messageId: messageId2,
      toolCallId: "tool2",
      toolName: "status_set",
      args: { emoji: "✅", message: "Tests passed" },
      tokens: 10,
      timestamp: Date.now(),
    });

    aggregator.handleToolCallEnd({
      type: "tool-call-end",
      workspaceId: "workspace1",
      messageId: messageId2,
      toolCallId: "tool2",
      toolName: "status_set",
      result: { success: true, emoji: "✅", message: "Tests passed" },
      timestamp: Date.now(),
    });

    const finalStatus = aggregator.getAgentStatus();
    expect(finalStatus?.emoji).toBe("✅");
    expect(finalStatus?.message).toBe("Tests passed");
    expect(finalStatus?.url).toBe(testUrl); // URL from previous stream persists!
  });

  it("should persist URL across multiple assistant messages when loading from history", () => {
    // Regression test: URL should persist even when only the most recent assistant message
    // has a status_set without a URL - the URL from an earlier message should be used
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");
    const testUrl = "https://github.com/owner/repo/pull/123";

    // Historical messages: first assistant sets URL, second assistant updates status without URL
    const historicalMessages = [
      {
        id: "user1",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "Make a PR" }],
        metadata: { timestamp: 1000, historySequence: 1 },
      },
      {
        id: "assistant1",
        role: "assistant" as const,
        parts: [
          {
            type: "dynamic-tool" as const,
            toolName: "status_set",
            toolCallId: "tool1",
            state: "output-available" as const,
            input: { emoji: "🔗", message: "PR submitted", url: testUrl },
            output: { success: true, emoji: "🔗", message: "PR submitted", url: testUrl },
            timestamp: 1001,
            tokens: 10,
          },
        ],
        metadata: { timestamp: 1001, historySequence: 2 },
      },
      {
        id: "user2",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "Continue" }],
        metadata: { timestamp: 2000, historySequence: 3 },
      },
      {
        id: "assistant2",
        role: "assistant" as const,
        parts: [
          {
            type: "dynamic-tool" as const,
            toolName: "status_set",
            toolCallId: "tool2",
            state: "output-available" as const,
            input: { emoji: "✅", message: "Tests passed" },
            output: { success: true, emoji: "✅", message: "Tests passed" }, // No URL!
            timestamp: 2001,
            tokens: 10,
          },
        ],
        metadata: { timestamp: 2001, historySequence: 4 },
      },
    ];

    aggregator.loadHistoricalMessages(historicalMessages);

    const status = aggregator.getAgentStatus();
    expect(status?.emoji).toBe("✅");
    expect(status?.message).toBe("Tests passed");
    // URL from the first assistant message should persist!
    expect(status?.url).toBe(testUrl);
  });

  // Note: URL persistence through compaction is handled via localStorage,
  // which is tested in integration tests. The aggregator saves lastStatusUrl
  // to localStorage when it changes, and loads it on construction.
});
