import { describe, test, expect } from "bun:test";
import { createMuxMessage, type DisplayedMessage } from "@/common/types/message";
import { MAX_HISTORY_HIDDEN_SEGMENTS } from "./transcriptTruncationPlan";
import { StreamingMessageAggregator } from "./StreamingMessageAggregator";

// Test helper: create aggregator with default createdAt for tests
const TEST_CREATED_AT = "2024-01-01T00:00:00.000Z";

// Test helper: enable debugLlmRequest for the duration of a test.
function withDebugLlmRequestEnabled<T>(fn: () => T): T {
  const globalWithWindow = globalThis as unknown as { window?: { api?: WindowApi } };

  const previousWindow = globalWithWindow.window;
  const previousApi = previousWindow?.api;
  const previousDebugLlmRequest = previousApi?.debugLlmRequest;

  globalWithWindow.window ??= {};
  globalWithWindow.window.api ??= { platform: process.platform, versions: {} };
  globalWithWindow.window.api.debugLlmRequest = true;

  try {
    return fn();
  } finally {
    if (!previousWindow) {
      delete globalWithWindow.window;
    } else {
      globalWithWindow.window = previousWindow;

      if (!previousApi) {
        delete previousWindow.api;
      } else {
        previousApi.debugLlmRequest = previousDebugLlmRequest;
        previousWindow.api = previousApi;
      }
    }
  }
}
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
        expect(initMsg2.lines[0]).toEqual({ line: "Line 1", isError: false });
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

  describe("display flags", () => {
    test("should hide synthetic messages by default", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      const synthetic = createMuxMessage("s1", "user", "synthetic", {
        timestamp: 1,
        historySequence: 1,
        synthetic: true,
      });
      const user = createMuxMessage("u1", "user", "hello", {
        timestamp: 2,
        historySequence: 2,
      });

      aggregator.loadHistoricalMessages([synthetic, user], false);

      const displayed = aggregator.getDisplayedMessages();
      const contents = displayed.filter((m) => m.type === "user").map((m) => m.content);

      expect(contents).toEqual(["hello"]);
    });

    test("should show uiVisible synthetic messages by default", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      const syntheticVisible = createMuxMessage("s1", "user", "synthetic visible", {
        timestamp: 1,
        historySequence: 1,
        synthetic: true,
        uiVisible: true,
      });
      const user = createMuxMessage("u1", "user", "hello", {
        timestamp: 2,
        historySequence: 2,
      });

      aggregator.loadHistoricalMessages([syntheticVisible, user], false);

      const displayed = aggregator.getDisplayedMessages();
      const userMessages = displayed.filter((m) => m.type === "user");

      expect(userMessages).toHaveLength(2);
      expect(userMessages[0]?.content).toBe("synthetic visible");
      expect(userMessages[0]?.isSynthetic).toBe(true);
      expect(userMessages[1]?.content).toBe("hello");
      expect(userMessages[1]?.isSynthetic).toBeUndefined();
    });

    test("should show synthetic messages when debugLlmRequest is enabled", () => {
      withDebugLlmRequestEnabled(() => {
        const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

        const synthetic = createMuxMessage("s1", "user", "synthetic", {
          timestamp: 1,
          historySequence: 1,
          synthetic: true,
        });
        const user = createMuxMessage("u1", "user", "hello", {
          timestamp: 2,
          historySequence: 2,
        });

        aggregator.loadHistoricalMessages([synthetic, user], false);

        const displayed = aggregator.getDisplayedMessages();
        const userMessages = displayed.filter((m) => m.type === "user");

        expect(userMessages).toHaveLength(2);
        expect(userMessages[0].content).toBe("synthetic");
        expect(userMessages[0].isSynthetic).toBe(true);
        expect(userMessages[1].content).toBe("hello");
        expect(userMessages[1].isSynthetic).toBeUndefined();
      });
    });

    test("should disable displayed message cap when showAllMessages is enabled", () => {
      // Test smart truncation: user messages are always kept, while older assistant/tool/
      // reasoning rows can be filtered behind a history-hidden marker.
      // Create a mix of message types: user messages with tool-heavy assistant responses.
      const manyMessages: Parameters<
        typeof StreamingMessageAggregator.prototype.loadHistoricalMessages
      >[0] = [];
      for (let i = 0; i < 100; i++) {
        const baseSequence = i * 3;
        // User message (always kept)
        manyMessages.push(
          createMuxMessage(`u${i}`, "user", `msg-${i}`, {
            timestamp: baseSequence,
            historySequence: baseSequence,
          })
        );
        // Assistant message that only contains reasoning + tool calls (omitted in old messages)
        manyMessages.push({
          id: `tool-msg-${i}`,
          role: "assistant" as const,
          parts: [
            { type: "reasoning" as const, text: `thinking-${i}` },
            {
              type: "dynamic-tool" as const,
              toolCallId: `tool${i}`,
              toolName: "bash",
              state: "output-available" as const,
              input: { script: "echo test" },
              output: { success: true, output: "test", exitCode: 0 },
            },
          ],
          metadata: {
            historySequence: baseSequence + 1,
            timestamp: baseSequence + 1,
            model: "claude-3-5-sonnet-20241022",
          },
        });
        // Assistant response message (always kept)
        manyMessages.push(
          createMuxMessage(`a${i}`, "assistant", `response-${i}`, {
            historySequence: baseSequence + 2,
            timestamp: baseSequence + 2,
            model: "claude-3-5-sonnet-20241022",
          })
        );
      }

      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      aggregator.loadHistoricalMessages(manyMessages, false);

      // Each pair produces 4 DisplayedMessages: user + reasoning + tool + assistant
      // Total: 100 user + 100 assistant + 100 tool + 100 reasoning = 400 DisplayedMessages
      // With cap at 64, the first 336 are candidates for filtering.
      // In those 336: user messages are kept, while assistant/tool/reasoning may be omitted.
      const capped = aggregator.getDisplayedMessages();

      const expectedHiddenCount = 252;
      const hiddenMessages = capped.filter(
        (msg): msg is Extract<DisplayedMessage, { type: "history-hidden" }> => {
          return msg.type === "history-hidden";
        }
      );
      expect(hiddenMessages).toHaveLength(MAX_HISTORY_HIDDEN_SEGMENTS);
      expect(hiddenMessages.every((msg) => msg.hiddenCount > 0)).toBe(true);
      expect(hiddenMessages.reduce((sum, msg) => sum + msg.hiddenCount, 0)).toBe(
        expectedHiddenCount
      );

      const firstHiddenIndex = capped.findIndex((msg) => msg.type === "history-hidden");
      expect(firstHiddenIndex).toBeGreaterThan(0);
      expect(firstHiddenIndex).toBeLessThan(capped.length - 1);
      expect(capped[firstHiddenIndex - 1]?.type).toBe("user");
      expect(capped[firstHiddenIndex + 1]?.type).toBe("user");

      // User prompts remain fully visible; older assistant rows can be omitted.
      const userMessages = capped.filter((m) => m.type === "user");
      const assistantMessages = capped.filter((m) => m.type === "assistant");
      expect(userMessages).toHaveLength(100);
      expect(assistantMessages.length).toBeLessThan(100);
      expect(assistantMessages.length).toBeGreaterThan(0);

      // Enable showAllMessages to see full history
      aggregator.setShowAllMessages(true);

      const displayed = aggregator.getDisplayedMessages();
      // Now all 400 messages should be visible (100 user + 100 assistant + 100 tool + 100 reasoning)
      expect(displayed).toHaveLength(400);
      expect(displayed.some((m) => m.type === "history-hidden")).toBe(false);
    });

    test("should cap history-hidden markers for alternating user/assistant history", () => {
      // Alternating user/assistant history creates many tiny omission runs.
      // We preserve locality for recent runs while capping marker rows to keep DOM size bounded.
      const manyMessages: Parameters<
        typeof StreamingMessageAggregator.prototype.loadHistoricalMessages
      >[0] = [];

      for (let i = 0; i < 200; i++) {
        const baseSequence = i * 2;
        manyMessages.push(
          createMuxMessage(`u${i}`, "user", `msg-${i}`, {
            timestamp: baseSequence,
            historySequence: baseSequence,
          })
        );
        manyMessages.push(
          createMuxMessage(`a${i}`, "assistant", `response-${i}`, {
            historySequence: baseSequence + 1,
            timestamp: baseSequence + 1,
            model: "claude-3-5-sonnet-20241022",
          })
        );
      }

      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      aggregator.loadHistoricalMessages(manyMessages, false);

      const displayed = aggregator.getDisplayedMessages();
      const hiddenMarkers = displayed.filter(
        (msg): msg is Extract<DisplayedMessage, { type: "history-hidden" }> => {
          return msg.type === "history-hidden";
        }
      );

      expect(hiddenMarkers).toHaveLength(MAX_HISTORY_HIDDEN_SEGMENTS);
      expect(hiddenMarkers.reduce((sum, marker) => sum + marker.hiddenCount, 0)).toBe(168);

      const hiddenIndices = displayed
        .map((msg, index) => (msg.type === "history-hidden" ? index : -1))
        .filter((index) => index !== -1);
      for (const hiddenIndex of hiddenIndices) {
        expect(hiddenIndex).toBeGreaterThan(0);
        expect(hiddenIndex).toBeLessThan(displayed.length - 1);
        expect(displayed[hiddenIndex - 1]?.type).toBe("user");
        expect(displayed[hiddenIndex + 1]?.type).toBe("user");
      }

      const userMessages = displayed.filter(
        (msg): msg is Extract<DisplayedMessage, { type: "user" }> => {
          return msg.type === "user";
        }
      );
      expect(userMessages).toHaveLength(200);

      // Rendered rows stay well below full history size because hidden markers are capped.
      expect(displayed.length).toBeLessThan(260);
    });

    test("should not show history-hidden when messages are below truncation threshold", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      aggregator.loadHistoricalMessages(
        [
          createMuxMessage("u1", "user", "first", { historySequence: 1, timestamp: 1 }),
          createMuxMessage("u2", "user", "second", { historySequence: 2, timestamp: 2 }),
          createMuxMessage("u3", "user", "third", { historySequence: 3, timestamp: 3 }),
        ],
        false
      );

      const displayed = aggregator.getDisplayedMessages();
      expect(displayed).toHaveLength(3);
      expect(displayed.some((msg) => msg.type === "history-hidden")).toBe(false);
    });

    test("should not show history-hidden when only user messages exceed cap", () => {
      // When all messages are user rows (always-keep type), no filtering occurs
      const manyMessages = Array.from({ length: 200 }, (_, i) =>
        createMuxMessage(`u${i}`, "user", `msg-${i}`, {
          timestamp: i,
          historySequence: i,
        })
      );

      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      aggregator.loadHistoricalMessages(manyMessages, false);

      const displayed = aggregator.getDisplayedMessages();
      // All 200 user messages are kept (user type is always preserved)
      expect(displayed).toHaveLength(200);
      expect(displayed.some((m) => m.type === "history-hidden")).toBe(false);
    });
  });

  describe("agent skill snapshot cache", () => {
    test("should invalidate cached hover snapshot when frontmatter changes", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      const snapshotText = "<agent-skill>\nBODY\n</agent-skill>";

      const snapshot1 = createMuxMessage("s1", "assistant", snapshotText, {
        timestamp: 1,
        historySequence: 1,
        synthetic: true,
        agentSkillSnapshot: {
          skillName: "test-skill",
          scope: "project",
          sha256: "sha-1",
          frontmatterYaml: "description: v1",
        },
      });

      const invocation = createMuxMessage("u1", "user", "/test-skill", {
        timestamp: 2,
        historySequence: 2,
        muxMetadata: {
          type: "agent-skill",
          rawCommand: "/test-skill",
          skillName: "test-skill",
          scope: "project",
        },
      });

      aggregator.addMessage(snapshot1);
      aggregator.addMessage(invocation);

      const displayed1 = aggregator.getDisplayedMessages();
      const user1 = displayed1.find((m) => m.type === "user" && m.id === "u1");
      expect(user1).toBeDefined();

      if (user1?.type === "user") {
        expect(user1.agentSkill?.snapshot?.frontmatterYaml).toBe("description: v1");
        expect(user1.agentSkill?.snapshot?.body).toBe("BODY");
      }

      // Update the snapshot frontmatter without changing body or sha256.
      const snapshot2 = createMuxMessage("s1", "assistant", snapshotText, {
        timestamp: 1,
        historySequence: 1,
        synthetic: true,
        agentSkillSnapshot: {
          skillName: "test-skill",
          scope: "project",
          sha256: "sha-1",
          frontmatterYaml: "description: v2",
        },
      });

      aggregator.addMessage(snapshot2);

      const displayed2 = aggregator.getDisplayedMessages();
      const user2 = displayed2.find((m) => m.type === "user" && m.id === "u1");
      expect(user2).toBeDefined();

      if (user2?.type === "user") {
        expect(user2.agentSkill?.snapshot?.frontmatterYaml).toBe("description: v2");
        expect(user2.agentSkill?.snapshot?.body).toBe("BODY");
      }

      // Cache should not reuse the prior DisplayedMessage when snapshot metadata changes.
      expect(user2).not.toBe(user1);
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

  describe("compaction boundary rows", () => {
    test("inserts a boundary row before compaction summary messages", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      const before = createMuxMessage("user-before", "user", "Before compaction", {
        historySequence: 1,
        timestamp: 1,
      });
      const summary = createMuxMessage("summary-1", "assistant", "Compacted summary", {
        historySequence: 2,
        timestamp: 2,
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 3,
        muxMetadata: { type: "compaction-summary" },
      });
      const after = createMuxMessage("user-after", "user", "After compaction", {
        historySequence: 3,
        timestamp: 3,
      });

      aggregator.loadHistoricalMessages([before, summary, after], false);

      const displayed = aggregator.getDisplayedMessages();
      expect(displayed.map((message) => message.type)).toEqual([
        "user",
        "compaction-boundary",
        "assistant",
        "user",
      ]);

      const boundary = displayed[1];
      expect(boundary?.type).toBe("compaction-boundary");

      if (boundary?.type === "compaction-boundary") {
        expect(boundary.position).toBe("start");
        expect(boundary.compactionEpoch).toBe(3);
        expect(boundary.historySequence).toBe(2);
      }
    });

    test("omits malformed compaction epoch values instead of crashing transcript rendering", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      const before = createMuxMessage("user-before", "user", "Before compaction", {
        historySequence: 1,
        timestamp: 1,
      });
      const summaryWithMalformedEpoch = createMuxMessage(
        "summary-malformed",
        "assistant",
        "Compacted summary",
        {
          historySequence: 2,
          timestamp: 2,
          compacted: "user",
          compactionBoundary: true,
          compactionEpoch: 0,
          muxMetadata: { type: "compaction-summary" },
        }
      );
      const after = createMuxMessage("user-after", "user", "After compaction", {
        historySequence: 3,
        timestamp: 3,
      });

      aggregator.loadHistoricalMessages([before, summaryWithMalformedEpoch, after], false);

      const displayed = aggregator.getDisplayedMessages();
      const boundaries = displayed.filter((message) => message.type === "compaction-boundary");

      expect(boundaries).toHaveLength(1);

      const boundary = boundaries[0];
      if (boundary?.type !== "compaction-boundary") {
        throw new Error("Expected compaction boundary message");
      }
      expect(boundary.compactionEpoch).toBeUndefined();
      expect(boundary.historySequence).toBe(2);
    });
  });

  describe("live compaction boundary pruning", () => {
    // handleMessage expects ChatMuxMessage (type: "message"), matching how the
    // backend emits events via emitChatEvent({ ...message, type: "message" }).
    const asChatMessage = (msg: ReturnType<typeof createMuxMessage>) => ({
      ...msg,
      type: "message" as const,
    });

    test("does not prune on first compaction (no penultimate boundary exists)", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      // Simulate messages accumulated during a live session (no prior compaction)
      const msg1 = asChatMessage(
        createMuxMessage("user-1", "user", "First message", {
          historySequence: 0,
          timestamp: 1,
        })
      );
      const msg2 = asChatMessage(
        createMuxMessage("assistant-1", "assistant", "Response", {
          historySequence: 1,
          timestamp: 2,
        })
      );

      aggregator.handleMessage(msg1);
      aggregator.handleMessage(msg2);

      // First compaction boundary arrives — no penultimate boundary to prune to
      const summary = asChatMessage(
        createMuxMessage("summary-1", "assistant", "Compacted summary", {
          historySequence: 2,
          compacted: "user",
          compactionBoundary: true,
          compactionEpoch: 1,
          muxMetadata: { type: "compaction-summary" },
        })
      );
      aggregator.handleMessage(summary);

      // All messages retained (first compaction, no penultimate boundary)
      const remaining = aggregator.getAllMessages();
      expect(remaining).toHaveLength(3);
    });

    test("prunes pre-penultimate messages on second compaction", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      // Epoch 0 messages (before any compaction)
      const epoch0Msg = asChatMessage(
        createMuxMessage("epoch0-user", "user", "Old message", {
          historySequence: 0,
          timestamp: 1,
        })
      );
      aggregator.handleMessage(epoch0Msg);

      // First compaction boundary (epoch 1)
      const boundary1 = asChatMessage(
        createMuxMessage("boundary-1", "assistant", "Summary epoch 1", {
          historySequence: 1,
          compacted: "user",
          compactionBoundary: true,
          compactionEpoch: 1,
          muxMetadata: { type: "compaction-summary" },
        })
      );
      aggregator.handleMessage(boundary1);

      // Epoch 1 messages
      const epoch1Msg = asChatMessage(
        createMuxMessage("epoch1-user", "user", "Message in epoch 1", {
          historySequence: 2,
          timestamp: 3,
        })
      );
      aggregator.handleMessage(epoch1Msg);

      // All 3 messages visible before second compaction
      expect(aggregator.getAllMessages()).toHaveLength(3);

      // Second compaction boundary (epoch 2) — should prune everything before boundary-1
      const boundary2 = asChatMessage(
        createMuxMessage("boundary-2", "assistant", "Summary epoch 2", {
          historySequence: 3,
          compacted: "user",
          compactionBoundary: true,
          compactionEpoch: 2,
          muxMetadata: { type: "compaction-summary" },
        })
      );
      aggregator.handleMessage(boundary2);

      // epoch0-user (seq 0) is before penultimate boundary (seq 1), so it's pruned.
      // Remaining: boundary-1 (seq 1), epoch1-user (seq 2), boundary-2 (seq 3)
      const remaining = aggregator.getAllMessages();
      expect(remaining).toHaveLength(3);
      expect(remaining.map((m) => m.id)).toEqual(["boundary-1", "epoch1-user", "boundary-2"]);
    });

    test("does not prune messages when a non-boundary message arrives", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      const msg1 = asChatMessage(
        createMuxMessage("user-1", "user", "First message", { historySequence: 0 })
      );
      const msg2 = asChatMessage(
        createMuxMessage("assistant-1", "assistant", "Normal response", { historySequence: 1 })
      );

      aggregator.handleMessage(msg1);
      aggregator.handleMessage(msg2);

      expect(aggregator.getAllMessages()).toHaveLength(2);
    });
  });

  describe("recency on stream completion", () => {
    test("bumps recency on final non-compaction stream end", () => {
      let callbackCompletedAt: number | null | undefined;
      const aggregator = new StreamingMessageAggregator(
        TEST_CREATED_AT,
        "test-workspace-recency-final"
      );
      aggregator.onResponseComplete = (_wid, _mid, _isFinal, _text, _compaction, completedAt) => {
        callbackCompletedAt = completedAt;
      };
      const initialRecency = aggregator.getRecencyTimestamp();
      expect(initialRecency).not.toBeNull();

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace-recency-final",
        messageId: "msg-1",
        historySequence: 1,
        model: "claude-3-5-sonnet-20241022",
        startTime: Date.now(),
      });

      const beforeEnd = Date.now();
      aggregator.handleStreamEnd({
        type: "stream-end",
        workspaceId: "test-workspace-recency-final",
        messageId: "msg-1",
        metadata: {
          historySequence: 1,
          timestamp: Date.now(),
          model: "claude-3-5-sonnet-20241022",
        },
        parts: [],
      });

      const recency = aggregator.getRecencyTimestamp();
      expect(recency).not.toBeNull();
      if (recency === null) {
        throw new Error("Expected recency timestamp after stream end");
      }
      expect(recency).toBeGreaterThanOrEqual(beforeEnd);

      // The same completion timestamp is passed to the callback so App.tsx
      // can write an identical lastRead value — no ms-boundary race.
      expect(callbackCompletedAt).toBe(recency);
    });

    test("does not bump on compaction stream end", () => {
      const aggregator = new StreamingMessageAggregator(
        TEST_CREATED_AT,
        "test-workspace-recency-compaction"
      );

      let callbackCompletedAt: number | null | undefined;
      aggregator.onResponseComplete = (_wid, _mid, _isFinal, _text, _compaction, completedAt) => {
        callbackCompletedAt = completedAt;
      };

      const initialRecency = aggregator.getRecencyTimestamp();
      expect(initialRecency).not.toBeNull();
      if (initialRecency === null) {
        throw new Error("Expected initial recency timestamp");
      }

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace-recency-compaction",
        messageId: "msg-1",
        historySequence: 1,
        model: "claude-3-5-sonnet-20241022",
        startTime: Date.now(),
        mode: "compact",
      });

      const beforeEnd = Date.now();
      aggregator.handleStreamEnd({
        type: "stream-end",
        workspaceId: "test-workspace-recency-compaction",
        messageId: "msg-1",
        metadata: {
          historySequence: 1,
          timestamp: Date.now(),
          model: "claude-3-5-sonnet-20241022",
        },
        parts: [],
      });

      const recency = aggregator.getRecencyTimestamp();
      expect(recency).toBe(initialRecency);
      if (recency !== null) {
        expect(recency).toBeLessThan(beforeEnd);
      }

      // completedAt IS passed to callback — App.tsx can mark active workspace as read
      // even after compaction, preventing false unread indicators.
      expect(callbackCompletedAt).not.toBeNull();
      expect(callbackCompletedAt).toBeGreaterThanOrEqual(beforeEnd);
    });

    test("does not bump on non-final stream end", () => {
      const aggregator = new StreamingMessageAggregator(
        TEST_CREATED_AT,
        "test-workspace-recency-non-final"
      );
      const initialRecency = aggregator.getRecencyTimestamp();
      expect(initialRecency).not.toBeNull();
      if (initialRecency === null) {
        throw new Error("Expected initial recency timestamp");
      }

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace-recency-non-final",
        messageId: "msg-1",
        historySequence: 1,
        model: "claude-3-5-sonnet-20241022",
        startTime: Date.now(),
      });

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace-recency-non-final",
        messageId: "msg-2",
        historySequence: 2,
        model: "claude-3-5-sonnet-20241022",
        startTime: Date.now(),
      });

      const beforeFirstEnd = Date.now();
      aggregator.handleStreamEnd({
        type: "stream-end",
        workspaceId: "test-workspace-recency-non-final",
        messageId: "msg-1",
        metadata: {
          historySequence: 1,
          timestamp: Date.now(),
          model: "claude-3-5-sonnet-20241022",
        },
        parts: [],
      });

      const recency = aggregator.getRecencyTimestamp();
      expect(recency).toBe(initialRecency);
      if (recency !== null) {
        expect(recency).toBeLessThan(beforeFirstEnd);
      }
    });

    test("does not bump in reconnection branch", () => {
      const aggregator = new StreamingMessageAggregator(
        TEST_CREATED_AT,
        "test-workspace-recency-reconnect"
      );
      const initialRecency = aggregator.getRecencyTimestamp();
      expect(initialRecency).not.toBeNull();
      if (initialRecency === null) {
        throw new Error("Expected initial recency timestamp");
      }

      const beforeEnd = Date.now();
      aggregator.handleStreamEnd({
        type: "stream-end",
        workspaceId: "test-workspace-recency-reconnect",
        messageId: "msg-1",
        metadata: {
          historySequence: 1,
          timestamp: Date.now(),
          model: "claude-3-5-sonnet-20241022",
        },
        parts: [],
      });

      const recency = aggregator.getRecencyTimestamp();
      expect(recency).toBe(initialRecency);
      if (recency !== null) {
        expect(recency).toBeLessThan(beforeEnd);
      }
    });
  });

  describe("incremental stream replay", () => {
    test("preserves last stream timestamp when replayed stream-start re-establishes context", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      const startTime = 1_000;
      const deltaTimestamp = 1_250;

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg-replay-1",
        historySequence: 1,
        model: "claude-3-5-sonnet-20241022",
        startTime,
      });

      aggregator.handleStreamDelta({
        type: "stream-delta",
        workspaceId: "test-workspace",
        messageId: "msg-replay-1",
        delta: "partial",
        tokens: 1,
        timestamp: deltaTimestamp,
      });

      const beforeReplayCursor = aggregator.getOnChatCursor();
      expect(beforeReplayCursor?.stream?.lastTimestamp).toBe(deltaTimestamp);

      // Since-mode reconnect can replay stream-start without replaying additional parts.
      // Cursor timestamp must remain monotonic to avoid requesting duplicate events.
      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg-replay-1",
        historySequence: 1,
        model: "claude-3-5-sonnet-20241022",
        startTime,
        replay: true,
      });

      const afterReplayCursor = aggregator.getOnChatCursor();
      expect(afterReplayCursor?.stream?.lastTimestamp).toBe(deltaTimestamp);
    });

    test("marks streamed assistant rows as replay presentation when stream-start is replayed", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg-replay-presentation",
        historySequence: 1,
        model: "claude-3-5-sonnet-20241022",
        startTime: 1_000,
        replay: true,
      });

      aggregator.handleStreamDelta({
        type: "stream-delta",
        workspaceId: "test-workspace",
        messageId: "msg-replay-presentation",
        delta: "replayed partial",
        tokens: 1,
        timestamp: 1_100,
        replay: true,
      });

      const displayed = aggregator.getDisplayedMessages();
      const assistant = displayed.find(
        (message): message is Extract<(typeof displayed)[number], { type: "assistant" }> =>
          message.type === "assistant" && message.historyId === "msg-replay-presentation"
      );

      expect(assistant).toBeDefined();
      expect(assistant?.streamPresentation).toEqual({ source: "replay" });
    });
    test("switches streaming presentation from replay to live when non-replay delta arrives", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      // Reconnect: stream-start with replay flag
      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg-replay-to-live",
        historySequence: 1,
        model: "claude-3-5-sonnet-20241022",
        startTime: 1_000,
        replay: true,
      });

      // Replay catch-up delta (tagged with replay)
      aggregator.handleStreamDelta({
        type: "stream-delta",
        workspaceId: "test-workspace",
        messageId: "msg-replay-to-live",
        delta: "cached ",
        tokens: 1,
        timestamp: 1_100,
        replay: true,
      });

      // During replay: source should be "replay"
      const duringReplay = aggregator.getDisplayedMessages();
      const replayRow = duringReplay.find(
        (message): message is Extract<(typeof duringReplay)[number], { type: "assistant" }> =>
          message.type === "assistant" && message.historyId === "msg-replay-to-live"
      );
      expect(replayRow?.streamPresentation).toEqual({ source: "replay" });

      // Fresh live delta (no replay flag) — catch-up is over
      aggregator.handleStreamDelta({
        type: "stream-delta",
        workspaceId: "test-workspace",
        messageId: "msg-replay-to-live",
        delta: "fresh tokens",
        tokens: 2,
        timestamp: 1_200,
      });

      // After live resume: source should flip to "live"
      const afterLive = aggregator.getDisplayedMessages();
      const liveRow = afterLive.find(
        (message): message is Extract<(typeof afterLive)[number], { type: "assistant" }> =>
          message.type === "assistant" && message.historyId === "msg-replay-to-live"
      );
      expect(liveRow?.streamPresentation).toEqual({ source: "live" });
    });

    test("does not exit replay phase on non-replay tool events arriving before replay text drains", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      // Reconnect: stream-start with replay flag
      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg-tool-during-replay",
        historySequence: 1,
        model: "claude-3-5-sonnet-20241022",
        startTime: 1_000,
        replay: true,
      });

      // Replay catch-up delta
      aggregator.handleStreamDelta({
        type: "stream-delta",
        workspaceId: "test-workspace",
        messageId: "msg-tool-during-replay",
        delta: "cached ",
        tokens: 1,
        timestamp: 1_100,
        replay: true,
      });

      // Non-replay tool event arrives before replay text finishes draining.
      // Tool events are not buffered by the reconnect relay, so they can
      // arrive without the replay flag even while replay text is still in-flight.
      aggregator.handleToolCallStart({
        type: "tool-call-start",
        workspaceId: "test-workspace",
        messageId: "msg-tool-during-replay",
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "echo hi" },
        tokens: 1,
        timestamp: 1_150,
      });

      // Another replay delta arrives (still part of catch-up)
      aggregator.handleStreamDelta({
        type: "stream-delta",
        workspaceId: "test-workspace",
        messageId: "msg-tool-during-replay",
        delta: "tail",
        tokens: 1,
        timestamp: 1_200,
        replay: true,
      });

      // Source must still be "replay" — tool event must not have flipped it
      const displayed = aggregator.getDisplayedMessages();
      const assistantRows = displayed.filter(
        (message): message is Extract<(typeof displayed)[number], { type: "assistant" }> =>
          message.type === "assistant" && message.historyId === "msg-tool-during-replay"
      );
      const assistant = assistantRows.at(-1);
      expect(assistant?.streamPresentation).toEqual({ source: "replay" });
    });
  });

  describe("append replay cache invalidation", () => {
    test("rebuilds displayed rows when append replay overwrites an existing message id", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      const partialMessage = createMuxMessage("msg-overwrite-1", "assistant", "partial", {
        historySequence: 1,
        timestamp: 1,
      });
      aggregator.loadHistoricalMessages([partialMessage], false);

      const initialDisplayed = aggregator.getDisplayedMessages();
      const initialAssistant = initialDisplayed.find(
        (message): message is Extract<(typeof initialDisplayed)[number], { type: "assistant" }> =>
          message.type === "assistant" && message.historyId === "msg-overwrite-1"
      );
      expect(initialAssistant).toBeDefined();
      expect(initialAssistant?.content).toBe("partial");

      const finalizedMessage = createMuxMessage("msg-overwrite-1", "assistant", "finalized", {
        historySequence: 1,
        timestamp: 2,
      });
      aggregator.loadHistoricalMessages([finalizedMessage], false, { mode: "append" });

      const updatedDisplayed = aggregator.getDisplayedMessages();
      const updatedAssistant = updatedDisplayed.find(
        (message): message is Extract<(typeof updatedDisplayed)[number], { type: "assistant" }> =>
          message.type === "assistant" && message.historyId === "msg-overwrite-1"
      );

      expect(updatedAssistant).toBeDefined();
      expect(updatedAssistant?.content).toBe("finalized");
      expect(updatedAssistant).not.toBe(initialAssistant);
    });
  });

  test("keeps richer in-memory parts when append replay sends a stale duplicate", () => {
    const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId: "test-workspace",
      messageId: "msg-stale-append",
      historySequence: 1,
      model: "claude-3-5-sonnet-20241022",
      startTime: 1_000,
    });

    aggregator.handleToolCallStart({
      type: "tool-call-start",
      workspaceId: "test-workspace",
      messageId: "msg-stale-append",
      toolCallId: "tool-stale-append",
      toolName: "bash",
      args: { command: "echo hi" },
      tokens: 1,
      timestamp: 1_100,
    });

    aggregator.handleStreamDelta({
      type: "stream-delta",
      workspaceId: "test-workspace",
      messageId: "msg-stale-append",
      delta: "tool output pending",
      tokens: 1,
      timestamp: 1_200,
    });

    const existingMessage = aggregator
      .getAllMessages()
      .find((message) => message.id === "msg-stale-append");
    expect(existingMessage).toBeDefined();
    expect(existingMessage?.parts.length).toBeGreaterThan(1);

    const staleReplayMessage = createMuxMessage("msg-stale-append", "assistant", "placeholder", {
      historySequence: 1,
      timestamp: 1_050,
    });
    aggregator.loadHistoricalMessages([staleReplayMessage], true, { mode: "append" });

    const updatedMessage = aggregator
      .getAllMessages()
      .find((message) => message.id === "msg-stale-append");
    expect(updatedMessage).toBeDefined();
    expect(updatedMessage).toBe(existingMessage);
    expect(updatedMessage?.parts.length).toBeGreaterThan(1);
    expect(updatedMessage?.parts.some((part) => part.type === "dynamic-tool")).toBe(true);
  });

  describe("compaction detection", () => {
    test("treats active stream as compacting on reconnect when stream-start has no mode", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      const compactionRequestMessage = {
        id: "msg1",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "/compact" }],
        metadata: {
          historySequence: 1,
          timestamp: Date.now(),
          muxMetadata: {
            type: "compaction-request" as const,
            rawCommand: "/compact",
            parsed: { model: "anthropic:claude-3-5-haiku-20241022" },
          },
        },
      };

      aggregator.loadHistoricalMessages([compactionRequestMessage], true);

      // Older stream-start events may omit `mode`.
      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg2",
        historySequence: 2,
        model: "anthropic:claude-3-5-haiku-20241022",
        startTime: Date.now(),
      });

      expect(aggregator.isCompacting()).toBe(true);
    });

    test("treats active stream as compacting on reconnect when stream-start mode is exec", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      const compactionRequestMessage = {
        id: "msg1",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "/compact" }],
        metadata: {
          historySequence: 1,
          timestamp: Date.now(),
          muxMetadata: {
            type: "compaction-request" as const,
            rawCommand: "/compact",
            parsed: { model: "anthropic:claude-3-5-haiku-20241022" },
          },
        },
      };

      aggregator.loadHistoricalMessages([compactionRequestMessage], true);

      // The backend may send mode="exec" even for compaction streams (mode is derived from
      // the resolved agent/toolchain), so we must not treat non-compact mode as a negative.
      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg2",
        historySequence: 2,
        model: "anthropic:claude-3-5-haiku-20241022",
        startTime: Date.now(),
        mode: "exec",
      });

      expect(aggregator.isCompacting()).toBe(true);
    });

    test("treats active stream as compacting when user message is a compaction-request and stream-start mode is exec", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleMessage({
        type: "message",
        id: "msg1",
        role: "user",
        parts: [{ type: "text", text: "/compact" }],
        metadata: {
          historySequence: 1,
          timestamp: Date.now(),
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            parsed: { model: "anthropic:claude-3-5-haiku-20241022" },
          },
        },
      });

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg2",
        historySequence: 2,
        model: "anthropic:claude-3-5-haiku-20241022",
        startTime: Date.now(),
        mode: "exec",
      });

      expect(aggregator.isCompacting()).toBe(true);
    });

    test("treats mode=compact as authoritative", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg1",
        historySequence: 1,
        model: "anthropic:claude-3-5-haiku-20241022",
        startTime: Date.now(),
        mode: "compact",
      });

      expect(aggregator.isCompacting()).toBe(true);
    });
  });

  describe("pending stream model", () => {
    test("tracks requestedModel for pending user messages", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleMessage({
        type: "message",
        id: "msg1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
        metadata: {
          historySequence: 1,
          timestamp: Date.now(),
          muxMetadata: {
            type: "normal",
            requestedModel: "anthropic:claude-sonnet-4-5",
          },
        },
      });

      expect(aggregator.getPendingStreamModel()).toBe("anthropic:claude-sonnet-4-5");
    });

    test("tracks requestedModel for compaction requests", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleMessage({
        type: "message",
        id: "msg1",
        role: "user",
        parts: [{ type: "text", text: "/compact" }],
        metadata: {
          historySequence: 1,
          timestamp: Date.now(),
          muxMetadata: {
            type: "compaction-request",
            requestedModel: "anthropic:claude-sonnet-4-5",
            parsed: { model: "anthropic:claude-sonnet-4-5" },
          },
        },
      });

      expect(aggregator.getPendingStreamModel()).toBe("anthropic:claude-sonnet-4-5");
    });

    test("clears pending stream model on stream-start", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleMessage({
        type: "message",
        id: "msg1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
        metadata: {
          historySequence: 1,
          timestamp: Date.now(),
          muxMetadata: {
            type: "normal",
            requestedModel: "anthropic:claude-sonnet-4-5",
          },
        },
      });

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg2",
        historySequence: 2,
        model: "anthropic:claude-sonnet-4-5",
        startTime: Date.now(),
      });

      expect(aggregator.getPendingStreamModel()).toBeNull();
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

  describe("abort reason tracking", () => {
    test("stores last abort reason and clears on stream-start", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleStreamAbort({
        type: "stream-abort",
        workspaceId: "test-workspace",
        messageId: "msg-1",
        abortReason: "startup",
      });

      expect(aggregator.getLastAbortReason()?.reason).toBe("startup");

      aggregator.handleStreamStart({
        type: "stream-start",
        workspaceId: "test-workspace",
        messageId: "msg-1",
        historySequence: 1,
        model: "claude-3-5-sonnet-20241022",
        startTime: Date.now(),
      });

      expect(aggregator.getLastAbortReason()).toBeNull();
    });

    test("clears last abort reason on new user message", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleStreamAbort({
        type: "stream-abort",
        workspaceId: "test-workspace",
        messageId: "msg-1",
        abortReason: "user",
      });

      aggregator.handleMessage({
        ...createMuxMessage("user-1", "user", "Hello", { historySequence: 1 }),
        type: "message",
      });

      expect(aggregator.getLastAbortReason()).toBeNull();
    });

    test("clears last abort reason on clear", () => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

      aggregator.handleStreamAbort({
        type: "stream-abort",
        workspaceId: "test-workspace",
        messageId: "msg-1",
        abortReason: "user",
      });

      aggregator.clear();

      expect(aggregator.getLastAbortReason()).toBeNull();
    });
  });
});
