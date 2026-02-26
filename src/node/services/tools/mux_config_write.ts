import { tool } from "ai";

import { CONFIG_FILE_REGISTRY } from "@/common/config/schemaRegistry";
import type { MuxConfigWriteToolArgs, MuxConfigWriteToolResult } from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { applyMutations } from "@/node/services/tools/shared/configMutationEngine";
import {
  getMuxHomeFromWorkspaceSessionDir,
  requireMuxHelpWorkspace,
} from "@/node/services/tools/shared/configToolUtils";
import {
  readConfigDocument,
  writeConfigDocument,
} from "@/node/services/tools/shared/configReadWrite";

export const createMuxConfigWriteTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.mux_config_write.description,
    inputSchema: TOOL_DEFINITIONS.mux_config_write.schema,
    execute: async (
      args: MuxConfigWriteToolArgs,
      { abortSignal: _abortSignal }
    ): Promise<MuxConfigWriteToolResult> => {
      try {
        const workspaceGuard = requireMuxHelpWorkspace(config, "mux_config_write");
        if (workspaceGuard) return workspaceGuard;

        if (!args.confirm) {
          return {
            success: false,
            error:
              "Refusing to write mux config without confirm: true. Ask the user for confirmation first.",
          };
        }

        const muxHome = getMuxHomeFromWorkspaceSessionDir(config, "mux_config_write");
        const currentDocument = await readConfigDocument(muxHome, args.file);
        const registryEntry = CONFIG_FILE_REGISTRY[args.file];
        const mutationResult = applyMutations(
          currentDocument,
          args.operations,
          registryEntry.schema
        );

        if (!mutationResult.success) {
          return {
            success: false,
            error: mutationResult.error,
            validationIssues: mutationResult.validationIssues?.map((issue) => ({
              path: issue.path.filter(
                (segment): segment is string | number => typeof segment !== "symbol"
              ),
              message: issue.message,
            })),
          };
        }

        await writeConfigDocument(muxHome, args.file, mutationResult.document);

        // Notify services that config has changed (triggers hot-reload for providers)
        config.onConfigChanged?.();

        return {
          success: true,
          file: args.file,
          appliedOps: mutationResult.appliedOps,
          summary: `Applied ${mutationResult.appliedOps} operation(s) to ${args.file}`,
        };
      } catch (error) {
        const message = getErrorMessage(error);
        return {
          success: false,
          error: `Failed to write mux config (${args.file}): ${message}`,
        };
      }
    },
  });
};
