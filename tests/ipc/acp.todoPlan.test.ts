import type {
  AgentSideConnection,
  SessionNotification,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { WorkspaceChatMessage } from "../../src/common/orpc/types";
import { StreamTranslator } from "../../src/node/acp/streamTranslator";

function createHarness(): {
  translator: StreamTranslator;
  sessionUpdates: SessionNotification[];
} {
  const sessionUpdates: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (params: SessionNotification) => {
      sessionUpdates.push(params);
    },
  } satisfies Pick<AgentSideConnection, "sessionUpdate">;

  return {
    translator: new StreamTranslator(connection as AgentSideConnection),
    sessionUpdates,
  };
}

async function forwardEvents(
  translator: StreamTranslator,
  events: WorkspaceChatMessage[]
): Promise<void> {
  async function* stream(): AsyncIterable<WorkspaceChatMessage> {
    for (const event of events) {
      yield event;
    }
  }

  await translator.consumeAndForward("session-1", stream());
}

function getUpdateKinds(sessionUpdates: SessionNotification[]): string[] {
  return sessionUpdates.map((notification) => notification.update.sessionUpdate);
}

function makeToolCallStart(
  toolCallId: string,
  toolName: string,
  args: unknown,
  messageId = "msg-1"
): WorkspaceChatMessage {
  return {
    type: "tool-call-start",
    workspaceId: "workspace-1",
    messageId,
    toolCallId,
    toolName,
    args,
    tokens: 1,
    timestamp: 1,
  } as WorkspaceChatMessage;
}

function makeToolCallEnd(
  toolCallId: string,
  toolName: string,
  result: unknown,
  messageId = "msg-1"
): WorkspaceChatMessage {
  return {
    type: "tool-call-end",
    workspaceId: "workspace-1",
    messageId,
    toolCallId,
    toolName,
    result,
    timestamp: 2,
  } as WorkspaceChatMessage;
}

function makeStreamError(
  messageId: string,
  error: string,
  errorType = "api_error"
): WorkspaceChatMessage {
  return {
    type: "stream-error",
    messageId,
    error,
    errorType,
  } as WorkspaceChatMessage;
}

function makeUserMessage(
  text: string,
  options?: {
    replay?: boolean;
    metadata?: Record<string, unknown>;
  }
): WorkspaceChatMessage {
  return {
    type: "message",
    id: "user-1",
    role: "user",
    parts: [
      {
        type: "text",
        text,
      },
    ],
    metadata: options?.metadata,
    replay: options?.replay,
  } as WorkspaceChatMessage;
}

function getUserTextChunks(sessionUpdates: SessionNotification[]): string[] {
  return sessionUpdates.flatMap((notification) => {
    if (notification.update.sessionUpdate !== "user_message_chunk") {
      return [];
    }

    if (notification.update.content.type !== "text") {
      return [];
    }

    return [notification.update.content.text];
  });
}

