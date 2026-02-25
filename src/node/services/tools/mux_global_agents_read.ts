import * as path from "path";
import * as fsPromises from "fs/promises";
import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import { getErrorMessage } from "@/common/utils/errors";
import { getMuxHomeFromWorkspaceSessionDir } from "./muxHome";

export interface MuxGlobalAgentsReadToolResult {
  success: true;
  content: string;
}

export interface MuxGlobalAgentsReadToolError {
  success: false;
  error: string;
}

export type MuxGlobalAgentsReadToolOutput =
  | MuxGlobalAgentsReadToolResult
  | MuxGlobalAgentsReadToolError;

export const createMuxGlobalAgentsReadTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.mux_global_agents_read.description,
    inputSchema: TOOL_DEFINITIONS.mux_global_agents_read.schema,
    execute: async (
      _args,
      { abortSignal: _abortSignal }
    ): Promise<MuxGlobalAgentsReadToolOutput> => {
      try {
        if (config.workspaceId !== MUX_HELP_CHAT_WORKSPACE_ID) {
          return {
            success: false,
            error: "mux_global_agents_read is only available in the Chat with Mux system workspace",
          };
        }

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
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
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
