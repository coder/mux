import assert from "node:assert/strict";

import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  TaskTerminateToolResultSchema,
  TOOL_DEFINITIONS,
} from "@/common/utils/tools/toolDefinitions";

export const createTaskTerminateTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.task_terminate.description,
    inputSchema: TOOL_DEFINITIONS.task_terminate.schema,
    execute: async (args): Promise<unknown> => {
      assert(config.workspaceId, "task_terminate requires workspaceId");
      assert(config.taskService, "task_terminate requires taskService");

      const uniqueTaskIds = Array.from(new Set(args.task_ids));

      const results = await Promise.all(
        uniqueTaskIds.map(async (taskId) => {
          const terminateResult = await config.taskService!.terminateDescendantAgentTask(
            config.workspaceId!,
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

      const output = { results };
      const parsed = TaskTerminateToolResultSchema.safeParse(output);
      if (!parsed.success) {
        throw new Error(`task_terminate tool result validation failed: ${parsed.error.message}`);
      }

      return parsed.data;
    },
  });
};