describe("ACP todo_write plan translation", () => {
  it("emits ACP plan updates from todo_write tool input", async () => {
    const { translator, sessionUpdates } = createHarness();
    const todos = [
      { content: "Finished setup", status: "completed" },
      { content: "Implementing ACP mapping", status: "in_progress" },
      { content: "Run tests", status: "pending" },
    ] as const;

    await forwardEvents(translator, [
      makeToolCallStart("tool-1", "todo_write", { todos }),
      makeToolCallEnd("tool-1", "todo_write", { success: true, count: todos.length }),
    ]);

    expect(getUpdateKinds(sessionUpdates)).toEqual(["tool_call", "tool_call_update", "plan"]);

    const planUpdate = sessionUpdates[2]?.update;
    expect(planUpdate).toBeDefined();
    if (planUpdate == null || planUpdate.sessionUpdate !== "plan") {
      throw new Error("Expected third session update to be a plan update");
    }

    expect(planUpdate.entries).toEqual([
      { content: "Finished setup", status: "completed", priority: "medium" },
      { content: "Implementing ACP mapping", status: "in_progress", priority: "medium" },
      { content: "Run tests", status: "pending", priority: "medium" },
    ]);
  });

  it("accepts JSON-string tool input and still emits plan update", async () => {
    const { translator, sessionUpdates } = createHarness();
    const serializedInput = JSON.stringify({
      todos: [{ content: "Clear plan", status: "completed", priority: "high" }],
    });

    await forwardEvents(translator, [
      makeToolCallStart("tool-2", "todo_write", serializedInput),
      makeToolCallEnd("tool-2", "todo_write", { success: true, count: 1 }),
    ]);

    const planUpdate = sessionUpdates.find(
      (notification) => notification.update.sessionUpdate === "plan"
    )?.update;
    expect(planUpdate).toBeDefined();
    if (planUpdate == null || planUpdate.sessionUpdate !== "plan") {
      throw new Error("Expected todo_write with JSON string input to emit a plan update");
    }

    expect(planUpdate.entries).toEqual([
      {
        content: "Clear plan",
        status: "completed",
        priority: "high",
      },
    ]);
  });

  it("does not emit plan update for non-todo tools", async () => {
    const { translator, sessionUpdates } = createHarness();

    await forwardEvents(translator, [
      makeToolCallStart("tool-3", "file_read", { path: "README.md" }),
      makeToolCallEnd("tool-3", "file_read", { content: "hello" }),
    ]);

    expect(getUpdateKinds(sessionUpdates)).toEqual(["tool_call", "tool_call_update"]);
  });

  it("skips plan update when todo_write reports failure", async () => {
    const { translator, sessionUpdates } = createHarness();

    await forwardEvents(translator, [
      makeToolCallStart("tool-4", "todo_write", {
        todos: [{ content: "This should not publish", status: "pending" }],
      }),
      makeToolCallEnd("tool-4", "todo_write", { success: false }),
    ]);

    expect(getUpdateKinds(sessionUpdates)).toEqual(["tool_call", "tool_call_update"]);
  });

  it("emits plan updates when replaying historical todo_write tool parts", async () => {
    const { translator, sessionUpdates } = createHarness();

    const replayMessage: WorkspaceChatMessage = {
      type: "message",
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "tool-5",
          toolName: "todo_write",
          input: {
            todos: [
              { content: "Completed previous task", status: "completed" },
              { content: "Current task", status: "in_progress" },
            ],
          },
          state: "output-available",
          output: { success: true, count: 2 },
        },
      ],
    } as WorkspaceChatMessage;

    await forwardEvents(translator, [replayMessage]);

    const kinds = getUpdateKinds(sessionUpdates);
    expect(kinds).toEqual(["tool_call", "tool_call_update", "plan"]);

    const planUpdate = sessionUpdates[2]?.update as Extract<
      SessionUpdate,
      { sessionUpdate: "plan" }
    >;
    expect(planUpdate.entries).toEqual([
      { content: "Completed previous task", status: "completed", priority: "medium" },
      { content: "Current task", status: "in_progress", priority: "medium" },
    ]);
  });
});

