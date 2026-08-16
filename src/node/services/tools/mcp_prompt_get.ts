import { tool } from "ai";

import type { MCPPromptDescriptor } from "@/common/orpc/schemas/mcp";
import type { MCPPromptGetToolResult } from "@/common/types/tools";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { getErrorMessage } from "@/common/utils/errors";

// Same disclosure budget as the skills index in agent_skill_read.
const MAX_PROMPTS = 50;

function formatArgumentHint(descriptor: MCPPromptDescriptor): string {
  const args = descriptor.arguments ?? [];
  if (args.length === 0) {
    return "";
  }
  const parts = args.map((argument) => {
    const marker = argument.required === true ? "" : "?";
    return argument.description == null
      ? `${argument.name}${marker}`
      : `${argument.name}${marker}: ${argument.description}`;
  });
  return ` (args: ${parts.join("; ")})`;
}

/**
 * Build dynamic mcp_prompt_get tool description with the available prompts.
 * Injects the prompt index directly into the tool description so the model
 * discovers prompts adjacent to the tool call schema (same mechanic as
 * agent_skill_read's skill index).
 */
function buildMcpPromptGetDescription(prompts: MCPPromptDescriptor[]): string {
  const baseDescription = TOOL_DEFINITIONS.mcp_prompt_get.description;
  if (prompts.length === 0) {
    return baseDescription;
  }

  const shown = prompts.slice(0, MAX_PROMPTS);
  const omitted = prompts.length - shown.length;

  const promptLines = shown.map((descriptor) => {
    const description = descriptor.description ?? "MCP prompt";
    return `- ${descriptor.commandKey}${formatArgumentHint(descriptor)}: ${description} (server: ${descriptor.serverName})`;
  });
  if (omitted > 0) {
    promptLines.push(`(+${omitted} more not shown)`);
  }

  return `${baseDescription}\n\nAvailable MCP prompts:\n${promptLines.join("\n")}`;
}

/**
 * MCP prompt get tool factory. Resolves a prompt by its command key against
 * the stream's descriptor snapshot and fetches the flattened prompt text
 * through MCPServerManager.
 */
export const createMcpPromptGetTool: ToolFactory = (config: ToolConfiguration) => {
  const runtime = config.mcpPromptRuntime;
  const prompts = runtime?.prompts ?? [];

  return tool({
    description: buildMcpPromptGetDescription(prompts),
    inputSchema: TOOL_DEFINITIONS.mcp_prompt_get.schema,
    execute: async (
      { name, arguments: args },
      { abortSignal }
    ): Promise<MCPPromptGetToolResult> => {
      if (!runtime) {
        return { success: false, error: "Tool misconfigured: no MCP prompt runtime." };
      }

      // stableKey is accepted as an alias because it survives catalog changes
      // that re-suffix commandKey.
      const descriptor = prompts.find(
        (candidate) => candidate.commandKey === name || candidate.stableKey === name
      );
      if (!descriptor) {
        return {
          success: false,
          error: `Unknown MCP prompt '${name}'. See "Available MCP prompts" in this tool's description.`,
        };
      }

      const argumentValues = args ?? {};
      const missingRequired = (descriptor.arguments ?? [])
        .filter((argument) => argument.required === true && argumentValues[argument.name] == null)
        .map((argument) => argument.name);
      if (missingRequired.length > 0) {
        return {
          success: false,
          error: `Missing required argument(s) for '${descriptor.commandKey}': ${missingRequired.join(", ")}`,
        };
      }

      try {
        const result = await runtime.getPrompt(
          descriptor.serverName,
          descriptor.promptName,
          argumentValues,
          abortSignal !== undefined ? { signal: abortSignal } : undefined
        );
        return {
          success: true,
          text: result.text,
          ...(result.description !== undefined ? { description: result.description } : {}),
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });
};
