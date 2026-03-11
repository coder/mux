import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

import { requireTaskService, requireWorkspaceId } from "./toolUtils";

export const createAgentReportTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.agent_report.description,
    inputSchema: TOOL_DEFINITIONS.agent_report.schema,
    execute: (): { success: true; message: string } => {
      const workspaceId = requireWorkspaceId(config, "agent_report");
      const taskService = requireTaskService(config, "agent_report");

      if (taskService.hasActiveDescendantAgentTasksForWorkspace(workspaceId)) {
        throw new Error(
          "agent_report rejected: this task still has running/queued descendant tasks. " +
            "Call task_await (or wait for tasks to finish) before reporting."
        );
      }

      // Guard: if edits were made but no validation was attempted, nudge the agent to verify.
      const hasEdits = config.editTracker?.hasAnyEdits() ?? false;
      const hasValidated = config.verificationTracker?.hasValidationAttempt() ?? false;
      if (hasEdits && !hasValidated) {
        if (!config.verificationTracker?.hasBeenNudged()) {
          config.verificationTracker?.markNudged();
          throw new Error(
            "agent_report rejected: no validation commands detected after file edits. " +
              "Run the most relevant check (tests, typecheck, lint) and then call agent_report again. " +
              "If validation is not applicable, call agent_report again to confirm."
          );
        }
      }

      // Intentionally no side-effects. The backend orchestrator consumes the tool-call args
      // via persisted history/partial state once the tool call completes successfully.
      // The stream continues after this so the SDK can record usage, while StreamManager
      // stops autonomous loops once it observes agent_report with output.success === true.
      return {
        success: true,
        message: "Report submitted successfully.",
      };
    },
  });
};