describe("ACP tool call terminal state translation", () => {
  it("fails every active tool call when a stream-level error arrives", async () => {
    const { translator, sessionUpdates } = createHarness();

    await forwardEvents(translator, [
      makeToolCallStart("tool-1", "file_read", { path: "README.md" }),
      makeToolCallStart("tool-2", "bash", { cmd: "echo hi" }),
      makeStreamError("msg-1", "provider timeout", "provider_error"),
    ]);

    expect(getUpdateKinds(sessionUpdates)).toEqual([
      "tool_call",
      "tool_call",
      "tool_call_update",
      "tool_call_update",
    ]);

    const failureUpdates = sessionUpdates
      .map((notification) => notification.update)
      .filter((update) => update.sessionUpdate === "tool_call_update");

    expect(failureUpdates).toHaveLength(2);
    expect(failureUpdates.map((update) => update.toolCallId)).toEqual(["tool-1", "tool-2"]);

    for (const update of failureUpdates) {
      expect(update.status).toBe("failed");
      expect(update._meta).toEqual({ errorType: "provider_error" });
      expect(update.content).toEqual([
        {
          type: "content",
          content: { type: "text", text: "provider timeout" },
        },
      ]);
    }
  });

  it("keeps replayed input-available tool calls in progress until terminal events", async () => {
    const { translator, sessionUpdates } = createHarness();

    const replayMessage: WorkspaceChatMessage = {
      type: "message",
      id: "assistant-pending",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "tool-pending",
          toolName: "bash",
          input: { cmd: "sleep 1" },
          state: "input-available",
        },
      ],
    } as WorkspaceChatMessage;

    await forwardEvents(translator, [
      replayMessage,
      makeToolCallEnd("tool-pending", "bash", { exitCode: 0 }, "assistant-pending"),
    ]);

    expect(getUpdateKinds(sessionUpdates)).toEqual(["tool_call", "tool_call_update"]);

    const completionUpdate = sessionUpdates[1]?.update;
    expect(completionUpdate).toBeDefined();
    if (completionUpdate == null || completionUpdate.sessionUpdate !== "tool_call_update") {
      throw new Error("Expected replayed pending tool call to emit terminal tool_call_update");
    }

    expect(completionUpdate.toolCallId).toBe("tool-pending");
    expect(completionUpdate.status).toBe("completed");
    expect(completionUpdate.content).toEqual([
      {
        type: "content",
        content: { type: "text", text: JSON.stringify({ exitCode: 0 }) },
      },
    ]);
  });
});

describe("ACP user message translation for agent skills", () => {
  it("suppresses synthetic agent skill snapshot messages", async () => {
    const { translator, sessionUpdates } = createHarness();

    await forwardEvents(translator, [
      makeUserMessage('<agent-skill name="mux-docs" scope="built-in">...</agent-skill>', {
        metadata: {
          synthetic: true,
          agentSkillSnapshot: {
            skillName: "mux-docs",
            scope: "built-in",
            sha256: "abc123",
          },
        },
      }),
    ]);

    expect(getUpdateKinds(sessionUpdates)).toEqual([]);
  });

  it("suppresses live transformed skill invocation text", async () => {
    const { translator, sessionUpdates } = createHarness();

    await forwardEvents(translator, [
      makeUserMessage("Using skill mux-docs: what is mux?", {
        metadata: {
          muxMetadata: {
            type: "agent-skill",
            rawCommand: "/mux-docs what is mux?",
            skillName: "mux-docs",
            scope: "built-in",
          },
        },
      }),
    ]);

    expect(getUpdateKinds(sessionUpdates)).toEqual([]);
  });

  it("replays the original slash command for agent-skill history", async () => {
    const { translator, sessionUpdates } = createHarness();

    await forwardEvents(translator, [
      makeUserMessage("Using skill mux-docs: what is mux?", {
        replay: true,
        metadata: {
          muxMetadata: {
            type: "agent-skill",
            rawCommand: "/mux-docs what is mux?",
            skillName: "mux-docs",
            scope: "built-in",
          },
        },
      }),
    ]);

    expect(getUpdateKinds(sessionUpdates)).toEqual(["user_message_chunk"]);
    expect(getUserTextChunks(sessionUpdates)).toEqual(["/mux-docs what is mux?"]);
  });

  it("keeps forwarding normal user text messages", async () => {
    const { translator, sessionUpdates } = createHarness();

    await forwardEvents(translator, [makeUserMessage("plain user message")]);

    expect(getUpdateKinds(sessionUpdates)).toEqual(["user_message_chunk"]);
    expect(getUserTextChunks(sessionUpdates)).toEqual(["plain user message"]);
  });
});
