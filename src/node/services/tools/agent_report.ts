import assert from "node:assert/strict";

import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

export const createAgentReportTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.agent_report.description,
    inputSchema: TOOL_DEFINITIONS.agent_report.schema,
    execute: (): { success: true } => {
      assert(config.workspaceId, "agent_report requires workspaceId");
      assert(config.taskService, "agent_report requires taskService");

      if (config.taskService.hasActiveDescendantAgentTasksForWorkspace(config.workspaceId)) {
        throw new Error(
          "agent_report rejected: this task still has running/queued descendant tasks. " +
            "Call task_await (or wait for tasks to finish) before reporting."
        );
      }

      // Intentionally no side-effects. The backend orchestrator consumes the tool-call args
      // via persisted history/partial state once the tool call completes successfully.
      return { success: true };
    },
  });
};
