import { randomUUID } from "node:crypto";

import { tool } from "ai";
import type { z } from "zod";

import { coerceThinkingLevel } from "@/common/types/thinking";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  TaskToolResultSchema,
  TOOL_DEFINITIONS,
  buildTaskToolDescription,
} from "@/common/utils/tools/toolDefinitions";
import { RUNTIME_MODE, type RuntimeMode } from "@/common/types/runtime";
import type { TaskCreatedEvent } from "@/common/types/stream";
import { log } from "@/node/services/log";
import { ForegroundWaitBackgroundedError } from "@/node/services/taskService";

import { buildTaskGroupLaunches, type TaskGroupKind } from "@/common/utils/tools/taskGroups";
import { parseToolResult, requireTaskService, requireWorkspaceId } from "./toolUtils";
import { getErrorMessage } from "@/common/utils/errors";

/**
 * Build dynamic task tool description with runtime-specific workspace visibility
 * guidance and the currently available sub-agents.
 */
function buildTaskDescription(config: ToolConfiguration): string {
  const runtimeValue = config.muxEnv?.MUX_RUNTIME;
  const runtimeMode =
    runtimeValue != null && Object.values(RUNTIME_MODE).includes(runtimeValue as RuntimeMode)
      ? (runtimeValue as RuntimeMode)
      : undefined;
  const baseDescription = buildTaskToolDescription(runtimeMode);
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
  groupKind?: TaskGroupKind;
  label?: string;
}

interface PendingTaskInfo {
  taskId: string;
  status: "queued" | "running" | "completed" | "interrupted";
  groupKind?: TaskGroupKind;
  label?: string;
}

interface CompletedTaskInfo {
  taskId: string;
  reportMarkdown: string;
  title?: string;
  agentId: string;
  agentType: string;
  groupKind?: TaskGroupKind;
  label?: string;
}

type ForegroundWaitOutcome =
  | { kind: "completed"; report: CompletedTaskInfo }
  | { kind: "backgrounded" }
  | { kind: "timed_out" }
  | { kind: "interrupted" }
  | { kind: "task_interrupted" }
  | { kind: "error"; error: unknown };

