import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  TaskTerminateToolResultSchema,
  TOOL_DEFINITIONS,
} from "@/common/utils/tools/toolDefinitions";

import {
  dedupeStrings,
  parseToolResult,
  requireTaskService,
  requireWorkspaceId,
} from "./toolUtils";

export const createTaskTerminateTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.task_terminate.description,
    inputSchema: TOOL_DEFINITIONS.task_terminate.schema,
    execute: async (args): Promise<unknown> => {
      const workspaceId = requireWorkspaceId(config, "task_terminate");
      const taskService = requireTaskService(config, "task_terminate");

      const uniqueTaskIds = dedupeStrings(args.task_ids);

      const results = await Promise.all(
        uniqueTaskIds.map(async (taskId) => {
          const terminateResult = await taskService.terminateDescendantAgentTask(
            workspaceId,
            taskId
          );
          if (!terminateResult.success) {
            const msg = terminateResult.error;
            if (/not found/i.test(msg)) {
              return { status: "not_found" as const, taskId };
            }
            if (/descendant/i.test(msg) || /scope/i.test(msg)) {
              return { status: "invalid_scope" as const, taskId };
            }
            return { status: "error" as const, taskId, error: msg };
          }

          return {
            status: "terminated" as const,
            taskId,
            terminatedTaskIds: terminateResult.data.terminatedTaskIds,
          };
        })
      );

      return parseToolResult(TaskTerminateToolResultSchema, { results }, "task_terminate");
    },
  });
};
