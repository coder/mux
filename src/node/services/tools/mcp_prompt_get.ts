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

function formatArgumentHint(descriptor: MCPPromptDescriptor): string {
  const args = descriptor.arguments ?? [];
  if (args.length === 0) {
    return "";
  }
  // The arguments array is server-controlled and can be huge; stop building
  // once the budget is consumed instead of materializing the full hint.
  const parts: string[] = [];
  let chars = 0;
  for (const argument of args) {
    const marker = argument.required === true ? "" : "?";
    const part =
      argument.description == null
        ? `${argument.name}${marker}`
        : `${argument.name}${marker}: ${clampText(argument.description, MAX_ARGUMENT_DESCRIPTION_CHARS)}`;
    parts.push(part);
    chars += part.length + 2;
    if (chars > MAX_ARGUMENT_HINT_CHARS) {
      break;
    }
  }
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
  let indexChars = 0;
  // First line that misses the budget ends full-entry mode outright, so line
  // construction (which touches server-controlled text) never repeats for
  // every remaining descriptor of a large catalog.
  let indexBudgetExhausted = false;
  // Tail keys accumulate only while they fit the display budget. The first
  // key that misses the budget ends the scan outright and the remainder is
  // derived from prompts.length, so a hostile catalog costs neither a
  // catalog-sized allocation nor an O(n) scan on the send path. A key is
  // never cut mid-name: a partial key is not invocable.
  const tailShown: string[] = [];
  let tailChars = 0;
  let tailOmitted = 0;
  for (const descriptor of prompts) {
    if (promptLines.length < MAX_PROMPTS && !indexBudgetExhausted) {
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
      indexBudgetExhausted = true;
    }
    const key = descriptor.commandKey;
    if (tailChars + key.length + 2 > MAX_NAME_TAIL_CHARS) {
      tailOmitted = prompts.length - promptLines.length - tailShown.length;
      break;
    }
    tailShown.push(key);
    tailChars += key.length + 2;
  }

  if (tailShown.length > 0) {
    promptLines.push(`(more prompts, names only: ${tailShown.join(", ")})`);
  }
  if (tailOmitted > 0) {
    promptLines.push(
      `(+${tailOmitted} more not shown; call this tool with a full or partial name to search all prompt keys)`
    );
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
        // Single bounded scan: accumulate keys only while they fit the budget
        // and count the rest, so a hostile catalog costs no large allocation.
        const needle = name.toLowerCase();
        const matched: string[] = [];
        let matchedChars = 0;
        let matchedFull = false;
        let matchedCount = 0;
        const all: string[] = [];
        let allChars = 0;
        let allFull = false;
        for (const candidate of prompts) {
          const key = candidate.commandKey;
          if (!allFull && allChars + key.length + 2 <= MAX_ERROR_KEYS_CHARS) {
            all.push(key);
            allChars += key.length + 2;
          } else {
            allFull = true;
          }
          if (key.toLowerCase().includes(needle)) {
            matchedCount++;
            if (!matchedFull && matchedChars + key.length + 2 <= MAX_ERROR_KEYS_CHARS) {
              matched.push(key);
              matchedChars += key.length + 2;
            } else {
              matchedFull = true;
            }
          }
        }
        const useMatches = matchedCount > 0;
        const label = useMatches ? `Prompts matching '${name}'` : "Available prompts";
        const shown = useMatches ? matched : all;
        const omitted = useMatches ? matchedCount - matched.length : prompts.length - all.length;
        return {
          success: false,
          error: `Unknown MCP prompt '${name}'. ${label}: ${shown.join(", ")}${
            omitted > 0 ? ` (+${omitted} more; use a longer partial name to narrow)` : ""
          }`,
        };
      }

      const argumentValues = args ?? {};
      // Single pass over the server-controlled arguments array, accumulating
      // only names that fit the error budget; the rest are just counted.
      const missingNames: string[] = [];
      let missingChars = 0;
      let missingOmitted = 0;
      for (const argument of descriptor.arguments ?? []) {
        // Own-property check: an argument named after an inherited
        // Object.prototype member (constructor, toString, __proto__) must not
        // count as provided via prototype lookup.
        const provided =
          Object.hasOwn(argumentValues, argument.name) && argumentValues[argument.name] != null;
        if (argument.required !== true || provided) {
          continue;
        }
        if (missingChars + argument.name.length + 2 <= MAX_ERROR_TEXT_CHARS) {
          missingNames.push(argument.name);
          missingChars += argument.name.length + 2;
        } else {
          missingOmitted++;
        }
      }
      if (missingNames.length > 0 || missingOmitted > 0) {
        return {
          success: false,
          error: `Missing required argument(s) for '${descriptor.commandKey}': ${missingNames.join(", ")}${
            missingOmitted > 0 ? ` (+${missingOmitted} more)` : ""
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
        return {
          success: true,
          // Expansion text is already byte-capped at the runtime's shared
          // getPrompt chokepoint (MCPServerManager), which also serves the
          // composer path.
          text: result.text,
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
