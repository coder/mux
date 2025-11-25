import { tool } from "ai";
import type { BashBackgroundReadResult } from "@/common/types/tools";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

/**
 * Tool for reading status and output from background processes
 */
export const createBashBackgroundReadTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.bash_background_read.description,
    inputSchema: TOOL_DEFINITIONS.bash_background_read.schema,
    execute: ({
      process_id,
      stdout_tail,
      stderr_tail,
      stdout_regex,
      stderr_regex,
    }): BashBackgroundReadResult => {
      if (!config.backgroundProcessManager) {
        return {
          success: false,
          error: "Background process manager not available",
        };
      }

      if (!config.workspaceId) {
        return {
          success: false,
          error: "Workspace ID not available",
        };
      }

      // Get process from manager and verify workspace ownership
      const process = config.backgroundProcessManager.getProcess(process_id);
      if (!process || process.workspaceId !== config.workspaceId) {
        return {
          success: false,
          error: `Process not found: ${process_id}`,
        };
      }

      // Apply filtering (regex first, then tail)
      let stdout = process.stdoutBuffer.toArray();
      let stderr = process.stderrBuffer.toArray();

      // Apply regex filters first
      if (stdout_regex) {
        try {
          const regex = new RegExp(stdout_regex);
          stdout = stdout.filter((line) => regex.test(line));
        } catch (error) {
          return {
            success: false,
            error: `Invalid regex pattern for stdout_regex: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
      if (stderr_regex) {
        try {
          const regex = new RegExp(stderr_regex);
          stderr = stderr.filter((line) => regex.test(line));
        } catch (error) {
          return {
            success: false,
            error: `Invalid regex pattern for stderr_regex: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }

      // Apply tail filters after regex
      if (stdout_tail !== undefined) {
        stdout = stdout.slice(-stdout_tail);
      }
      if (stderr_tail !== undefined) {
        stderr = stderr.slice(-stderr_tail);
      }

      // Compute uptime
      const uptime_ms =
        process.exitTime !== undefined
          ? process.exitTime - process.startTime
          : Date.now() - process.startTime;

      return {
        success: true,
        process_id: process.id,
        status: process.status,
        script: process.script,
        uptime_ms,
        exitCode: process.exitCode,
        stdout,
        stderr,
      };
    },
  });
};
