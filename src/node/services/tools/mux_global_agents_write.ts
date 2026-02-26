import * as path from "path";
import * as fsPromises from "fs/promises";
import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import { FILE_EDIT_DIFF_OMITTED_MESSAGE } from "@/common/types/tools";
import { generateDiff } from "./fileCommon";
import { getErrorMessage } from "@/common/utils/errors";
import { getMuxHomeFromWorkspaceSessionDir } from "./muxHome";
import { hasErrorCode } from "./skillFileUtils";

export interface MuxGlobalAgentsWriteToolArgs {
  newContent: string;
  confirm: boolean;
}

export interface MuxGlobalAgentsWriteToolResult {
  success: true;
  diff: string;
  ui_only?: {
    file_edit?: {
      diff: string;
    };
  };
}

export interface MuxGlobalAgentsWriteToolError {
  success: false;
  error: string;
}

export type MuxGlobalAgentsWriteToolOutput =
  | MuxGlobalAgentsWriteToolResult
  | MuxGlobalAgentsWriteToolError;

export const createMuxGlobalAgentsWriteTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.mux_global_agents_write.description,
    inputSchema: TOOL_DEFINITIONS.mux_global_agents_write.schema,
    execute: async (
      args: MuxGlobalAgentsWriteToolArgs,
      { abortSignal: _abortSignal }
    ): Promise<MuxGlobalAgentsWriteToolOutput> => {
      try {
        if (config.workspaceId !== MUX_HELP_CHAT_WORKSPACE_ID) {
          return {
            success: false,
            error:
              "mux_global_agents_write is only available in the Chat with Mux system workspace",
          };
        }

        if (!args.confirm) {
          return {
            success: false,
            error: "Refusing to write global AGENTS.md without confirm: true",
          };
        }

        const muxHome = getMuxHomeFromWorkspaceSessionDir(config, "mux_global_agents_write");
        await fsPromises.mkdir(muxHome, { recursive: true });

        // Canonicalize muxHome before constructing the file path.
        const muxHomeReal = await fsPromises.realpath(muxHome);
        const agentsPath = path.join(muxHomeReal, "AGENTS.md");

        let originalContent = "";
        try {
          const stat = await fsPromises.lstat(agentsPath);
          if (stat.isSymbolicLink()) {
            return {
              success: false,
              error: "Refusing to write a symlinked AGENTS.md target",
            };
          }
          originalContent = await fsPromises.readFile(agentsPath, "utf-8");

          // If the file exists, ensure its resolved path matches the resolved muxHome target.
          const agentsPathReal = await fsPromises.realpath(agentsPath);
          if (agentsPathReal !== agentsPath) {
            return {
              success: false,
              error: "Refusing to write global AGENTS.md (path resolution mismatch)",
            };
          }
        } catch (error) {
          if (!hasErrorCode(error, "ENOENT")) {
            throw error;
          }
          // File missing is OK (will create).
        }

        await fsPromises.writeFile(agentsPath, args.newContent, "utf-8");

        const diff = generateDiff(agentsPath, originalContent, args.newContent);

        return {
          success: true,
          diff: FILE_EDIT_DIFF_OMITTED_MESSAGE,
          ui_only: {
            file_edit: {
              diff,
            },
          },
        };
      } catch (error) {
        const message = getErrorMessage(error);
        return {
          success: false,
          error: `Failed to write global AGENTS.md: ${message}`,
        };
      }
    },
  });
};
