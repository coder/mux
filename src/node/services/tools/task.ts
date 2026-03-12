import { randomUUID } from "node:crypto";

import { tool } from "ai";
import type { z } from "zod";

import { coerceThinkingLevel } from "@/common/types/thinking";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TaskToolResultSchema, TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { TaskCreatedEvent } from "@/common/types/stream";
import { log } from "@/node/services/log";
import { ForegroundWaitBackgroundedError } from "@/node/services/taskService";

import { parseToolResult, requireTaskService, requireWorkspaceId } from "./toolUtils";
import { getErrorMessage } from "@/common/utils/errors";

/**
 * Build dynamic task tool description with available sub-agents.
 * Injects the list of available sub-agents directly into the tool description
 * so the model sees them adjacent to the tool call schema.
 */
function buildTaskDescription(config: ToolConfiguration): string {
  const baseDescription = TOOL_DEFINITIONS.task.description;
  const subagents = config.availableSubagents?.filter((a) => a.subagentRunnable) ?? [];

  if (subagents.length === 0) {
    return baseDescription;
  }

  const subagentLines = subagents.map((agent) => {
    const desc = agent.description ? `: ${agent.description}` : "";
    return `- ${agent.id}${desc}`;
  });

  return `${baseDescription}\n\nAvailable sub-agents (use \`agentId\` parameter):\n${subagentLines.join("\n")}`;
}

interface SpawnedTaskInfo {
  taskId: string;
  status: "queued" | "running";
}

interface PendingTaskInfo {
  taskId: string;
  status: "queued" | "running" | "completed";
}

interface CompletedTaskInfo {
  taskId: string;
  reportMarkdown: string;
  title?: string;
  agentId: string;
  agentType: string;
}

type ForegroundWaitOutcome =
  | { kind: "completed"; report: CompletedTaskInfo }
  | { kind: "backgrounded" }
  | { kind: "timed_out" }
  | { kind: "interrupted" }
  | { kind: "error"; error: unknown };

function buildBestOfGroupId(workspaceId: string, toolCallId: string | undefined): string {
  return `best-of:${workspaceId}:${toolCallId ?? randomUUID()}`;
}

function emitTaskCreatedEvent(params: {
  config: ToolConfiguration;
  workspaceId: string;
  toolCallId: string | undefined;
  taskId: string;
}): void {
  if (!params.config.emitChatEvent || !params.config.workspaceId || !params.toolCallId) {
    return;
  }

  params.config.emitChatEvent({
    type: "task-created",
    workspaceId: params.workspaceId,
    toolCallId: params.toolCallId,
    taskId: params.taskId,
    timestamp: Date.now(),
  } satisfies TaskCreatedEvent);
}

function toAggregatePendingStatus(
  statuses: ReadonlyArray<PendingTaskInfo["status"]>
): "queued" | "running" {
  return statuses.every((status) => status === "queued") ? "queued" : "running";
}

function buildPendingTaskResult(params: {
  tasks: readonly PendingTaskInfo[];
  note: string;
  reports?: readonly CompletedTaskInfo[];
}): z.infer<typeof TaskToolResultSchema> {
  const status = toAggregatePendingStatus(params.tasks.map((task) => task.status));
  const serializedReports =
    params.reports && params.reports.length > 0
      ? params.reports.map((report) => ({
          taskId: report.taskId,
          reportMarkdown: report.reportMarkdown,
          title: report.title,
          agentId: report.agentId,
          agentType: report.agentType,
        }))
      : undefined;

  if (params.tasks.length === 1) {
    const task = params.tasks[0];
    return {
      status,
      taskId: task?.taskId,
      note: params.note,
      ...(serializedReports ? { reports: serializedReports } : {}),
    };
  }

  return {
    status,
    taskIds: params.tasks.map((task) => task.taskId),
    tasks: params.tasks.map((task) => ({ taskId: task.taskId, status: task.status })),
    note: params.note,
    ...(serializedReports ? { reports: serializedReports } : {}),
  };
}

function buildCompletedTaskResult(params: {
  reports: readonly CompletedTaskInfo[];
}): z.infer<typeof TaskToolResultSchema> {
  if (params.reports.length === 1) {
    const report = params.reports[0];
    return {
      status: "completed",
      taskId: report?.taskId,
      reportMarkdown: report?.reportMarkdown,
      title: report?.title,
      agentId: report?.agentId,
      agentType: report?.agentType,
    };
  }

  return {
    status: "completed",
    taskIds: params.reports.map((report) => report.taskId),
    reports: params.reports.map((report) => ({
      taskId: report.taskId,
      reportMarkdown: report.reportMarkdown,
      title: report.title,
      agentId: report.agentId,
      agentType: report.agentType,
    })),
  };
}

function normalizePendingTaskStatuses(params: {
  taskService: ReturnType<typeof requireTaskService>;
  createdTasks: readonly SpawnedTaskInfo[];
  completedReports?: readonly CompletedTaskInfo[];
}): PendingTaskInfo[] {
  const completedTaskIds = new Set((params.completedReports ?? []).map((report) => report.taskId));
  return params.createdTasks.map((createdTask) => {
    if (completedTaskIds.has(createdTask.taskId)) {
      return {
        taskId: createdTask.taskId,
        status: "completed",
      };
    }

    const currentStatus =
      params.taskService.getAgentTaskStatus(createdTask.taskId) ?? createdTask.status;
    return {
      taskId: createdTask.taskId,
      status: currentStatus === "queued" ? "queued" : "running",
    };
  });
}

