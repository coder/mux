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

describe("StreamingMessageAggregator - Agent Status", () => {
  it("should start with undefined agent status", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");
    expect(aggregator.getAgentStatus()).toBeUndefined();
  });

  it("should update agent status when receiving agent-status-update", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");

    aggregator.handleMessage({
      type: "agent-status-update",
      workspaceId: "workspace1",
      status: {
        emoji: "🚀",
        message: "PR #1 checks running",
        url: "https://github.com/example/repo/pull/1",
      },
    });

    expect(aggregator.getAgentStatus()).toEqual({
      emoji: "🚀",
      message: "PR #1 checks running",
      url: "https://github.com/example/repo/pull/1",
    });

    // URL should persist when subsequent updates omit it
    aggregator.handleMessage({
      type: "agent-status-update",
      workspaceId: "workspace1",
      status: {
        emoji: "🟡",
        message: "PR #1 mergeable",
      },
    });

    expect(aggregator.getAgentStatus()).toEqual({
      emoji: "🟡",
      message: "PR #1 mergeable",
      url: "https://github.com/example/repo/pull/1",
    });
  });

  it("should not update agent status from status_set tool results", () => {
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
      args: {
        script: "echo '🚀 PR #1 https://github.com/example/repo/pull/1'",
        poll_interval_ms: 0,
      },
      tokens: 10,
      timestamp: Date.now(),
    });

    // Complete the tool call (success is just an acknowledgement)
    aggregator.handleToolCallEnd({
      type: "tool-call-end",
      workspaceId: "workspace1",
      messageId,
      toolCallId,
      toolName: "status_set",
      result: { success: true },
      timestamp: Date.now(),
    });

    expect(aggregator.getAgentStatus()).toBeUndefined();
  });

  it("should persist agent status after stream ends", () => {
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

    // Status arrives via agent-status-update
    aggregator.handleMessage({
      type: "agent-status-update",
      workspaceId: "workspace1",
      status: {
        emoji: "🔍",
        message: "Working",
        url: "https://github.com/example/repo/pull/1",
      },
    });

    // End the stream
    aggregator.handleStreamEnd({
      type: "stream-end",
      workspaceId: "workspace1",
      messageId,
      metadata: { model: "test-model" },
      parts: [],
    });

    expect(aggregator.getAgentStatus()).toEqual({
      emoji: "🔍",
      message: "Working",
      url: "https://github.com/example/repo/pull/1",
    });
  });

  it("should keep agent status unchanged when status_set tool call fails", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");
    const messageId = "msg1";

    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId: "workspace1",
      messageId,
      model: "test-model",
      historySequence: 1,
    });

    // Establish a status via agent-status-update
    aggregator.handleMessage({
      type: "agent-status-update",
      workspaceId: "workspace1",
      status: {
        emoji: "🟡",
        message: "CI running",
        url: "https://github.com/example/repo/pull/1",
      },
    });

    // A failing status_set tool call should not wipe status
    aggregator.handleToolCallEnd({
      type: "tool-call-end",
      workspaceId: "workspace1",
      messageId,
      toolCallId: "tool1",
      toolName: "status_set",
      result: { success: false, error: "Something went wrong" },
      timestamp: Date.now(),
    });

    expect(aggregator.getAgentStatus()).toEqual({
      emoji: "🟡",
      message: "CI running",
      url: "https://github.com/example/repo/pull/1",
    });
  });

  it("should not clear agent status when new user message arrives", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");

    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId: "workspace1",
      messageId: "msg1",
      model: "test-model",
      historySequence: 1,
    });

    aggregator.handleMessage({
      type: "agent-status-update",
      workspaceId: "workspace1",
      status: {
        emoji: "🔍",
        message: "First task",
        url: "https://github.com/example/repo/pull/1",
      },
    });

    expect(aggregator.getAgentStatus()?.message).toBe("First task");

    // User sends a NEW message - status should persist
    const newUserMessage = {
      type: "message" as const,
      id: "msg2",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "What's next?" }],
      metadata: { timestamp: Date.now(), historySequence: 2 },
    };
    aggregator.handleMessage(newUserMessage);

    expect(aggregator.getAgentStatus()?.url).toBe("https://github.com/example/repo/pull/1");
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

    // Add a status_set tool call
    aggregator.handleToolCallStart({
      type: "tool-call-start",
      workspaceId: "workspace1",
      messageId,
      toolCallId: "tool1",
      toolName: "status_set",
      args: { script: "echo 'not important'", poll_interval_ms: 0 },
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

  it("should show 'completed' status in UI when status_set succeeds", () => {
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

    // Add a successful status_set tool call
    aggregator.handleToolCallStart({
      type: "tool-call-start",
      workspaceId: "workspace1",
      messageId,
      toolCallId: "tool1",
      toolName: "status_set",
      args: {
        script: "echo '🚀 PR #1 https://github.com/example/repo/pull/1'",
        poll_interval_ms: 0,
      },
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
      result: { success: true },
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

    // And agent status is unchanged (status is delivered via agent-status-update events)
    expect(aggregator.getAgentStatus()).toBeUndefined();
  });

  it("should not reconstruct agent status from historical status_set tool calls", () => {
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

    // status_set does not reconstruct agent status from history (status is ephemeral and persisted separately)
    expect(aggregator.getAgentStatus()).toBeUndefined();
  });

  it("should not reconstruct agent status even if multiple historical status_set tool calls exist", () => {
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

    expect(aggregator.getAgentStatus()).toBeUndefined();
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

  it("should rehydrate agent status from persisted localStorage", () => {
    const workspaceId = "workspace1";
    const key = getStatusStateKey(workspaceId);

    const aggregator1 = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");
    aggregator1.handleMessage({
      type: "agent-status-update",
      workspaceId,
      status: {
        emoji: "🚀",
        message: "PR #1 checks running",
        url: "https://github.com/example/repo/pull/1",
      },
    });

    expect((globalThis as { localStorage: Storage }).localStorage.getItem(key)).not.toBeNull();

    const aggregator2 = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");
    expect(aggregator2.getAgentStatus()).toEqual({
      emoji: "🚀",
      message: "PR #1 checks running",
      url: "https://github.com/example/repo/pull/1",
    });
  });

  it("should store URL when provided in agent-status-update", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");

    const testUrl = "https://github.com/owner/repo/pull/123";
    aggregator.handleMessage({
      type: "agent-status-update",
      workspaceId: "workspace1",
      status: {
        emoji: "🔗",
        message: "PR submitted",
        url: testUrl,
      },
    });

    expect(aggregator.getAgentStatus()).toEqual({
      emoji: "🔗",
      message: "PR submitted",
      url: testUrl,
    });
  });

  it("should persist URL across agent-status-update events until explicitly replaced", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");

    const testUrl = "https://github.com/owner/repo/pull/123";
    aggregator.handleMessage({
      type: "agent-status-update",
      workspaceId: "workspace1",
      status: { emoji: "🔗", message: "PR submitted", url: testUrl },
    });

    expect(aggregator.getAgentStatus()?.url).toBe(testUrl);

    // Update without URL - should keep previous URL
    aggregator.handleMessage({
      type: "agent-status-update",
      workspaceId: "workspace1",
      status: { emoji: "✅", message: "Done" },
    });

    expect(aggregator.getAgentStatus()).toEqual({
      emoji: "✅",
      message: "Done",
      url: testUrl,
    });

    // Update with a different URL - should replace
    const newUrl = "https://github.com/owner/repo/pull/456";
    aggregator.handleMessage({
      type: "agent-status-update",
      workspaceId: "workspace1",
      status: { emoji: "🔄", message: "New PR", url: newUrl },
    });

    expect(aggregator.getAgentStatus()).toEqual({
      emoji: "🔄",
      message: "New PR",
      url: newUrl,
    });
  });

  it("should persist URL across user turns and stream boundaries", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");

    const testUrl = "https://github.com/owner/repo/pull/123";
    aggregator.handleMessage({
      type: "agent-status-update",
      workspaceId: "workspace1",
      status: { emoji: "🔗", message: "PR submitted", url: testUrl },
    });

    expect(aggregator.getAgentStatus()?.url).toBe(testUrl);

    // User sends a follow-up
    aggregator.handleMessage({
      type: "message" as const,
      id: "user1",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "Continue" }],
      metadata: { timestamp: Date.now(), historySequence: 2 },
    });

    expect(aggregator.getAgentStatus()?.url).toBe(testUrl);

    // New stream starts
    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId: "workspace1",
      messageId: "msg2",
      model: "test-model",
      historySequence: 2,
    });

    // Status update without URL retains last URL
    aggregator.handleMessage({
      type: "agent-status-update",
      workspaceId: "workspace1",
      status: { emoji: "✅", message: "Tests passed" },
    });

    expect(aggregator.getAgentStatus()).toEqual({
      emoji: "✅",
      message: "Tests passed",
      url: testUrl,
    });
  });

  it("should not reconstruct URL from history tool calls", () => {
    // status is ephemeral and persisted outside chat history; historical tool calls should not
    // reconstruct the status/link.
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

    expect(aggregator.getAgentStatus()).toBeUndefined();
  });

  // Note: URL persistence through compaction is handled via localStorage,
  // which is tested in integration tests. The aggregator saves lastStatusUrl
  // to localStorage when it changes, and loads it on construction.
});
