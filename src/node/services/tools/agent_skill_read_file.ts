import * as fs from "node:fs/promises";
import * as path from "node:path";

import { tool } from "ai";

import type { AgentSkillReadFileToolResult } from "@/common/types/tools";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { SkillNameSchema } from "@/common/orpc/schemas";
import {
  readAgentSkill,
  resolveAgentSkillFilePath,
} from "@/node/services/agentSkills/agentSkillsService";
import { validateFileSize } from "@/node/services/tools/fileCommon";

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPathTraversal(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel.startsWith("..") || path.isAbsolute(rel);
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
      try {
        const projectPath = config.muxEnv?.MUX_PROJECT_PATH;
        if (!projectPath) {
          return {
            success: false,
            error: "MUX_PROJECT_PATH is not available; cannot resolve agent skills roots.",
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

        const resolvedSkill = await readAgentSkill(projectPath, parsedName.data);
        const unsafeTargetPath = resolveAgentSkillFilePath(resolvedSkill.skillDir, filePath);

        // Resolve symlinks and ensure the final target stays inside the skill directory.
        const [realSkillDir, realTargetPath] = await Promise.all([
          fs.realpath(resolvedSkill.skillDir),
          fs.realpath(unsafeTargetPath),
        ]);

        if (isPathTraversal(realSkillDir, realTargetPath)) {
          return {
            success: false,
            error: `Invalid filePath (path traversal): ${filePath}`,
          };
        }

        if (offset !== undefined && offset < 1) {
          return {
            success: false,
            error: `Offset must be positive (got ${offset})`,
          };
        }

        const stat = await fs.stat(realTargetPath);
        if (stat.isDirectory()) {
          return {
            success: false,
            error: `Path is a directory, not a file: ${filePath}`,
          };
        }

        const sizeValidation = validateFileSize({
          size: stat.size,
          modifiedTime: stat.mtime,
          isDirectory: false,
        });
        if (sizeValidation) {
          return {
            success: false,
            error: sizeValidation.error,
          };
        }

        const fullContent = await fs.readFile(realTargetPath, "utf-8");
        const lines = fullContent === "" ? [] : fullContent.split("\n");

        if (offset !== undefined && offset > lines.length) {
          return {
            success: false,
            error: `Offset ${offset} is beyond file length`,
          };
        }

        const startLineNumber = offset ?? 1;
        const startIdx = startLineNumber - 1;
        const endIdx = limit !== undefined ? startIdx + limit : lines.length;

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
            processedLine = Buffer.from(line, "utf-8")
              .subarray(0, MAX_LINE_BYTES)
              .toString("utf-8");
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
          file_size: stat.size,
          modifiedTime: stat.mtime.toISOString(),
          lines_read: numberedLines.length,
          content: numberedLines.join("\n"),
        };
      } catch (error) {
        if (error && typeof error === "object" && "code" in error) {
          const code = (error as { code?: string }).code;
          if (code === "ENOENT") {
            return {
              success: false,
              error: `File not found: ${filePath}`,
            };
          }
          if (code === "EACCES") {
            return {
              success: false,
              error: `Permission denied: ${filePath}`,
            };
          }
        }

        return {
          success: false,
          error: `Failed to read file: ${formatError(error)}`,
        };
      }
    },
  });
};
