import * as fs from "node:fs/promises";

import { tool } from "ai";

import assert from "@/common/utils/assert";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

import { getMemoryFilePathForProject } from "./memoryCommon";

export interface MemoryReadToolResult {
  exists: boolean;
  content: string;
  projectId: string;
}

function getProjectPathFromConfig(config: ToolConfiguration): string | null {
  const projectPath = config.muxEnv?.MUX_PROJECT_PATH;
  if (typeof projectPath === "string" && projectPath.trim().length > 0) {
    return projectPath;
  }

  // Fallback: some tool contexts may not provide muxEnv (e.g., tests).
  // Using cwd is better than failing hard; the derived projectId will still be stable
  // within the workspace.
  if (typeof config.cwd === "string" && config.cwd.trim().length > 0) {
    return config.cwd;
  }

  return null;
}

export const createMemoryReadTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.memory_read.description,
    inputSchema: TOOL_DEFINITIONS.memory_read.schema,
    execute: async (): Promise<MemoryReadToolResult> => {
      const projectPath = getProjectPathFromConfig(config);
      assert(projectPath, "memory_read: projectPath is required");

      const { projectId, memoryPath } = getMemoryFilePathForProject(projectPath);

      try {
        const content = await fs.readFile(memoryPath, "utf8");
        return {
          exists: true,
          content,
          projectId,
        };
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          return {
            exists: false,
            content: "",
            projectId,
          };
        }

        throw error;
      }
    },
  });
};
