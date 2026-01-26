import { tool } from "ai";
import type { Tool } from "ai";

import type { ToolConfiguration } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

import type { System1KeepRange } from "@/node/services/system1/bashOutputFiltering";

export interface System1KeepRangesToolArgs {
  keep_ranges: System1KeepRange[];
}

export type System1KeepRangesToolResult =
  | {
      success: true;
    }
  | {
      success: false;
      error: string;
    };

export function createSystem1KeepRangesTool(
  _config: ToolConfiguration,
  options?: {
    onKeepRanges?: (keepRanges: System1KeepRange[]) => void;
  }
): Tool {
  let called = false;

  return tool({
    description: TOOL_DEFINITIONS.system1_keep_ranges.description,
    inputSchema: TOOL_DEFINITIONS.system1_keep_ranges.schema,
    execute: ({ keep_ranges }: System1KeepRangesToolArgs): System1KeepRangesToolResult => {
      // Defensive: the model should only call this once, but don't error-loop if it retries.
      if (called) {
        return { success: true };
      }
      called = true;
      options?.onKeepRanges?.(keep_ranges);
      return { success: true };
    },
  });
}
