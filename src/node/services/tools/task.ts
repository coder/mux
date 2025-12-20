import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TaskToolResultSchema, TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { coerceThinkingLevel } from "@/common/types/thinking";

import { parseToolResult, requireTaskService, requireWorkspaceId } from "./toolUtils";

export const createTaskTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.task.description,
    inputSchema: TOOL_DEFINITIONS.task.schema,
    execute: async (args, { abortSignal }): Promise<unknown> => {
      const workspaceId = requireWorkspaceId(config, "task");
      const taskService = requireTaskService(config, "task");

      if (abortSignal?.aborted) {
        throw new Error("Interrupted");
      }

      // Plan mode is explicitly non-executing. Allow only read-only exploration tasks.
      if (config.mode === "plan" && args.subagent_type === "exec") {
        throw new Error('In Plan Mode you may only spawn subagent_type: "explore" tasks.');
      }

      const modelString =
        config.muxEnv && typeof config.muxEnv.MUX_MODEL_STRING === "string"
          ? config.muxEnv.MUX_MODEL_STRING
          : undefined;
      const thinkingLevel = coerceThinkingLevel(config.muxEnv?.MUX_THINKING_LEVEL);

      const created = await taskService.create({
        parentWorkspaceId: workspaceId,
        kind: "agent",
        agentType: args.subagent_type,
        prompt: args.prompt,
        description: args.description,
        modelString,
        thinkingLevel,
      });

      if (!created.success) {
        throw new Error(created.error);
      }

      if (args.run_in_background) {
        return parseToolResult(
          TaskToolResultSchema,
          { status: created.data.status, taskId: created.data.taskId },
          "task"
        );
      }

      const report = await taskService.waitForAgentReport(created.data.taskId, {
        abortSignal,
        requestingWorkspaceId: workspaceId,
      });

      return parseToolResult(
        TaskToolResultSchema,
        {
          status: "completed" as const,
          taskId: created.data.taskId,
          reportMarkdown: report.reportMarkdown,
          title: report.title,
          agentType: args.subagent_type,
        },
        "task"
      );
    },
  });
};
