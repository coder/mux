import { tool } from "ai";

import type { MCPPromptDescriptor } from "@/common/orpc/schemas/mcp";
import type { MCPPromptGetToolResult } from "@/common/types/tools";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { getErrorMessage } from "@/common/utils/errors";

// Same disclosure budget as the skills index in agent_skill_read.
const MAX_PROMPTS = 50;
// Prompt/argument descriptions are server-controlled; clamp them so one
// hostile or verbose server cannot inflate every request's tool schema.
const MAX_PROMPT_DESCRIPTION_CHARS = 200;
const MAX_ARGUMENT_DESCRIPTION_CHARS = 100;
const MAX_ARGUMENT_HINT_CHARS = 300;
// Total budget for fully rendered index entries; prompts past it fall into
// the names-only tail below.
const MAX_INDEX_CHARS = 10_000;
// Names-only tail: keys past the full-entry budget stay discoverable and
// invocable (the missing-required-argument error recovers argument names).
const MAX_NAME_TAIL_CHARS = 2_000;
// Unknown-name errors list the catalog as an on-demand discovery path for
// prompts the description budgets cut. Per-call cost, so it can be generous.
const MAX_ERROR_KEYS_CHARS = 20_000;

function clampText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3)}...`;
}

// Never cuts a key mid-name; a partial key is not invocable.
function joinKeysWithinBudget(keys: string[], maxChars: number): { text: string; omitted: number } {
  const shown: string[] = [];
  let chars = 0;
  for (const key of keys) {
    if (chars + key.length + 2 > maxChars) {
      break;
    }
    shown.push(key);
    chars += key.length + 2;
  }
  return { text: shown.join(", "), omitted: keys.length - shown.length };
}

function formatArgumentHint(descriptor: MCPPromptDescriptor): string {
  const args = descriptor.arguments ?? [];
  if (args.length === 0) {
    return "";
  }
  const parts = args.map((argument) => {
    const marker = argument.required === true ? "" : "?";
    return argument.description == null
      ? `${argument.name}${marker}`
      : `${argument.name}${marker}: ${clampText(argument.description, MAX_ARGUMENT_DESCRIPTION_CHARS)}`;
  });
  return clampText(` (args: ${parts.join("; ")})`, MAX_ARGUMENT_HINT_CHARS);
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

  const promptLines: string[] = [];
  const tailKeys: string[] = [];
  let indexChars = 0;
  for (const descriptor of prompts) {
    if (promptLines.length < MAX_PROMPTS) {
      const description = clampText(
        descriptor.description ?? "MCP prompt",
        MAX_PROMPT_DESCRIPTION_CHARS
      );
      const line = `- ${descriptor.commandKey}${formatArgumentHint(descriptor)}: ${description} (server: ${descriptor.serverName})`;
      if (indexChars + line.length <= MAX_INDEX_CHARS) {
        promptLines.push(line);
        indexChars += line.length;
        continue;
      }
    }
    tailKeys.push(descriptor.commandKey);
  }

  if (tailKeys.length > 0) {
    const tail = joinKeysWithinBudget(tailKeys, MAX_NAME_TAIL_CHARS);
    if (tail.text.length > 0) {
      promptLines.push(`(more prompts, names only: ${tail.text})`);
    }
    if (tail.omitted > 0) {
      promptLines.push(
        `(+${tail.omitted} more not shown; call this tool with any unknown name to list every prompt key)`
      );
    }
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
        const keys = joinKeysWithinBudget(
          prompts.map((candidate) => candidate.commandKey),
          MAX_ERROR_KEYS_CHARS
        );
        return {
          success: false,
          error: `Unknown MCP prompt '${name}'. Available prompts: ${keys.text}${
            keys.omitted > 0 ? ` (+${keys.omitted} more)` : ""
          }`,
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
