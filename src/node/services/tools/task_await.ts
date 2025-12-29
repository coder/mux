import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TaskAwaitToolResultSchema, TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

import { fromBashTaskId, toBashTaskId } from "./taskId";
import {
  dedupeStrings,
  parseToolResult,
  requireTaskService,
  requireWorkspaceId,
} from "./toolUtils";

function coerceTimeoutMs(timeoutSecs: unknown): number | undefined {
  if (typeof timeoutSecs !== "number" || !Number.isFinite(timeoutSecs)) return undefined;
  if (timeoutSecs < 0) return undefined;
  const timeoutMs = Math.floor(timeoutSecs * 1000);
  return timeoutMs;
}

function formatBashOutputReport(args: {
  processId: string;
  status: string;
  exitCode?: number;
  output: string;
}): string {
  const lines: string[] = [];

  lines.push(`### Bash task: ${args.processId}`);
  lines.push("");

  lines.push(`status: ${args.status}`);
  if (args.exitCode !== undefined) {
    lines.push(`exitCode: ${args.exitCode}`);
  }

  if (args.output.trim().length > 0) {
    lines.push("");
    lines.push("```text");
    lines.push(args.output.trimEnd());
    lines.push("```");
  }

  return lines.join("\n");
}

export const createTaskAwaitTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.task_await.description,
    inputSchema: TOOL_DEFINITIONS.task_await.schema,
    execute: async (args, { abortSignal }): Promise<unknown> => {
      const workspaceId = requireWorkspaceId(config, "task_await");
      const taskService = requireTaskService(config, "task_await");

      const timeoutMs = coerceTimeoutMs(args.timeout_secs);
      const timeoutSecsForBash = args.timeout_secs;

      const requestedIds: string[] | null =
        args.task_ids && args.task_ids.length > 0 ? args.task_ids : null;

      let candidateTaskIds: string[] =
        requestedIds ?? taskService.listActiveDescendantAgentTaskIds(workspaceId);

      if (!requestedIds && config.backgroundProcessManager) {
        const processes = await config.backgroundProcessManager.list();
        const bashTaskIds = processes
          .filter((proc) => {
            if (proc.status !== "running") return false;
            return (
              proc.workspaceId === workspaceId ||
              taskService.isDescendantAgentTask(workspaceId, proc.workspaceId)
            );
          })
          .map((proc) => toBashTaskId(proc.id));

        candidateTaskIds = [...candidateTaskIds, ...bashTaskIds];
      }

      const uniqueTaskIds = dedupeStrings(candidateTaskIds);

      const agentTaskIds = uniqueTaskIds.filter((taskId) => !taskId.startsWith("bash:"));
      const bulkFilter = (
        taskService as unknown as {
          filterDescendantAgentTaskIds?: (
            ancestorWorkspaceId: string,
            taskIds: string[]
          ) => string[];
        }
      ).filterDescendantAgentTaskIds;
      const descendantAgentTaskIdSet = new Set(
        typeof bulkFilter === "function"
          ? bulkFilter.call(taskService, workspaceId, agentTaskIds)
          : agentTaskIds.filter((taskId) => taskService.isDescendantAgentTask(workspaceId, taskId))
      );

      const results = await Promise.all(
        uniqueTaskIds.map(async (taskId) => {
          const maybeProcessId = fromBashTaskId(taskId);
          if (taskId.startsWith("bash:") && !maybeProcessId) {
            return { status: "error" as const, taskId, error: "Invalid bash taskId." };
          }

          if (maybeProcessId) {
            if (!config.backgroundProcessManager) {
              return {
                status: "error" as const,
                taskId,
                error: "Background process manager not available",
              };
            }

            const proc = await config.backgroundProcessManager.getProcess(maybeProcessId);
            if (!proc) {
              return { status: "not_found" as const, taskId };
            }

            const inScope =
              proc.workspaceId === workspaceId ||
              taskService.isDescendantAgentTask(workspaceId, proc.workspaceId);
            if (!inScope) {
              return { status: "invalid_scope" as const, taskId };
            }

            const outputResult = await config.backgroundProcessManager.getOutput(
              maybeProcessId,
              args.filter,
              args.filter_exclude,
              timeoutSecsForBash,
              abortSignal,
              workspaceId,
              "task_await"
            );

            if (!outputResult.success) {
              return { status: "error" as const, taskId, error: outputResult.error };
            }

            if (outputResult.status === "running" || outputResult.status === "interrupted") {
              return {
                status: "running" as const,
                taskId,
                output: outputResult.output,
                elapsed_ms: outputResult.elapsed_ms,
                note: outputResult.note,
              };
            }

            return {
              status: "completed" as const,
              taskId,
              title: proc.displayName ?? proc.id,
              reportMarkdown: formatBashOutputReport({
                processId: proc.id,
                status: outputResult.status,
                exitCode: outputResult.exitCode,
                output: outputResult.output,
              }),
              elapsed_ms: outputResult.elapsed_ms,
              exitCode: outputResult.exitCode,
              note: outputResult.note,
            };
          }

          if (!descendantAgentTaskIdSet.has(taskId)) {
            return { status: "invalid_scope" as const, taskId };
          }

          // When timeout_secs=0 (or rounds down to 0ms), task_await should be non-blocking.
          // `waitForAgentReport` asserts timeoutMs > 0, so handle 0 explicitly by returning the
          // current task status instead of awaiting.
          if (timeoutMs === 0) {
            const status = taskService.getAgentTaskStatus(taskId);
            if (status === "queued" || status === "running" || status === "awaiting_report") {
              return { status, taskId };
            }

            // Best-effort: the task might already have a cached report (even if its workspace was
            // cleaned up). Avoid blocking when it isn't available.
            try {
              const report = await taskService.waitForAgentReport(taskId, {
                timeoutMs: 1,
                abortSignal,
                requestingWorkspaceId: workspaceId,
              });
              return {
                status: "completed" as const,
                taskId,
                reportMarkdown: report.reportMarkdown,
                title: report.title,
              };
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              if (/not found/i.test(message)) {
                return { status: "not_found" as const, taskId };
              }
              return { status: "error" as const, taskId, error: message };
            }
          }

          try {
            const report = await taskService.waitForAgentReport(taskId, {
              timeoutMs,
              abortSignal,
              requestingWorkspaceId: workspaceId,
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
              const status = taskService.getAgentTaskStatus(taskId);
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

      return parseToolResult(TaskAwaitToolResultSchema, { results }, "task_await");
    },
  });
};
