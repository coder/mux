import assert from "node:assert/strict";

import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TaskListToolResultSchema, TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

const DEFAULT_STATUSES = ["queued", "running", "awaiting_report"] as const;

export const createTaskListTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.task_list.description,
    inputSchema: TOOL_DEFINITIONS.task_list.schema,
    execute: (args): unknown => {
      assert(config.workspaceId, "task_list requires workspaceId");
      assert(config.taskService, "task_list requires taskService");

      const statuses =
        args.statuses && args.statuses.length > 0 ? args.statuses : [...DEFAULT_STATUSES];
      const tasks = config.taskService.listDescendantAgentTasks(config.workspaceId, { statuses });

      const output = { tasks };
      const parsed = TaskListToolResultSchema.safeParse(output);
      if (!parsed.success) {
        throw new Error(`task_list tool result validation failed: ${parsed.error.message}`);
      }

      return parsed.data;
    },
  });
};
