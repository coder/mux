import assert from "node:assert/strict";

import { tool } from "ai";

import { DEFAULT_MODEL } from "@/common/constants/knownModels";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

export const createTaskTool: ToolFactory = (config) => {
  return tool({
    description: TOOL_DEFINITIONS.task.description,
    inputSchema: TOOL_DEFINITIONS.task.schema,
    execute: async (args, { toolCallId, abortSignal }) => {
      assert(config.taskService, "task requires taskService");
      assert(config.workspaceId, "task requires workspaceId");
      assert(toolCallId, "task requires toolCallId");

      const { childWorkspaceId } = await config.taskService.createAgentTask({
        parentWorkspaceId: config.workspaceId,
        toolCallId,
        agentType: args.agentType,
        prompt: args.prompt,
        model: config.model ?? DEFAULT_MODEL,
      });

      if (args.runInBackground) {
        return {
          status: "started",
          childWorkspaceId,
        };
      }

      const report = await config.taskService.awaitAgentReport(childWorkspaceId, abortSignal);

      return {
        status: "completed",
        childWorkspaceId,
        reportMarkdown: report.reportMarkdown,
      };
    },
  });
};
