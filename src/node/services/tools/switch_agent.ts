import { tool } from "ai";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

export const createSwitchAgentTool: ToolFactory = (_config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.switch_agent.description,
    inputSchema: TOOL_DEFINITIONS.switch_agent.schema,
    execute: (args) => {
      // Validation of whether the target agent is UI-selectable happens in the
      // AgentSession follow-up handler, not here. This tool is a signal tool:
      // StreamManager stops the stream on success, and AgentSession reads
      // switch details from the tool input before enqueueing a follow-up.
      //
      // Defensive fallback: include target agentId in output so degraded streams
      // that lose input metadata can still recover the destination agent without
      // repeating follow-up payload in context.
      return {
        ok: true,
        agentId: args.agentId,
      };
    },
  });
};
