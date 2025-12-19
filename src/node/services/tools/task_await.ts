import assert from "node:assert/strict";

import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TaskAwaitToolResultSchema, TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

function coerceTimeoutMs(timeoutSecs: unknown): number | undefined {
  if (typeof timeoutSecs !== "number" || !Number.isFinite(timeoutSecs)) return undefined;
  const timeoutMs = Math.floor(timeoutSecs * 1000);
  if (timeoutMs <= 0) return undefined;
  return timeoutMs;
}

export const createTaskAwaitTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.task_await.description,
    inputSchema: TOOL_DEFINITIONS.task_await.schema,
    execute: async (args, { abortSignal }): Promise<unknown> => {
      assert(config.workspaceId, "task_await requires workspaceId");
      assert(config.taskService, "task_await requires taskService");

      const timeoutMs = coerceTimeoutMs(args.timeout_secs);

      const requestedIds: string[] | null =
        args.task_ids && args.task_ids.length > 0 ? args.task_ids : null;

      const candidateTaskIds =
        requestedIds ?? config.taskService.listActiveDescendantAgentTaskIds(config.workspaceId);

      const uniqueTaskIds = Array.from(new Set(candidateTaskIds));

      const results = await Promise.all(
        uniqueTaskIds.map(async (taskId) => {
          if (!config.taskService!.isDescendantAgentTask(config.workspaceId!, taskId)) {
            return { status: "invalid_scope" as const, taskId };
          }

          try {
            const report = await config.taskService!.waitForAgentReport(taskId, {
              timeoutMs,
              abortSignal,
            });
            return {
              status: "completed" as const,
              taskId,
              reportMarkdown: report.reportMarkdown,
              title: report.title,
            };
          } catch (error: unknown) {
            if (abortSignal?.aborted) {
              return { status: "error" as const, taskId, error: "Interrupted" };
            }

            const message = error instanceof Error ? error.message : String(error);
            if (/not found/i.test(message)) {
              return { status: "not_found" as const, taskId };
            }
            if (/timed out/i.test(message)) {
              const status = config.taskService!.getAgentTaskStatus(taskId);
              if (status === "queued" || status === "running" || status === "awaiting_report") {
                return { status, taskId };
              }
              if (!status) {
                return { status: "not_found" as const, taskId };
              }
              return {
                status: "error" as const,
                taskId,
                error: `Task status is '${status}' (not awaitable via task_await).`,
              };
            }
            return { status: "error" as const, taskId, error: message };
          }
        })
      );

      const output = { results };
      const parsed = TaskAwaitToolResultSchema.safeParse(output);
      if (!parsed.success) {
        throw new Error(`task_await tool result validation failed: ${parsed.error.message}`);
      }

      return parsed.data;
    },
  });
};
