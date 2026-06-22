import { tool } from "ai";

import type { TaskListToolSuccessResult } from "@/common/types/tools";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { WorkflowRunRecordSchema } from "@/common/orpc/schemas";
import { TaskListToolResultSchema, TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

import { isNestedWorkflowRun } from "@/common/types/workflow";
import type { AgentTaskStatus } from "@/node/services/taskService";

import { toBashTaskId } from "./taskId";
import { parseToolResult, requireTaskService, requireWorkspaceId } from "./toolUtils";

// "pending" and "backgrounded" are workflow-run statuses; agent/bash tasks never carry them.
const DEFAULT_STATUSES = [
  "queued",
  "starting",
  "running",
  "awaiting_report",
  "pending",
  "backgrounded",
] as const;

// Statuses agent tasks can actually carry; the wider tool enum additionally accepts
// workflow-run statuses, which must not reach taskService.listDescendantAgentTasks.
const AGENT_TASK_STATUSES: readonly AgentTaskStatus[] = [
  "queued",
  "starting",
  "running",
  "awaiting_report",
  "interrupted",
  "reported",
];

function isAgentTaskStatus(status: string): status is AgentTaskStatus {
  return (AGENT_TASK_STATUSES as readonly string[]).includes(status);
}

export const createTaskListTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.task_list.description,
    inputSchema: TOOL_DEFINITIONS.task_list.schema,
    execute: async (args): Promise<unknown> => {
      const workspaceId = requireWorkspaceId(config, "task_list");
      const taskService = requireTaskService(config, "task_list");

      const statuses =
        args.statuses && args.statuses.length > 0 ? args.statuses : [...DEFAULT_STATUSES];
      const agentStatuses = statuses.filter(isAgentTaskStatus);

      const agentTasks =
        agentStatuses.length > 0
          ? taskService.listDescendantAgentTasks(workspaceId, {
              statuses: agentStatuses,
              excludeWorkflowTasks: true,
            })
          : [];
      const tasks: TaskListToolSuccessResult["tasks"] = [...agentTasks];

      // Workflow runs are workspace-scoped (not parent/child workspaces), so they surface as
      // depth-1 entries. interrupted/failed runs stay listable here because they are the
      // resumable ones (workflow_resume).
      if (config.workflowService?.listRuns != null) {
        const runs = await config.workflowService.listRuns({ workspaceId });
        for (const rawRun of runs) {
          const parsed = WorkflowRunRecordSchema.safeParse(rawRun);
          if (
            !parsed.success ||
            !statuses.includes(parsed.data.status) ||
            isNestedWorkflowRun(parsed.data)
          ) {
            continue;
          }
          tasks.push({
            taskId: parsed.data.id,
            status: parsed.data.status,
            parentWorkspaceId: workspaceId,
            title: parsed.data.workflow.name,
            createdAt: parsed.data.createdAt,
            depth: 1,
          });
        }
      }

      const workspaceTurnStatuses = statuses.filter(
        (
          status
        ): status is "queued" | "starting" | "running" | "interrupted" | "completed" | "failed" =>
          status === "queued" ||
          status === "starting" ||
          status === "running" ||
          status === "interrupted" ||
          status === "completed" ||
          status === "failed"
      );
      if (workspaceTurnStatuses.length > 0 && taskService.listWorkspaceTurnTasks != null) {
        const storeStatuses = workspaceTurnStatuses.map((status) =>
          status === "failed" ? "error" : status
        );
        const workspaceTurns = await taskService.listWorkspaceTurnTasks(workspaceId, {
          statuses: storeStatuses,
        });
        for (const turn of workspaceTurns) {
          tasks.push({
            taskId: turn.handleId,
            status: turn.status === "error" ? "failed" : turn.status,
            parentWorkspaceId: workspaceId,
            handleKind: "workspace_turn",
            workspaceId: turn.workspaceId,
            title: turn.title,
            createdAt: turn.createdAt,
            depth: 1,
          });
        }
      }

      if (config.backgroundProcessManager) {
        const depthByWorkspaceId = new Map<string, number>();
        depthByWorkspaceId.set(workspaceId, 0);
        for (const t of agentTasks) {
          depthByWorkspaceId.set(t.taskId, t.depth);
        }

        const processes = await config.backgroundProcessManager.list();
        for (const proc of processes) {
          const inScope =
            proc.workspaceId === workspaceId ||
            (await taskService.isDescendantAgentTask(workspaceId, proc.workspaceId));
          if (!inScope) continue;

          if (
            proc.workspaceId !== workspaceId &&
            (await taskService.isWorkflowOwnedDescendantAgentTask(workspaceId, proc.workspaceId))
          ) {
            continue;
          }

          const status = proc.status === "running" ? "running" : "reported";
          if (!statuses.includes(status)) continue;

          const parentDepth = depthByWorkspaceId.get(proc.workspaceId) ?? 0;
          tasks.push({
            taskId: toBashTaskId(proc.id),
            status,
            parentWorkspaceId: proc.workspaceId,
            title: proc.displayName ?? proc.id,
            createdAt: new Date(proc.startTime).toISOString(),
            depth: parentDepth + 1,
          });
        }
      }

      return parseToolResult(TaskListToolResultSchema, { tasks }, "task_list");
    },
  });
};
