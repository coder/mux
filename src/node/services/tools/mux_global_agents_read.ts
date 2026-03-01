import * as path from "path";
import * as fsPromises from "fs/promises";
import { tool } from "ai";

import type { MuxGlobalAgentsReadToolResult } from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { getMuxHomeFromWorkspaceSessionDir } from "@/node/services/tools/shared/configToolUtils";
import { hasErrorCode } from "./skillFileUtils";

export const createMuxGlobalAgentsReadTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.mux_global_agents_read.description,
    inputSchema: TOOL_DEFINITIONS.mux_global_agents_read.schema,
    execute: async (
      _args,
      { abortSignal: _abortSignal }
    ): Promise<MuxGlobalAgentsReadToolResult> => {
      try {
        const muxHome = getMuxHomeFromWorkspaceSessionDir(config, "mux_global_agents_read");
        const agentsPath = path.join(muxHome, "AGENTS.md");

        try {
          const stat = await fsPromises.lstat(agentsPath);
          if (stat.isSymbolicLink()) {
            return {
              success: false,
              error: "Refusing to read a symlinked AGENTS.md target",
            };
          }

          const content = await fsPromises.readFile(agentsPath, "utf-8");
          return { success: true, content };
        } catch (error) {
          if (hasErrorCode(error, "ENOENT")) {
            return { success: true, content: "" };
          }

          throw error;
        }
      } catch (error) {
        const message = getErrorMessage(error);
        return {
          success: false,
          error: `Failed to read global AGENTS.md: ${message}`,
        };
      }
    },
  });
};