function buildTaskGroupId(workspaceId: string, toolCallId: string | undefined): string {
  return `task-group:${workspaceId}:${toolCallId ?? randomUUID()}`;
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

function serializeCompletedReport(report: CompletedTaskInfo) {
  return {
    taskId: report.taskId,
    reportMarkdown: report.reportMarkdown,
    title: report.title,
    agentId: report.agentId,
    agentType: report.agentType,
    groupKind: report.groupKind,
    label: report.label,
  };
}

function serializeCompletedReports(reports: readonly CompletedTaskInfo[]) {
  return reports.map(serializeCompletedReport);
}

function buildBackgroundStartNote(taskCount: number): string {
  return taskCount === 1
    ? "Task started in background. Use task_await to monitor progress."
    : "Tasks started in background. Use task_await to monitor progress.";
}

function buildForegroundContinuationNote(
  taskCount: number,
  reason: "backgrounded" | "timed_out"
): string {
  if (reason === "backgrounded") {
    return taskCount === 1
      ? "Task sent to background because a new message was queued. Use task_await to monitor progress."
      : "Tasks were sent to background because a new message was queued. Use task_await to monitor progress.";
  }

  return taskCount === 1
    ? "Task exceeded foreground wait limit and continues running in background. Use task_await to monitor progress."
    : "Tasks exceeded the foreground wait limit and continue running in background. Use task_await to monitor progress.";
}

function buildInterruptedTaskNote(taskCount: number): string {
  return taskCount === 1
    ? "Task was interrupted before reporting. Use task_await to inspect the final task state."
    : "Some tasks were interrupted before reporting. Use task_await to inspect the final task states.";
}

function buildPendingTaskResult(params: {
  tasks: readonly PendingTaskInfo[];
  note: string;
  reports?: readonly CompletedTaskInfo[];
  forceGrouped?: boolean;
}): z.infer<typeof TaskToolResultSchema> {
  const status = toAggregatePendingStatus(params.tasks.map((task) => task.status));
  const serializedReports =
    params.reports && params.reports.length > 0
      ? serializeCompletedReports(params.reports)
      : undefined;

  if (params.tasks.length === 1 && !params.forceGrouped) {
    const task = params.tasks[0];
    return {
      status,
      taskId: task.taskId,
      note: params.note,
    };
  }

  return {
    status,
    taskIds: params.tasks.map((task) => task.taskId),
    tasks: params.tasks.map((task) => ({
      taskId: task.taskId,
      status: task.status,
      groupKind: task.groupKind,
      label: task.label,
    })),
    note: params.note,
    ...(serializedReports ? { reports: serializedReports } : {}),
  };
}

function buildCompletedTaskResult(params: {
  reports: readonly CompletedTaskInfo[];
}): z.infer<typeof TaskToolResultSchema> {
  const serializedReports = serializeCompletedReports(params.reports);
  if (serializedReports.length === 1) {
    const report = serializedReports[0];
    return {
      status: "completed",
      taskId: report.taskId,
      reportMarkdown: report.reportMarkdown,
      title: report.title,
      agentId: report.agentId,
      agentType: report.agentType,
    };
  }

  return {
    status: "completed",
    taskIds: serializedReports.map((report) => report.taskId),
    reports: serializedReports,
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
        groupKind: createdTask.groupKind,
        label: createdTask.label,
      };
    }

    const currentStatus =
      params.taskService.getAgentTaskStatus(createdTask.taskId) ?? createdTask.status;
    return {
      taskId: createdTask.taskId,
      status:
        currentStatus === "queued"
          ? "queued"
          : currentStatus === "interrupted"
            ? "interrupted"
            : "running",
      groupKind: createdTask.groupKind,
      label: createdTask.label,
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

      const { agentId, subagent_type, prompt, title, run_in_background, n, variants } =
        validatedArgs;
      const requestedAgentId =
        typeof agentId === "string" && agentId.trim().length > 0 ? agentId : subagent_type;
      if (!requestedAgentId) {
        throw new Error("task tool input validation failed: expected agent task args");
      }

      const workspaceId = requireWorkspaceId(config, "task");
      const taskService = requireTaskService(config, "task");
      const taskGroupLaunches = buildTaskGroupLaunches({ prompt, n, variants });
      const taskGroupCount = taskGroupLaunches.length;
      const taskGroupId =
        taskGroupCount > 1 ? buildTaskGroupId(workspaceId, toolCallId) : undefined;

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
      for (const launch of taskGroupLaunches) {
        if (abortSignal?.aborted) {
          throw new Error("Interrupted");
        }

        const created = await taskService.create({
          parentWorkspaceId: workspaceId,
          kind: "agent",
          agentId: requestedAgentId,
          // Legacy alias (persisted for older clients / on-disk compatibility).
          agentType: requestedAgentId,
          prompt: launch.prompt,
          title,
          modelString,
          thinkingLevel,
          experiments: config.experiments,
          bestOf:
            taskGroupId != null
              ? {
                  groupId: taskGroupId,
                  index: launch.index,
                  total: launch.total,
                  kind: launch.kind,
                  ...(launch.label ? { label: launch.label } : {}),
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
                  `Grouped task creation stopped after spawning ${createdTasks.length} of ${taskGroupCount} task(s): ${created.error}. ` +
                  "Use task_await on the returned task metadata before retrying, or you may duplicate work.",
                forceGrouped: taskGroupCount > 1,
              }),
              "task"
            );
          }

          throw new Error(created.error);
        }

        const task = {
          taskId: created.data.taskId,
          status: created.data.status,
          ...(taskGroupCount > 1 || launch.label
            ? { groupKind: launch.kind, ...(launch.label ? { label: launch.label } : {}) }
            : {}),
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
            note: buildBackgroundStartNote(createdTasks.length),
            forceGrouped: taskGroupCount > 1,
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
                groupKind: createdTask.groupKind,
                label: createdTask.label,
              } satisfies CompletedTaskInfo,
            };
          } catch (error: unknown) {
            if (abortSignal?.aborted) {
              return { kind: "interrupted" };
            }
            if (error instanceof ForegroundWaitBackgroundedError) {
              return { kind: "backgrounded" };
            }
            const errorMessage = getErrorMessage(error);
            if (errorMessage === "Timed out waiting for agent_report") {
              return { kind: "timed_out" };
            }
            if (errorMessage === "Task interrupted") {
              return { kind: "task_interrupted" };
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
      const hadInterruptedTask = waitOutcomes.some(
        (outcome) => outcome.kind === "task_interrupted"
      );
      if (wasBackgrounded || didTimeOut || hadInterruptedTask) {
        return parseToolResult(
          TaskToolResultSchema,
          buildPendingTaskResult({
            tasks: normalizePendingTaskStatuses({
              taskService,
              createdTasks,
              completedReports,
            }),
            reports: completedReports,
            note: hadInterruptedTask
              ? buildInterruptedTaskNote(createdTasks.length)
              : buildForegroundContinuationNote(
                  createdTasks.length,
                  wasBackgrounded ? "backgrounded" : "timed_out"
                ),
            forceGrouped: taskGroupCount > 1,
          }),
          "task"
        );
      }

      throw new Error("Task foreground wait ended without a terminal result");
    },
  });
};
