import assert from "node:assert/strict";

import { tool } from "ai";

import type { ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

export const createAgentReportTool: ToolFactory = (config) => {
  return tool({
    description: TOOL_DEFINITIONS.agent_report.description,
    inputSchema: TOOL_DEFINITIONS.agent_report.schema,
    execute: async (args) => {
      assert(config.taskService, "agent_report requires taskService");
      assert(config.workspaceId, "agent_report requires workspaceId");

      await config.taskService.handleAgentReport(config.workspaceId, {
        reportMarkdown: args.reportMarkdown,
      });

      return { status: "ok" };
    },
  });
};
