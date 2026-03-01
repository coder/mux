import { tool } from "ai";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

export function buildSwitchAgentDescription(config: ToolConfiguration): string {
  const baseDescription = TOOL_DEFINITIONS.switch_agent.description;
  const availableAgents =
    config.availableSubagents?.filter((agent) => agent.uiSelectable || agent.uiRoutable) ?? [];

  if (availableAgents.length === 0) {
    return baseDescription;
  }

  const agentLines = availableAgents.map((agent) => {
    const desc = agent.description ? `: ${agent.description}` : "";
    return `- ${agent.id}${desc}`;
  });

  return `${baseDescription}\n\nAvailable agents (use \`agentId\` parameter):\n${agentLines.join("\n")}`;
}

export const createSwitchAgentTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: buildSwitchAgentDescription(config),
    inputSchema: TOOL_DEFINITIONS.switch_agent.schema,
    execute: (args) => {
      // Validation of whether the target agent is UI-routable happens in the
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
