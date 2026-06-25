import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  TaskWorkspaceLifecycleToolResultSchema,
  TOOL_DEFINITIONS,
  type TaskWorkspaceLifecycleActionSchema,
} from "@/common/utils/tools/toolDefinitions";
import { isWorkspaceTurnTaskId } from "@/node/services/taskHandleStore";
import { parseToolResult, requireTaskService, requireWorkspaceId } from "./toolUtils";

import type { z } from "zod";

type LifecycleAction = z.infer<typeof TaskWorkspaceLifecycleActionSchema>;

interface LifecycleTarget {
  taskId?: string | null;
  workspaceId?: string | null;
}

function normalizeTarget(target: LifecycleTarget): { taskId?: string; workspaceId?: string } {
  if (target.taskId != null) {
    return { taskId: target.taskId };
  }
  if (target.workspaceId != null) {
    return { workspaceId: target.workspaceId };
  }
  throw new Error("task_workspace_lifecycle requires exactly one target identifier");
}

function targetKey(target: { taskId?: string; workspaceId?: string }): string {
  return target.taskId != null ? `task:${target.taskId}` : `workspace:${target.workspaceId ?? ""}`;
}

function rejectInvalidWorkspaceTaskId(
  action: LifecycleAction,
  target: { taskId?: string; workspaceId?: string }
) {
  if (target.taskId == null || isWorkspaceTurnTaskId(target.taskId)) {
    return null;
  }
  return {
    status: "invalid_scope" as const,
    action,
    taskId: target.taskId,
    note: "task_workspace_lifecycle only accepts workspace-turn task IDs (wst_...).",
  };
}

export const createTaskWorkspaceLifecycleTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.task_workspace_lifecycle.description,
    inputSchema: TOOL_DEFINITIONS.task_workspace_lifecycle.schema,
    execute: async (args): Promise<unknown> => {
      if (config.planFileOnly === true) {
        throw new Error("task_workspace_lifecycle is not available in plan mode");
      }

      const ownerWorkspaceId = requireWorkspaceId(config, "task_workspace_lifecycle");
      const taskService = requireTaskService(config, "task_workspace_lifecycle");
      const interruptActive = args.interrupt_active === true;
      const force = args.force === true;

      const seen = new Set<string>();
      const targets = args.targets.map(normalizeTarget).filter((target) => {
        const key = targetKey(target);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const results = await Promise.all(
        targets.map(async (target) => {
          const invalidTaskId = rejectInvalidWorkspaceTaskId(args.action, target);
          if (invalidTaskId != null) {
            return invalidTaskId;
          }

          switch (args.action) {
            case "archive": {
              const result = await taskService.archiveOwnedWorkspaceTurnWorkspace(
                ownerWorkspaceId,
                target,
                {
                  interruptActive,
                  acknowledgedUntrackedPaths:
                    target.workspaceId != null
                      ? (args.acknowledged_untracked_paths?.[target.workspaceId] ?? undefined)
                      : undefined,
                  acknowledgedUntrackedPathsByWorkspaceId:
                    args.acknowledged_untracked_paths ?? undefined,
                }
              );
              return result.success
                ? result.data
                : { status: "error" as const, action: args.action, ...target, error: result.error };
            }
            case "delete_worktree": {
              const result = await taskService.deleteOwnedWorkspaceTurnWorktree(
                ownerWorkspaceId,
                target,
                {
                  interruptActive,
                }
              );
              return result.success
                ? result.data
                : { status: "error" as const, action: args.action, ...target, error: result.error };
            }
            case "remove": {
              const result = await taskService.removeOwnedWorkspaceTurnWorkspace(
                ownerWorkspaceId,
                target,
                {
                  interruptActive,
                  force,
                }
              );
              return result.success
                ? result.data
                : { status: "error" as const, action: args.action, ...target, error: result.error };
            }
          }
        })
      );

      return parseToolResult(
        TaskWorkspaceLifecycleToolResultSchema,
        { results },
        "task_workspace_lifecycle"
      );
    },
  });
};
