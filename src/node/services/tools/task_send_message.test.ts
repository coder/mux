import { describe, expect, it, mock } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { Err, Ok, type Result } from "@/common/types/result";
import type {
  SendAgentTaskMessageError,
  SendAgentTaskMessageResult,
  TaskService,
} from "@/node/services/taskService";

import { createTaskSendMessageTool } from "./task_send_message";
import { createTestToolConfig, TestTempDir } from "./testHelpers";

const toolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "task-send-message-call",
  messages: [],
  context: undefined,
};

describe("task_send_message tool", () => {
  it("defaults to tool-end dispatch and returns the service acceptance outcome", async () => {
    using tempDir = new TestTempDir("task-send-message-delivery");
    const sendMessageToDescendantAgentTask = mock(
      (): Promise<Result<SendAgentTaskMessageResult, SendAgentTaskMessageError>> =>
        Promise.resolve(Ok({ delivery: "queued", queueDispatchMode: "tool-end" }))
    );
    const taskService = { sendMessageToDescendantAgentTask } as unknown as TaskService;
    const tool = createTaskSendMessageTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "parent" }),
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_id: "child", message: "Use the API response type." }, toolCallOptions)
    );

    expect(sendMessageToDescendantAgentTask).toHaveBeenCalledWith(
      "parent",
      "child",
      "Use the API response type.",
      "tool-end"
    );
    expect(result).toEqual({
      status: "queued",
      taskId: "child",
      queueDispatchMode: "tool-end",
    });
  });

  it("maps inactive child reawakening without exposing the internal execution handle", async () => {
    using tempDir = new TestTempDir("task-send-message-reactivated");
    const sendMessageToDescendantAgentTask = mock(
      (): Promise<Result<SendAgentTaskMessageResult, SendAgentTaskMessageError>> =>
        Promise.resolve(Ok({ delivery: "reactivated", executionTaskId: "wst_internal_execution" }))
    );
    const taskService = { sendMessageToDescendantAgentTask } as unknown as TaskService;
    const tool = createTaskSendMessageTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "parent" }),
      taskService,
    });

    expect(
      await Promise.resolve(
        tool.execute!(
          { task_id: "child", message: "Investigate the new failure." },
          toolCallOptions
        )
      )
    ).toEqual({ status: "reactivated", taskId: "child" });
  });

  it("maps scope and task-state failures to actionable results", async () => {
    using tempDir = new TestTempDir("task-send-message-errors");
    const outcomes: SendAgentTaskMessageError[] = [
      { code: "invalid_scope" },
      { code: "not_active", taskStatus: "reported" },
    ];
    const taskService = {
      sendMessageToDescendantAgentTask: mock(
        (): Promise<Result<SendAgentTaskMessageResult, SendAgentTaskMessageError>> =>
          Promise.resolve(Err(outcomes.shift()!))
      ),
    } as unknown as TaskService;
    const tool = createTaskSendMessageTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "parent" }),
      taskService,
    });

    const invalidScopeResult: unknown = await Promise.resolve(
      tool.execute!(
        { task_id: "other", message: "Correction", queue_dispatch_mode: "turn-end" },
        toolCallOptions
      )
    );
    expect(invalidScopeResult).toEqual({ status: "invalid_scope", taskId: "other" });

    const notActiveResult: unknown = await Promise.resolve(
      tool.execute!({ task_id: "finished", message: "Correction" }, toolCallOptions)
    );
    expect(notActiveResult).toEqual({
      status: "not_active",
      taskId: "finished",
      taskStatus: "reported",
      error: "Task is reported and cannot accept updated guidance.",
    });
  });
});
