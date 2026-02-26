import { tool } from "ai";
import { z } from "zod";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

// Schema defined locally to preserve Zod type inference for the tool execute handler.
// Must stay in sync with TOOL_DEFINITIONS.propose_name.schema.
const proposeNameSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .min(2)
    .max(20),
  title: z.string().min(5).max(60),
});

/**
 * Propose name tool factory for workspace name generation.
 * The schema validates name/title constraints; the handler just signals success.
 * This is a "signal" tool — the model calls it to deliver structured output
 * via tool-call instead of fragile JSON-in-prose.
 */
export const createProposeNameTool: ToolFactory = () => {
  return tool({
    description: TOOL_DEFINITIONS.propose_name.description,
    inputSchema: proposeNameSchema,
    // eslint-disable-next-line @typescript-eslint/require-await -- AI SDK tool execute must be async
    execute: async (args) => {
      return { success: true as const, name: args.name, title: args.title };
    },
  });
};
