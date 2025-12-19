import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TaskListToolResultSchema, TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

import { parseToolResult, requireTaskService, requireWorkspaceId } from "./toolUtils";

const DEFAULT_STATUSES = ["queued", "running", "awaiting_report"] as const;

export const createTaskListTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.task_list.description,
    inputSchema: TOOL_DEFINITIONS.task_list.schema,
    execute: (args): unknown => {
      const workspaceId = requireWorkspaceId(config, "task_list");
      const taskService = requireTaskService(config, "task_list");

      const statuses =
        args.statuses && args.statuses.length > 0 ? args.statuses : [...DEFAULT_STATUSES];
      const tasks = taskService.listDescendantAgentTasks(workspaceId, { statuses });

      return parseToolResult(TaskListToolResultSchema, { tasks }, "task_list");
    },
  });
};
