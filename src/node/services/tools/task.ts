/**
 * task tool - Spawns a subagent to work on a task.
 *
 * The tool creates a child workspace via TaskService and either:
 * - Returns immediately with taskId (run_in_background=true)
 * - Blocks until the child calls agent_report (run_in_background=false)
 */

import { tool } from "ai";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { TaskToolResult } from "@/common/types/task";
import type { TaskService } from "@/node/services/taskService";

export interface TaskToolConfig {
  /** The workspace ID of the parent (caller) */
  workspaceId: string;
  /** TaskService for creating and managing agent tasks */
  taskService: TaskService;
}

/**
 * Create the task tool with injected TaskService.
 */
export function createTaskTool(config: TaskToolConfig) {
  return tool({
    description: TOOL_DEFINITIONS.task.description,
    inputSchema: TOOL_DEFINITIONS.task.schema,
    execute: async (args, { toolCallId }): Promise<TaskToolResult> => {
      const { subagent_type, prompt, description, run_in_background } = args;

      try {
        const result = await config.taskService.createTask({
          parentWorkspaceId: config.workspaceId,
          agentType: subagent_type,
          prompt,
          description,
          // Pass toolCallId for foreground tasks so result can be injected on restart
          parentToolCallId: run_in_background ? undefined : toolCallId,
          runInBackground: run_in_background ?? false,
        });

        if (result.status === "completed") {
          // Task completed (either immediately or we waited for it)
          return {
            status: "completed",
            taskId: result.taskId,
            reportMarkdown: result.reportMarkdown ?? "",
            reportTitle: result.reportTitle,
          };
        }

        // Task is queued or running (background mode)
        return {
          status: result.status,
          taskId: result.taskId,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          status: "failed",
          error: message,
        };
      }
    },
  });
}