export const createTaskTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: buildTaskDescription(config),
    inputSchema: TOOL_DEFINITIONS.task.schema,
    execute: async (args, { abortSignal, toolCallId }): Promise<unknown> => {
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

      const { agentId, subagent_type, prompt, title, run_in_background, n } = validatedArgs;
      const requestedAgentId =
        typeof agentId === "string" && agentId.trim().length > 0 ? agentId : subagent_type;
      if (!requestedAgentId || !prompt || !title) {
        throw new Error("task tool input validation failed: expected agent task args");
      }

      const workspaceId = requireWorkspaceId(config, "task");
      const taskService = requireTaskService(config, "task");
      const bestOfCount = n ?? 1;
      const bestOfGroupId =
        bestOfCount > 1 ? buildBestOfGroupId(workspaceId, toolCallId) : undefined;

      // Nested task spawning is allowed and enforced via maxTaskNestingDepth in TaskService
      // (and by tool policy at/over the depth limit).

      // Plan agent is explicitly non-executing. Allow only read-only exploration tasks.
      if (config.planFileOnly && requestedAgentId !== "explore") {
        throw new Error('In the plan agent you may only spawn agentId: "explore" tasks.');
      }

      const modelString =
        config.muxEnv && typeof config.muxEnv.MUX_MODEL_STRING === "string"
          ? config.muxEnv.MUX_MODEL_STRING
          : undefined;
      const thinkingLevel = coerceThinkingLevel(config.muxEnv?.MUX_THINKING_LEVEL);

      const createdTasks: SpawnedTaskInfo[] = [];
      for (let index = 0; index < bestOfCount; index += 1) {
        if (abortSignal?.aborted) {
          throw new Error("Interrupted");
        }

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
          bestOf:
            bestOfGroupId != null
              ? {
                  groupId: bestOfGroupId,
                  index,
                  total: bestOfCount,
                }
              : undefined,
        });

        if (!created.success) {
          if (createdTasks.length > 0) {
            return parseToolResult(
              TaskToolResultSchema,
              buildPendingTaskResult({
                tasks: createdTasks,
                note:
                  `Best-of task creation stopped after spawning ${createdTasks.length} of ${bestOfCount} candidate(s): ${created.error}. ` +
                  "Use task_await on the returned task metadata before retrying, or you may duplicate work.",
              }),
              "task"
            );
          }

          throw new Error(created.error);
        }

        const task = {
          taskId: created.data.taskId,
          status: created.data.status,
        } satisfies SpawnedTaskInfo;
        createdTasks.push(task);

        // UI-only signal: expose spawned taskIds as soon as the workspaces exist.
        emitTaskCreatedEvent({
          config,
          workspaceId,
          toolCallId,
          taskId: task.taskId,
        });
      }

      if (run_in_background) {
        return parseToolResult(
          TaskToolResultSchema,
          buildPendingTaskResult({
            tasks: createdTasks,
            note:
              createdTasks.length === 1
                ? "Task started in background. Use task_await to monitor progress."
                : "Tasks started in background. Use task_await to monitor progress.",
          }),
          "task"
        );
      }

      const waitOutcomes = await Promise.all(
        createdTasks.map(async (createdTask): Promise<ForegroundWaitOutcome> => {
          try {
            const report = await taskService.waitForAgentReport(createdTask.taskId, {
              abortSignal,
              requestingWorkspaceId: workspaceId,
              backgroundOnMessageQueued: true,
            });

            return {
              kind: "completed",
              report: {
                taskId: createdTask.taskId,
                reportMarkdown: report.reportMarkdown,
                title: report.title,
                agentId: requestedAgentId,
                agentType: requestedAgentId,
              } satisfies CompletedTaskInfo,
            };
          } catch (error: unknown) {
            if (abortSignal?.aborted) {
              return { kind: "interrupted" };
            }
            if (error instanceof ForegroundWaitBackgroundedError) {
              return { kind: "backgrounded" };
            }
            if (getErrorMessage(error) === "Timed out waiting for agent_report") {
              return { kind: "timed_out" };
            }
            return { kind: "error", error };
          }
        })
      );

      if (waitOutcomes.some((outcome) => outcome.kind === "interrupted")) {
        throw new Error("Interrupted");
      }

      const unexpectedFailure = waitOutcomes.find(
        (outcome): outcome is Extract<ForegroundWaitOutcome, { kind: "error" }> =>
          outcome.kind === "error"
      );
      if (unexpectedFailure) {
        throw unexpectedFailure.error;
      }

      const completedReports = waitOutcomes.flatMap((outcome) =>
        outcome.kind === "completed" ? [outcome.report] : []
      );
      if (completedReports.length === createdTasks.length) {
        return parseToolResult(
          TaskToolResultSchema,
          buildCompletedTaskResult({ reports: completedReports }),
          "task"
        );
      }

      const wasBackgrounded = waitOutcomes.some((outcome) => outcome.kind === "backgrounded");
      const didTimeOut = waitOutcomes.some((outcome) => outcome.kind === "timed_out");
      if (wasBackgrounded || didTimeOut) {
        return parseToolResult(
          TaskToolResultSchema,
          buildPendingTaskResult({
            tasks: normalizePendingTaskStatuses({
              taskService,
              createdTasks,
              completedReports,
            }),
            reports: completedReports,
            note: wasBackgrounded
              ? createdTasks.length === 1
                ? "Task sent to background because a new message was queued. Use task_await to monitor progress."
                : "Tasks were sent to background because a new message was queued. Use task_await to monitor progress."
              : createdTasks.length === 1
                ? "Task exceeded foreground wait limit and continues running in background. Use task_await to monitor progress."
                : "Tasks exceeded the foreground wait limit and continue running in background. Use task_await to monitor progress.",
          }),
          "task"
        );
      }

      throw new Error("Task foreground wait ended without a terminal result");
    },
  });
};
