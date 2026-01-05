import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

import { requireTaskService, requireWorkspaceId } from "./toolUtils";

export const createAgentReportTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.agent_report.description,
    inputSchema: TOOL_DEFINITIONS.agent_report.schema,
    execute: (): { success: true } => {
      const workspaceId = requireWorkspaceId(config, "agent_report");
      const taskService = requireTaskService(config, "agent_report");

      if (taskService.hasActiveDescendantAgentTasksForWorkspace(workspaceId)) {
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
