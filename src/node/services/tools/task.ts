import assert from "node:assert/strict";

import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TaskToolResultSchema, TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ThinkingLevel } from "@/common/types/thinking";

function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (
    value === "off" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  return undefined;
}

export const createTaskTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.task.description,
    inputSchema: TOOL_DEFINITIONS.task.schema,
    execute: async (args, { abortSignal }): Promise<unknown> => {
      assert(config.workspaceId, "task requires workspaceId");
      assert(config.taskService, "task requires taskService");

      const modelString =
        config.muxEnv && typeof config.muxEnv.MUX_MODEL_STRING === "string"
          ? config.muxEnv.MUX_MODEL_STRING
          : undefined;
      const thinkingLevel = parseThinkingLevel(config.muxEnv?.MUX_THINKING_LEVEL);

      const created = await config.taskService.create({
        parentWorkspaceId: config.workspaceId,
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
        const result = { status: created.data.status, taskId: created.data.taskId };
        const parsed = TaskToolResultSchema.safeParse(result);
        if (!parsed.success) {
          throw new Error(`task tool result validation failed: ${parsed.error.message}`);
        }
        return parsed.data;
      }

      const report = await config.taskService.waitForAgentReport(created.data.taskId, {
        abortSignal,
      });

      const result = {
        status: "completed" as const,
        taskId: created.data.taskId,
        reportMarkdown: report.reportMarkdown,
        title: report.title,
        agentType: args.subagent_type,
      };

      const parsed = TaskToolResultSchema.safeParse(result);
      if (!parsed.success) {
        throw new Error(`task tool result validation failed: ${parsed.error.message}`);
      }
      return parsed.data;
    },
  });
};
