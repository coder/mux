import { tool } from "ai";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

export const createSwitchAgentTool: ToolFactory = (_config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.switch_agent.description,
    inputSchema: TOOL_DEFINITIONS.switch_agent.schema,
    execute: async (args) => {
      // Validation of whether the target agent is UI-selectable happens in the
      // AgentSession follow-up handler, not here. This tool is a signal tool:
      // StreamManager stops the stream on success, and AgentSession enqueues
      // a follow-up with the new agentId.
      //
      // We do basic validation here (the schema handles agentId format).
      return {
        ok: true,
        agentId: args.agentId,
        reason: args.reason ?? undefined,
        followUp: args.followUp ?? undefined,
      };
    },
  });
};
