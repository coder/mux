import { tool } from "ai";

import type { ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

export interface NoNewMemoriesToolResult {
  success: true;
}

/**
 * Explicit no-op memory tool.
 *
 * The System1 memory writer uses this to make "no changes" a concrete tool action,
 * so the runtime can distinguish deliberate no-op decisions from accidental prose-only responses.
 */
export const createNoNewMemoriesTool: ToolFactory = () => {
  return tool({
    description: TOOL_DEFINITIONS.no_new_memories.description,
    inputSchema: TOOL_DEFINITIONS.no_new_memories.schema,
    execute: (): Promise<NoNewMemoriesToolResult> => {
      return Promise.resolve({ success: true });
    },
  });
};
