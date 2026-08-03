import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  TaskSendMessageToolResultSchema,
  TOOL_DEFINITIONS,
} from "@/common/utils/tools/toolDefinitions";

import { parseToolResult, requireTaskService, requireWorkspaceId } from "./toolUtils";

export const createTaskSendMessageTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.task_send_message.description,
    inputSchema: TOOL_DEFINITIONS.task_send_message.schema,
    execute: async (args): Promise<unknown> => {
      const workspaceId = requireWorkspaceId(config, "task_send_message");
      const taskService = requireTaskService(config, "task_send_message");
      const queueDispatchMode = args.queue_dispatch_mode ?? "tool-end";

      const result = await taskService.sendMessageToDescendantAgentTask(
        workspaceId,
        args.task_id,
        args.message,
        queueDispatchMode
      );

      if (result.success) {
        return parseToolResult(
          TaskSendMessageToolResultSchema,
          result.data.delivery === "accepted"
            ? { status: "accepted", taskId: args.task_id }
            : {
                status: "queued",
                taskId: args.task_id,
                ...(result.data.queueDispatchMode != null
                  ? { queueDispatchMode: result.data.queueDispatchMode }
                  : {}),
              },
          "task_send_message"
        );
      }

      const error = result.error;
      const toolResult =
        error.code === "not_found"
          ? { status: "not_found" as const, taskId: args.task_id }
          : error.code === "invalid_scope"
            ? { status: "invalid_scope" as const, taskId: args.task_id }
            : error.code === "not_active"
              ? {
                  status: "not_active" as const,
                  taskId: args.task_id,
                  taskStatus: error.taskStatus,
                  error:
                    error.message ??
                    `Task is ${error.taskStatus} and cannot accept updated guidance.`,
                }
              : { status: "error" as const, taskId: args.task_id, error: error.message };

      return parseToolResult(TaskSendMessageToolResultSchema, toolResult, "task_send_message");
    },
  });
};
