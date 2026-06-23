import assert from "node:assert/strict";
import * as path from "node:path";

import { tool } from "ai";

import type { TaskListToolSuccessResult } from "@/common/types/tools";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { WorkflowRunRecordSchema } from "@/common/orpc/schemas";
import { TaskListToolResultSchema, TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { isWorkspaceArchived } from "@/common/utils/archive";

import { isNestedWorkflowRun } from "@/common/types/workflow";
import type { AgentTaskStatus } from "@/node/services/taskService";
import type { Workspace as WorkspaceConfigEntry } from "@/node/config";
import { Config } from "@/node/config";
import { log } from "@/node/services/log";
import type { WorkspaceTurnTaskStatus } from "@/node/services/taskHandleStore";

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

const ACTIONABLE_AGENT_TASK_STATUSES = new Set<AgentTaskStatus>([
  "queued",
  "starting",
  "running",
  "awaiting_report",
]);

const ACTIONABLE_WORKSPACE_TURN_STATUSES = new Set<WorkspaceTurnTaskStatus>([
  "queued",
  "starting",
  "running",
]);

const MAX_ARCHIVE_ANCESTOR_DEPTH = 32;

interface WorkspaceArchiveLookup {
  isArchivedInScope(workspaceId: string): boolean;
}

function inferMuxRootFromWorkspaceSessionDir(workspaceSessionDir: string): string | undefined {
  assert(
    workspaceSessionDir.length > 0,
    "inferMuxRootFromWorkspaceSessionDir: workspaceSessionDir must be non-empty"
  );

  const sessionsDir = path.dirname(workspaceSessionDir);
  if (path.basename(sessionsDir) !== "sessions") {
    return undefined;
  }

  return path.dirname(sessionsDir);
}

function resolveMuxRootDir(config: ToolConfiguration): string | undefined {
  const scopedMuxHome = config.muxScope?.muxHome;
  if (scopedMuxHome && scopedMuxHome.length > 0) {
    return scopedMuxHome;
  }

  const workspaceSessionDir = config.workspaceSessionDir;
  if (workspaceSessionDir && workspaceSessionDir.length > 0) {
    return inferMuxRootFromWorkspaceSessionDir(workspaceSessionDir);
  }

  return undefined;
}

function createWorkspaceArchiveLookup(
  config: ToolConfiguration,
  rootWorkspaceId: string
): WorkspaceArchiveLookup | null {
  const muxRootDir = resolveMuxRootDir(config);
  if (!muxRootDir) {
    return null;
  }

  let cfg: ReturnType<Config["loadConfigOrDefault"]>;
  try {
    cfg = new Config(muxRootDir).loadConfigOrDefault();
  } catch (error) {
    log.debug("task_list: failed to load mux config for archive filtering", {
      workspaceId: rootWorkspaceId,
      muxRootDir,
      error,
    });
    return null;
  }

  const workspaceById = new Map<string, WorkspaceConfigEntry>();
  for (const project of cfg.projects.values()) {
    for (const workspace of project.workspaces) {
      if (workspace.id && workspace.id.length > 0) {
        workspaceById.set(workspace.id, workspace);
      }
    }
  }

  return {
    isArchivedInScope(workspaceId: string): boolean {
      if (workspaceId.length === 0) {
        return false;
      }

      const visited = new Set<string>();
      let currentWorkspaceId = workspaceId;
      for (let depth = 0; depth < MAX_ARCHIVE_ANCESTOR_DEPTH; depth += 1) {
        // Invoking task_list from an archived root should not hide that root's descendants.
        if (currentWorkspaceId === rootWorkspaceId) {
          return false;
        }

        if (visited.has(currentWorkspaceId)) {
          log.debug("task_list: parentWorkspaceId cycle during archive filtering", {
            rootWorkspaceId,
            workspaceId,
            currentWorkspaceId,
          });
          return false;
        }
        visited.add(currentWorkspaceId);

        const workspace = workspaceById.get(currentWorkspaceId);
        if (!workspace) {
          return false;
        }

        if (isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)) {
          return true;
        }

        if (!workspace.parentWorkspaceId) {
          return false;
        }
        currentWorkspaceId = workspace.parentWorkspaceId;
      }

      log.debug("task_list: archive filtering hit parent traversal limit", {
        rootWorkspaceId,
        workspaceId,
      });
      return false;
    },
  };
}

function shouldHideArchivedAgentTask(
  task: { taskId: string; status: AgentTaskStatus },
  archiveLookup: WorkspaceArchiveLookup | null
): boolean {
  return (
    archiveLookup != null &&
    !ACTIONABLE_AGENT_TASK_STATUSES.has(task.status) &&
    archiveLookup.isArchivedInScope(task.taskId)
  );
}

function shouldHideArchivedBackgroundProcess(
  proc: { status: "running" | "exited" | "killed" | "failed"; workspaceId: string },
  archiveLookup: WorkspaceArchiveLookup | null
): boolean {
  return (
    archiveLookup != null &&
    proc.status !== "running" &&
    archiveLookup.isArchivedInScope(proc.workspaceId)
  );
}

function shouldHideArchivedWorkspaceTurn(
  turn: { status: WorkspaceTurnTaskStatus; workspaceId: string },
  archiveLookup: WorkspaceArchiveLookup | null
): boolean {
  return (
    archiveLookup != null &&
    !ACTIONABLE_WORKSPACE_TURN_STATUSES.has(turn.status) &&
    archiveLookup.isArchivedInScope(turn.workspaceId)
  );
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
      const includeArchived = args.includeArchived ?? false;
      const archiveLookup = includeArchived
        ? null
        : createWorkspaceArchiveLookup(config, workspaceId);
      const agentStatuses = statuses.filter(isAgentTaskStatus);

      const allAgentTasks =
        agentStatuses.length > 0
          ? taskService.listDescendantAgentTasks(workspaceId, {
              statuses: agentStatuses,
              excludeWorkflowTasks: true,
            })
          : [];
      const agentTasks = allAgentTasks.filter(
        (task) => !shouldHideArchivedAgentTask(task, archiveLookup)
      );
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
          if (shouldHideArchivedWorkspaceTurn(turn, archiveLookup)) {
            continue;
          }
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
        for (const t of allAgentTasks) {
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

          if (shouldHideArchivedBackgroundProcess(proc, archiveLookup)) {
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
