import { tool } from "ai";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS, ProposeNameToolArgsSchema } from "@/common/utils/tools/toolDefinitions";

/**
 * Propose-name tool factory for workspace name generation.
 *
 * The tool itself is a simple echo — it validates the model's arguments
 * against ProposeNameToolArgsSchema (lowercase-hyphen name, sentence-case
 * title) and returns them verbatim.  The real work happens in the Zod
 * schema constraints and the `.describe()` annotations that guide the LLM.
 *
 * Used by:
 * - The `name_workspace` builtin agent (tools.require: propose_name)
 * - `workspaceTitleGenerator.ts` for direct streamText calls
 */
export const createProposeNameTool: ToolFactory = () => {
  return tool({
    description: TOOL_DEFINITIONS.propose_name.description,
    inputSchema: ProposeNameToolArgsSchema,
    // eslint-disable-next-line @typescript-eslint/require-await -- AI SDK Tool.execute must return a Promise
    execute: async (args) => ({ success: true as const, ...args }),
  });
};
