import * as fs from "node:fs/promises";

import { tool } from "ai";
import writeFileAtomic from "write-file-atomic";

import assert from "@/common/utils/assert";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { log } from "@/node/services/log";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";

import { handleStringReplace, type StringReplaceArgs } from "./file_edit_replace_shared";
import { getMemoryFilePathForProject } from "./memoryCommon";

export interface MemoryWriteToolArgs {
  old_string: string;
  new_string: string;
  replace_count?: number;
}

export type MemoryWriteToolResult =
  | {
      success: true;
    }
  | {
      success: false;
      error: string;
    };

const memoryFileLocks = new MutexMap<string>();

function getProjectPathFromConfig(config: ToolConfiguration): string | null {
  const projectPath = config.muxEnv?.MUX_PROJECT_PATH;
  if (typeof projectPath === "string" && projectPath.trim().length > 0) {
    return projectPath;
  }

  // Fallback: some tool contexts may not provide muxEnv (e.g., tests).
  if (typeof config.cwd === "string" && config.cwd.trim().length > 0) {
    return config.cwd;
  }

  return null;
}

function formatLoggableMemory(memory: string): { preview: string; truncated: boolean } {
  const MAX_INFO_CHARS = 8_000;
  if (memory.length <= MAX_INFO_CHARS) {
    return { preview: memory, truncated: false };
  }

  return {
    preview:
      `${memory.slice(0, MAX_INFO_CHARS)}\n\n... (truncated; see debug_obj for full content)`.trimEnd(),
    truncated: true,
  };
}

export const createMemoryWriteTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.memory_write.description,
    inputSchema: TOOL_DEFINITIONS.memory_write.schema,
    execute: async (args: MemoryWriteToolArgs): Promise<MemoryWriteToolResult> => {
      try {
        const projectPath = getProjectPathFromConfig(config);
        assert(projectPath, "memory_write: projectPath is required");

        const { projectId, memoriesDir, memoryPath } = getMemoryFilePathForProject(projectPath);

        return await memoryFileLocks.withLock(memoryPath, async () => {
          await fs.mkdir(memoriesDir, { recursive: true });

          let originalContent = "";
          try {
            originalContent = await fs.readFile(memoryPath, "utf8");
          } catch (error) {
            if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
              originalContent = "";
            } else {
              throw error;
            }
          }

          const replaceCount = args.replace_count ?? 1;

          // Special-case: allow CAS-style writes for empty files.
          // Using the generic string-replace logic with an empty old_string would match
          // at every position and produce unusable results.
          if (args.old_string === "") {
            if (replaceCount !== 1) {
              return {
                success: false,
                error: "When old_string is empty, replace_count must be 1.",
              };
            }

            if (originalContent !== "") {
              return {
                success: false,
                error:
                  "old_string is empty but the memory file is not empty. Read the latest content and retry with old_string set to the full current file content.",
              };
            }

            await writeFileAtomic(memoryPath, args.new_string);

            const { preview } = formatLoggableMemory(args.new_string);
            log.info(`[system1][memory] wrote memory for ${projectId}:\n${preview}`);
            log.debug_obj(`memories/${projectId}.md`, args.new_string);

            return { success: true };
          }

          const replaceArgs: StringReplaceArgs = {
            file_path: memoryPath,
            old_string: args.old_string,
            new_string: args.new_string,
            replace_count: replaceCount,
          };

          const outcome = handleStringReplace(replaceArgs, originalContent);
          if (!outcome.success) {
            return {
              success: false,
              error: outcome.error,
            };
          }

          await writeFileAtomic(memoryPath, outcome.newContent);

          const { preview } = formatLoggableMemory(outcome.newContent);
          log.info(`[system1][memory] wrote memory for ${projectId}:\n${preview}`);
          log.debug_obj(`memories/${projectId}.md`, outcome.newContent);

          return { success: true };
        });
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
};
