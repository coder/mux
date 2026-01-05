import { tool } from "ai";

import { coerceThinkingLevel } from "@/common/types/thinking";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TaskToolResultSchema, TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { log } from "@/node/services/log";

import { parseToolResult, requireTaskService, requireWorkspaceId } from "./toolUtils";

export const createTaskTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.task.description,
    inputSchema: TOOL_DEFINITIONS.task.schema,
    execute: async (args, { abortSignal }): Promise<unknown> => {
      // Defensive: tool() should have already validated args via inputSchema,
      // but keep runtime validation here to preserve type-safety.
      const parsedArgs = TOOL_DEFINITIONS.task.schema.safeParse(args);
      if (!parsedArgs.success) {
        const keys =
          args && typeof args === "object" ? Object.keys(args as Record<string, unknown>) : [];
        log.warn(
          "[task tool] Unexpected input validation failure (should have been caught by AI SDK)",
          {
            issues: parsedArgs.error.issues,
            keys,
          }
        );
        throw new Error(`task tool input validation failed: ${parsedArgs.error.message}`);
      }
      const validatedArgs = parsedArgs.data;
      if (abortSignal?.aborted) {
        throw new Error("Interrupted");
      }

      const { agentId, subagent_type, prompt, title, run_in_background } = validatedArgs;
      const requestedAgentId =
        typeof agentId === "string" && agentId.trim().length > 0 ? agentId : subagent_type;
      if (!requestedAgentId || !prompt || !title) {
        throw new Error("task tool input validation failed: expected agent task args");
      }

      const workspaceId = requireWorkspaceId(config, "task");
      const taskService = requireTaskService(config, "task");

      // Disallow recursive sub-agent spawning.
      if (config.enableAgentReport) {
        throw new Error("Sub-agent workspaces may not spawn additional sub-agent tasks.");
      }

      // Plan mode is explicitly non-executing. Allow only read-only exploration tasks.
      if (config.mode === "plan" && requestedAgentId !== "explore") {
        throw new Error('In Plan Mode you may only spawn agentId: "explore" tasks.');
      }

      const modelString =
        config.muxEnv && typeof config.muxEnv.MUX_MODEL_STRING === "string"
          ? config.muxEnv.MUX_MODEL_STRING
          : undefined;
      const thinkingLevel = coerceThinkingLevel(config.muxEnv?.MUX_THINKING_LEVEL);

      const created = await taskService.create({
        parentWorkspaceId: workspaceId,
        kind: "agent",
        agentId: requestedAgentId,
        // Legacy alias (persisted for older clients / on-disk compatibility).
        agentType: requestedAgentId,
        prompt,
        title,
        modelString,
        thinkingLevel,
        experiments: config.experiments,
      });

      if (!created.success) {
        throw new Error(created.error);
      }

      if (run_in_background) {
        return parseToolResult(
          TaskToolResultSchema,
          { status: created.data.status, taskId: created.data.taskId },
          "task"
        );
      }

      const report = await taskService.waitForAgentReport(created.data.taskId, {
        abortSignal,
        requestingWorkspaceId: workspaceId,
      });

      return parseToolResult(
        TaskToolResultSchema,
        {
          status: "completed" as const,
          taskId: created.data.taskId,
          reportMarkdown: report.reportMarkdown,
          title: report.title,
          agentId: requestedAgentId,
          agentType: requestedAgentId,
        },
        "task"
      );
    },
  });
};
