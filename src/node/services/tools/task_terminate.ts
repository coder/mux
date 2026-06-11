import { tool } from "ai";

import { getErrorMessage } from "@/common/utils/errors";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { WorkflowRunRecordSchema } from "@/common/orpc/schemas";
import {
  TaskTerminateToolResultSchema,
  TOOL_DEFINITIONS,
} from "@/common/utils/tools/toolDefinitions";

import { fromBashTaskId, isWorkflowRunTaskId } from "./taskId";
import {
  dedupeStrings,
  parseToolResult,
  requireTaskService,
  requireWorkspaceId,
} from "./toolUtils";

const WORKFLOW_INTERRUPTED_NOTE =
  "Workflow run interrupted. Durable state is preserved; resume it later with workflow_resume.";

/**
 * Workflow runs are interrupted (resumable) rather than terminated: the durable event log is
 * preserved, which is why this reports a distinct "interrupted" status instead of "terminated"
 * (whose contract says in-progress work is discarded).
 */
async function interruptWorkflowRun(
  config: ToolConfiguration,
  workspaceId: string,
  taskId: string
) {
  const workflowService = config.workflowService;
  if (workflowService?.getRun == null || workflowService.interruptRun == null) {
    return {
      status: "error" as const,
      taskId,
      error: "Workflow service not available for workflow run interrupts",
    };
  }

  // getRun is workspace-scoped: runs owned by other workspaces are reported as not found.
  const rawRun = await workflowService.getRun({ workspaceId, runId: taskId });
  if (rawRun == null) {
    return { status: "not_found" as const, taskId };
  }
  const run = WorkflowRunRecordSchema.parse(rawRun);

  if (run.status === "interrupted") {
    // Idempotent: re-interrupting an interrupted run is a no-op success.
    return { status: "interrupted" as const, taskId, note: WORKFLOW_INTERRUPTED_NOTE };
  }
  if (run.status === "completed" || run.status === "failed") {
    return {
      status: "error" as const,
      taskId,
      error: `Workflow run is already ${run.status} and cannot be interrupted.`,
    };
  }

  try {
    await workflowService.interruptRun({ workspaceId, runId: taskId });
  } catch (error: unknown) {
    return { status: "error" as const, taskId, error: getErrorMessage(error) };
  }
  return { status: "interrupted" as const, taskId, note: WORKFLOW_INTERRUPTED_NOTE };
}

export const createTaskTerminateTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.task_terminate.description,
    inputSchema: TOOL_DEFINITIONS.task_terminate.schema,
    execute: async (args): Promise<unknown> => {
      const workspaceId = requireWorkspaceId(config, "task_terminate");
      const taskService = requireTaskService(config, "task_terminate");

      const uniqueTaskIds = dedupeStrings(args.task_ids);

      const results = await Promise.all(
        uniqueTaskIds.map(async (taskId) => {
          if (isWorkflowRunTaskId(taskId)) {
            return await interruptWorkflowRun(config, workspaceId, taskId);
          }

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
              (await taskService.isDescendantAgentTask(workspaceId, proc.workspaceId));
            if (!inScope) {
              return { status: "invalid_scope" as const, taskId };
            }

            const terminateResult = await config.backgroundProcessManager.terminate(maybeProcessId);
            if (!terminateResult.success) {
              return { status: "error" as const, taskId, error: terminateResult.error };
            }

            return {
              status: "terminated" as const,
              taskId,
              terminatedTaskIds: [taskId],
            };
          }

          const terminateResult = await taskService.terminateDescendantAgentTask(
            workspaceId,
            taskId
          );
          if (!terminateResult.success) {
            const msg = terminateResult.error;
            const activeDescendantIds = taskService.listActiveDescendantAgentTaskIds(workspaceId);
            const activeTaskIds = activeDescendantIds.length > 0 ? activeDescendantIds : undefined;
            if (/not found/i.test(msg)) {
              return { status: "not_found" as const, taskId, activeTaskIds };
            }
            if (/descendant/i.test(msg) || /scope/i.test(msg)) {
              return { status: "invalid_scope" as const, taskId, activeTaskIds };
            }
            return { status: "error" as const, taskId, error: msg };
          }

          return {
            status: "terminated" as const,
            taskId,
            terminatedTaskIds: terminateResult.data.terminatedTaskIds,
          };
        })
      );

      return parseToolResult(TaskTerminateToolResultSchema, { results }, "task_terminate");
    },
  });
};
