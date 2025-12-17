/**
 * agent_report tool - Reports findings back to parent workspace.
 *
 * This tool has no side effects; it simply returns success.
 * The actual report delivery is handled by the TaskService when it
 * observes the tool-call-end event for this tool.
 */

import { tool } from "ai";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { AgentReportToolResult } from "@/common/types/task";

/**
 * Create the agent_report tool.
 * This is a non-runtime tool (no config needed) since the actual
 * report handling is done by the orchestrator observing tool-call events.
 */
export function createAgentReportTool() {
  return tool({
    description: TOOL_DEFINITIONS.agent_report.description,
    inputSchema: TOOL_DEFINITIONS.agent_report.schema,
    execute: (_args): AgentReportToolResult => {
      // The tool itself does nothing - the TaskService intercepts
      // the tool-call-end event and handles report delivery
      return { success: true };
    },
  });
}
