import { tool } from "ai";

import type { AgentSkillReadFileToolResult } from "@/common/types/tools";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { getErrorMessage } from "@/common/utils/errors";
import { SkillNameSchema } from "@/common/orpc/schemas";
import { readAgentSkill } from "@/node/services/agentSkills/agentSkillsService";
import { MAX_FILE_SIZE, validateFileSize } from "@/node/services/tools/fileCommon";
import { readBuiltInSkillFile } from "@/node/services/agentSkills/builtInSkillDefinitions";
import { RuntimeError } from "@/node/runtime/Runtime";
import { readFileString } from "@/node/utils/runtime/helpers";
import { resolveContainedSkillFilePathOnRuntime } from "./runtimeSkillPathUtils";

function readContentWithFileReadLimits(input: {
  fullContent: string;
  fileSize: number;
  modifiedTime: string;
  offset?: number | null;
  limit?: number | null;
}): AgentSkillReadFileToolResult {
  if (input.fileSize > MAX_FILE_SIZE) {
    const sizeMB = (input.fileSize / (1024 * 1024)).toFixed(2);
    const maxMB = (MAX_FILE_SIZE / (1024 * 1024)).toFixed(2);
    return {
      success: false,
      error: `File is too large (${sizeMB}MB). Maximum supported size is ${maxMB}MB.`,
    };
  }

  const lines = input.fullContent === "" ? [] : input.fullContent.split("\n");

  if (input.offset != null && input.offset > lines.length) {
    return {
      success: false,
      error: `Offset ${input.offset} is beyond file length`,
    };
  }

  const startLineNumber = input.offset ?? 1;
  const startIdx = startLineNumber - 1;
  const endIdx = input.limit != null ? startIdx + input.limit : lines.length;

  const numberedLines: string[] = [];
  let totalBytesAccumulated = 0;
  const MAX_LINE_BYTES = 1024;
  const MAX_LINES = 1000;
  const MAX_TOTAL_BYTES = 16 * 1024; // 16KB

  for (let i = startIdx; i < Math.min(endIdx, lines.length); i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    let processedLine = line;
    const lineBytes = Buffer.byteLength(line, "utf-8");
    if (lineBytes > MAX_LINE_BYTES) {
      processedLine = Buffer.from(line, "utf-8").subarray(0, MAX_LINE_BYTES).toString("utf-8");
      processedLine += "... [truncated]";
    }

    const numberedLine = `${lineNumber}\t${processedLine}`;
    const numberedLineBytes = Buffer.byteLength(numberedLine, "utf-8");

    if (totalBytesAccumulated + numberedLineBytes > MAX_TOTAL_BYTES) {
      return {
        success: false,
        error: `Output would exceed ${MAX_TOTAL_BYTES} bytes. Please read less at a time using offset and limit parameters.`,
      };
    }

    numberedLines.push(numberedLine);
    totalBytesAccumulated += numberedLineBytes + 1;

    if (numberedLines.length > MAX_LINES) {
      return {
        success: false,
        error: `Output would exceed ${MAX_LINES} lines. Please read less at a time using offset and limit parameters.`,
      };
    }
  }

  return {
    success: true,
    file_size: input.fileSize,
    modifiedTime: input.modifiedTime,
    lines_read: numberedLines.length,
    content: numberedLines.join("\n"),
  };
}

/**
 * Agent Skill read_file tool factory.
 * Reads a file within a skill directory with the same output limits as file_read.
 */
export const createAgentSkillReadFileTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.agent_skill_read_file.description,
    inputSchema: TOOL_DEFINITIONS.agent_skill_read_file.schema,
    execute: async ({ name, filePath, offset, limit }): Promise<AgentSkillReadFileToolResult> => {
      const workspacePath = config.cwd;
      if (!workspacePath) {
        return {
          success: false,
          error: "Tool misconfigured: cwd is required.",
        };
      }

      // Defensive: validate again even though inputSchema should guarantee shape.
      const parsedName = SkillNameSchema.safeParse(name);
      if (!parsedName.success) {
        return {
          success: false,
          error: parsedName.error.message,
        };
      }

      try {
        if (offset != null && offset < 1) {
          return {
            success: false,
            error: `Offset must be positive (got ${offset})`,
          };
        }

        const resolvedSkill = await readAgentSkill(config.runtime, workspacePath, parsedName.data);

        // Built-in skills are embedded in the app bundle (no filesystem access).
        if (resolvedSkill.package.scope === "built-in") {
          const builtIn = readBuiltInSkillFile(parsedName.data, filePath);
          return readContentWithFileReadLimits({
            fullContent: builtIn.content,
            fileSize: Buffer.byteLength(builtIn.content, "utf-8"),
            modifiedTime: new Date(0).toISOString(),
            offset,
            limit,
          });
        }

        let targetPath: string;
        try {
          ({ resolvedPath: targetPath } = await resolveContainedSkillFilePathOnRuntime(
            config.runtime,
            resolvedSkill.skillDir,
            filePath
          ));
        } catch (error) {
          const message = getErrorMessage(error);

          if (/escape|outside/i.test(message)) {
            return {
              success: false,
              error: `Resolved file path points outside the skill directory: ${filePath}`,
            };
          }

          if (/symbolic link/i.test(message)) {
            return {
              success: false,
              error: message,
            };
          }

          return {
            success: false,
            error: message,
          };
        }

        let stat;
        try {
          stat = await config.runtime.stat(targetPath);
        } catch (err) {
          if (err instanceof RuntimeError) {
            return {
              success: false,
              error: err.message,
            };
          }
          throw err;
        }

        if (stat.isDirectory) {
          return {
            success: false,
            error: `Path is a directory, not a file: ${filePath}`,
          };
        }

        const sizeValidation = validateFileSize(stat);
        if (sizeValidation) {
          return {
            success: false,
            error: sizeValidation.error,
          };
        }

        let fullContent: string;
        try {
          fullContent = await readFileString(config.runtime, targetPath);
        } catch (err) {
          if (err instanceof RuntimeError) {
            return {
              success: false,
              error: err.message,
            };
          }
          throw err;
        }

        return readContentWithFileReadLimits({
          fullContent,
          fileSize: stat.size,
          modifiedTime: stat.modifiedTime.toISOString(),
          offset,
          limit,
        });
      } catch (error) {
        return {
          success: false,
          error: `Failed to read file: ${getErrorMessage(error)}`,
        };
      }
    },
  });
};
