import { tool } from "ai";

import type { BashToolResult } from "@/common/types/tools";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { resolveBashDisplayName } from "@/common/utils/tools/bashDisplayName";
import { TaskToolResultSchema, TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { coerceThinkingLevel } from "@/common/types/thinking";

import { createBashTool } from "./bash";
import { toBashTaskId } from "./taskId";
import { parseToolResult, requireTaskService, requireWorkspaceId } from "./toolUtils";

function formatBashReport(
  args: { script: string; display_name: string },
  result: BashToolResult
): string {
  const lines: string[] = [];

  lines.push(`### Bash: ${args.display_name}`);
  lines.push("");

  lines.push("```bash");
  lines.push(args.script.trimEnd());
  lines.push("```");
  lines.push("");

  lines.push(`exitCode: ${result.exitCode}`);
  lines.push(`wall_duration_ms: ${result.wall_duration_ms}`);

  if ("truncated" in result && result.truncated) {
    lines.push("");
    lines.push("WARNING: output truncated");
    lines.push(`reason: ${result.truncated.reason}`);
    lines.push(`totalLines: ${result.truncated.totalLines}`);
  }

  if (!result.success) {
    lines.push("");
    lines.push(`error: ${result.error}`);
  }

  // NOTE: We intentionally omit the full command output from reportMarkdown.
  // For task(kind="bash"), the raw result (including output) is returned separately as
  // TaskToolCompletedResult.bashResult to avoid duplicating tokens in the model context.

  return lines.join("\n");
}

export const createTaskTool: ToolFactory = (config: ToolConfiguration) => {
  let bashTool: ReturnType<typeof createBashTool> | null = null;

  return tool({
    description: TOOL_DEFINITIONS.task.description,
    inputSchema: TOOL_DEFINITIONS.task.schema,
    execute: async (args, { abortSignal, toolCallId, messages }): Promise<unknown> => {
      // Defensive: tool() should have already validated args via inputSchema,
      // but keep runtime validation here to preserve type-safety.
      const parsedArgs = TOOL_DEFINITIONS.task.schema.safeParse(args);
      if (!parsedArgs.success) {
        throw new Error(`task tool input validation failed: ${parsedArgs.error.message}`);
      }
      const validatedArgs = parsedArgs.data;
      if (abortSignal?.aborted) {
        throw new Error("Interrupted");
      }

      // task(kind="bash") - run bash commands via the task abstraction.
      if (validatedArgs.kind === "bash") {
        const { script, timeout_secs, run_in_background, display_name } = validatedArgs;
        if (!script || timeout_secs === undefined) {
          throw new Error("task tool input validation failed: expected bash task args");
        }

        const resolvedDisplayName = resolveBashDisplayName(script, display_name);

        bashTool ??= createBashTool(config);

        const bashResult = (await bashTool.execute!(
          {
            script,
            timeout_secs,
            run_in_background,
            display_name: resolvedDisplayName,
          },
          { abortSignal, toolCallId, messages }
        )) as BashToolResult;

        if (
          bashResult.success &&
          "backgroundProcessId" in bashResult &&
          bashResult.backgroundProcessId
        ) {
          return parseToolResult(
            TaskToolResultSchema,
            { status: "running" as const, taskId: toBashTaskId(bashResult.backgroundProcessId) },
            "task"
          );
        }

        return parseToolResult(
          TaskToolResultSchema,
          {
            status: "completed" as const,
            reportMarkdown: formatBashReport(
              { script, display_name: resolvedDisplayName },
              bashResult
            ),
            title: resolvedDisplayName,
            bashResult,
            exitCode: bashResult.exitCode,
            note: "note" in bashResult ? bashResult.note : undefined,
            truncated: "truncated" in bashResult ? bashResult.truncated : undefined,
          },
          "task"
        );
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
