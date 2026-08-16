import { tool } from "ai";

import { MCP_PROMPT_MAX_TEXT_BYTES } from "@/common/constants/toolLimits";
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
// Unknown-name errors search the catalog as an on-demand discovery path for
// prompts the description budgets cut. Per-call cost, so it can be generous;
// substring narrowing keeps arbitrarily large catalogs reachable.
const MAX_ERROR_KEYS_CHARS = 20_000;
// Budget for other server-controlled text in error results (argument names,
// server failure messages).
const MAX_ERROR_TEXT_CHARS = 2_000;

function clampText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3)}...`;
}

// The expansion budget is enforced on encoded bytes, not UTF-16 code units:
// non-ASCII text can otherwise inflate the serialized result to ~3x the
// nominal cap. Never splits a multi-byte character.
function truncateUtf8Bytes(text: string, maxBytes: number, marker: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return text;
  }
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end--;
  }
  return bytes.subarray(0, end).toString("utf8") + marker;
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
        `(+${tail.omitted} more not shown; call this tool with a full or partial name to search all prompt keys)`
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

      // Exact commandKey wins across the whole catalog; stableKey is only an
      // alias that survives catalog changes re-suffixing commandKey, so it
      // must never shadow another prompt's current commandKey (same contract
      // as the composer's findPromptDescriptor).
      const descriptor =
        prompts.find((candidate) => candidate.commandKey === name) ??
        prompts.find((candidate) => candidate.stableKey === name);
      if (!descriptor) {
        // Substring search keeps every prompt reachable however large the
        // catalog: the model can always narrow past the character budget.
        const needle = name.toLowerCase();
        const matching = prompts
          .map((candidate) => candidate.commandKey)
          .filter((key) => key.toLowerCase().includes(needle));
        const label = matching.length > 0 ? `Prompts matching '${name}'` : "Available prompts";
        const keys = joinKeysWithinBudget(
          matching.length > 0 ? matching : prompts.map((candidate) => candidate.commandKey),
          MAX_ERROR_KEYS_CHARS
        );
        return {
          success: false,
          error: `Unknown MCP prompt '${name}'. ${label}: ${keys.text}${
            keys.omitted > 0 ? ` (+${keys.omitted} more; use a longer partial name to narrow)` : ""
          }`,
        };
      }

      const argumentValues = args ?? {};
      const missingRequired = (descriptor.arguments ?? [])
        .filter((argument) => argument.required === true && argumentValues[argument.name] == null)
        .map((argument) => argument.name);
      if (missingRequired.length > 0) {
        // Argument names are server-controlled; bound them like the catalog.
        const missing = joinKeysWithinBudget(missingRequired, MAX_ERROR_TEXT_CHARS);
        return {
          success: false,
          error: `Missing required argument(s) for '${descriptor.commandKey}': ${missing.text}${
            missing.omitted > 0 ? ` (+${missing.omitted} more)` : ""
          }`,
        };
      }

      try {
        const result = await runtime.getPrompt(
          descriptor.serverName,
          descriptor.promptName,
          argumentValues,
          abortSignal !== undefined ? { signal: abortSignal } : undefined
        );
        // Expansions are server-controlled; bound them so one verbose or
        // hostile server cannot flood the next model request.
        const text = truncateUtf8Bytes(
          result.text,
          MCP_PROMPT_MAX_TEXT_BYTES,
          "\n\n[Prompt text truncated]"
        );
        return {
          success: true,
          text,
          ...(result.description !== undefined
            ? { description: clampText(result.description, MAX_PROMPT_DESCRIPTION_CHARS) }
            : {}),
        };
      } catch (error) {
        // Server-controlled failure text gets the same bounding treatment.
        return { success: false, error: clampText(getErrorMessage(error), MAX_ERROR_TEXT_CHARS) };
      }
    },
  });
};
