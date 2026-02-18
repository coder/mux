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
