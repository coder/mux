import assert from "node:assert/strict";

import type { Workspace as WorkspaceConfigEntry } from "@/node/config";
import type { ProjectsConfig } from "@/common/types/project";
import type { AgentTaskStatus, DescendantAgentTaskInfo } from "@/node/services/taskService";
import { findWorkspaceEntry } from "@/node/services/taskUtils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentTaskWorkspaceEntry = WorkspaceConfigEntry & { projectPath: string };

export interface AgentTaskIndex {
  byId: Map<string, AgentTaskWorkspaceEntry>;
  childrenByParent: Map<string, string[]>;
  parentById: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Pure index-building helpers
// ---------------------------------------------------------------------------

export function listAgentTaskWorkspaces(config: ProjectsConfig): AgentTaskWorkspaceEntry[] {
  const tasks: AgentTaskWorkspaceEntry[] = [];
  for (const [projectPath, project] of config.projects) {
    for (const workspace of project.workspaces) {
      if (!workspace.id) continue;
      if (!workspace.parentWorkspaceId) continue;
      tasks.push({ ...workspace, projectPath });
    }
  }
  return tasks;
}

export function buildAgentTaskIndex(config: ProjectsConfig): AgentTaskIndex {
  const byId = new Map<string, AgentTaskWorkspaceEntry>();
  const childrenByParent = new Map<string, string[]>();
  const parentById = new Map<string, string>();

  for (const task of listAgentTaskWorkspaces(config)) {
    const taskId = task.id!;
    byId.set(taskId, task);

    const parent = task.parentWorkspaceId;
    if (!parent) continue;

    parentById.set(taskId, parent);
    const list = childrenByParent.get(parent) ?? [];
    list.push(taskId);
    childrenByParent.set(parent, list);
  }

  return { byId, childrenByParent, parentById };
}

// ---------------------------------------------------------------------------
// Tree-traversal queries
// ---------------------------------------------------------------------------

export function listDescendantAgentTaskIdsFromIndex(
  index: AgentTaskIndex,
  workspaceId: string
): string[] {
  assert(
    workspaceId.length > 0,
    "listDescendantAgentTaskIdsFromIndex: workspaceId must be non-empty"
  );

  const result: string[] = [];
  const stack: string[] = [...(index.childrenByParent.get(workspaceId) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    result.push(next);
    const children = index.childrenByParent.get(next);
    if (children) {
      for (const child of children) {
        stack.push(child);
      }
    }
  }
  return result;
}

export function isDescendantAgentTaskUsingParentById(
  parentById: Map<string, string>,
  ancestorWorkspaceId: string,
  taskId: string
): boolean {
  let current = taskId;
  for (let i = 0; i < 32; i++) {
    const parent = parentById.get(current);
    if (!parent) return false;
    if (parent === ancestorWorkspaceId) return true;
    current = parent;
  }

  throw new Error(
    `isDescendantAgentTaskUsingParentById: possible parentWorkspaceId cycle starting at ${taskId}`
  );
}

export function listAncestorWorkspaceIdsUsingParentById(
  parentById: Map<string, string>,
  taskId: string
): string[] {
  const ancestors: string[] = [];

  let current = taskId;
  for (let i = 0; i < 32; i++) {
    const parent = parentById.get(current);
    if (!parent) return ancestors;
    ancestors.push(parent);
    current = parent;
  }

  throw new Error(
    `listAncestorWorkspaceIdsUsingParentById: possible parentWorkspaceId cycle starting at ${taskId}`
  );
}

// ---------------------------------------------------------------------------
// Depth helpers
// ---------------------------------------------------------------------------

export function getTaskDepthFromParentById(
  parentById: Map<string, string>,
  workspaceId: string
): number {
  let depth = 0;
  let current = workspaceId;
  for (let i = 0; i < 32; i++) {
    const parent = parentById.get(current);
    if (!parent) break;
    depth += 1;
    current = parent;
  }

  if (depth >= 32) {
    throw new Error(
      `getTaskDepthFromParentById: possible parentWorkspaceId cycle starting at ${workspaceId}`
    );
  }

  return depth;
}

export function getTaskDepth(config: ProjectsConfig, workspaceId: string): number {
  assert(workspaceId.length > 0, "getTaskDepth: workspaceId must be non-empty");

  return getTaskDepthFromParentById(buildAgentTaskIndex(config).parentById, workspaceId);
}

// ---------------------------------------------------------------------------
// Active-task queries
// ---------------------------------------------------------------------------

/**
 * Count currently active agent tasks.
 *
 * @param isForegroundAwaiting - returns true when a task workspace is blocked in a foreground wait
 * @param isStreaming - returns true when a task workspace is still streaming (defensive check)
 */
export function countActiveAgentTasks(
  config: ProjectsConfig,
  isForegroundAwaiting: (workspaceId: string) => boolean,
  isStreaming: (workspaceId: string) => boolean
): number {
  let activeCount = 0;
  for (const task of listAgentTaskWorkspaces(config)) {
    const status: AgentTaskStatus = task.taskStatus ?? "running";
    // If this task workspace is blocked in a foreground wait, do not count it towards parallelism.
    // This prevents deadlocks where a task spawns a nested task in the foreground while
    // maxParallelAgentTasks is low (e.g. 1).
    // Note: StreamManager can still report isStreaming() while a tool call is executing, so
    // isStreaming is not a reliable signal for "actively doing work" here.
    if (status === "running" && task.id && isForegroundAwaiting(task.id)) {
      continue;
    }
    if (status === "running" || status === "awaiting_report") {
      activeCount += 1;
      continue;
    }

    // Defensive: a task may still be streaming even after it transitioned to another status
    // (e.g. tool-call-end happened but the stream hasn't ended yet). Count it as active so we
    // never exceed the configured parallel limit.
    if (task.id && isStreaming(task.id)) {
      activeCount += 1;
    }
  }

  return activeCount;
}

export function hasActiveDescendantAgentTasks(
  config: ProjectsConfig,
  workspaceId: string
): boolean {
  assert(workspaceId.length > 0, "hasActiveDescendantAgentTasks: workspaceId must be non-empty");

  const index = buildAgentTaskIndex(config);

  const activeStatuses = new Set<AgentTaskStatus>(["queued", "running", "awaiting_report"]);
  const stack: string[] = [...(index.childrenByParent.get(workspaceId) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    const status = index.byId.get(next)?.taskStatus;
    if (status && activeStatuses.has(status)) {
      return true;
    }
    const children = index.childrenByParent.get(next);
    if (children) {
      for (const child of children) {
        stack.push(child);
      }
    }
  }

  return false;
}

export function listActiveDescendantAgentTaskIds(
  config: ProjectsConfig,
  workspaceId: string
): string[] {
  assert(workspaceId.length > 0, "listActiveDescendantAgentTaskIds: workspaceId must be non-empty");

  const index = buildAgentTaskIndex(config);

  const activeStatuses = new Set<AgentTaskStatus>(["queued", "running", "awaiting_report"]);
  const result: string[] = [];
  const stack: string[] = [...(index.childrenByParent.get(workspaceId) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    const status = index.byId.get(next)?.taskStatus;
    if (status && activeStatuses.has(status)) {
      result.push(next);
    }
    const children = index.childrenByParent.get(next);
    if (children) {
      for (const child of children) {
        stack.push(child);
      }
    }
  }
  return result;
}

export function listDescendantAgentTasks(
  config: ProjectsConfig,
  workspaceId: string,
  options?: { statuses?: AgentTaskStatus[] }
): DescendantAgentTaskInfo[] {
  assert(workspaceId.length > 0, "listDescendantAgentTasks: workspaceId must be non-empty");

  const statuses = options?.statuses;
  const statusFilter = statuses && statuses.length > 0 ? new Set(statuses) : null;

  const index = buildAgentTaskIndex(config);

  const result: DescendantAgentTaskInfo[] = [];

  const stack: Array<{ taskId: string; depth: number }> = [];
  for (const childTaskId of index.childrenByParent.get(workspaceId) ?? []) {
    stack.push({ taskId: childTaskId, depth: 1 });
  }

  while (stack.length > 0) {
    const next = stack.pop()!;
    const entry = index.byId.get(next.taskId);
    if (!entry) continue;

    assert(
      entry.parentWorkspaceId,
      `listDescendantAgentTasks: task ${next.taskId} is missing parentWorkspaceId`
    );

    const status: AgentTaskStatus = entry.taskStatus ?? "running";
    if (!statusFilter || statusFilter.has(status)) {
      result.push({
        taskId: next.taskId,
        status,
        parentWorkspaceId: entry.parentWorkspaceId,
        agentType: entry.agentType,
        workspaceName: entry.name,
        title: entry.title,
        createdAt: entry.createdAt,
        modelString: entry.aiSettings?.model,
        thinkingLevel: entry.aiSettings?.thinkingLevel,
        depth: next.depth,
      });
    }

    for (const childTaskId of index.childrenByParent.get(next.taskId) ?? []) {
      stack.push({ taskId: childTaskId, depth: next.depth + 1 });
    }
  }

  // Stable ordering: oldest first, then depth (ties by taskId for determinism).
  result.sort((a, b) => {
    const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
    const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
    if (aTime !== bTime) return aTime - bTime;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.taskId.localeCompare(b.taskId);
  });

  return result;
}

// ---------------------------------------------------------------------------
// Status query
// ---------------------------------------------------------------------------

export function getAgentTaskStatus(config: ProjectsConfig, taskId: string): AgentTaskStatus | null {
  assert(taskId.length > 0, "getAgentTaskStatus: taskId must be non-empty");

  const entry = findWorkspaceEntry(config, taskId);
  const status = entry?.workspace.taskStatus;
  return status ?? null;
}
