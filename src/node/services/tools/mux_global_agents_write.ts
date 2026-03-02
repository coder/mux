import * as path from "path";
import * as fsPromises from "fs/promises";
import { tool } from "ai";

import {
  FILE_EDIT_DIFF_OMITTED_MESSAGE,
  type MuxGlobalAgentsWriteToolArgs,
  type MuxGlobalAgentsWriteToolResult,
} from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { getMuxHomeFromWorkspaceSessionDir } from "@/node/services/tools/shared/configToolUtils";
import { generateDiff } from "./fileCommon";
import { hasErrorCode } from "./skillFileUtils";

export const createMuxGlobalAgentsWriteTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.mux_global_agents_write.description,
    inputSchema: TOOL_DEFINITIONS.mux_global_agents_write.schema,
    execute: async (
      args: MuxGlobalAgentsWriteToolArgs,
      { abortSignal: _abortSignal }
    ): Promise<MuxGlobalAgentsWriteToolResult> => {
      try {
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
