import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  TaskWorkspaceLifecycleToolResultSchema,
  TOOL_DEFINITIONS,
} from "@/common/utils/tools/toolDefinitions";
import { parseToolResult, requireTaskService, requireWorkspaceId } from "./toolUtils";

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

      const executeTarget = async (target: { taskId?: string; workspaceId?: string }) => {
        switch (args.action) {
          case "archive": {
            const result = await taskService.archiveOwnedTaskWorkspace(ownerWorkspaceId, target, {
              interruptActive,
              acknowledgedUntrackedPaths:
                target.workspaceId != null
                  ? (args.acknowledged_untracked_paths?.[target.workspaceId] ?? undefined)
                  : undefined,
              acknowledgedUntrackedPathsByWorkspaceId:
                args.acknowledged_untracked_paths ?? undefined,
            });
            return result.success
              ? result.data
              : { status: "error" as const, action: args.action, ...target, error: result.error };
          }
          case "delete_worktree": {
            const result = await taskService.deleteOwnedTaskWorktree(ownerWorkspaceId, target, {
              interruptActive,
            });
            return result.success
              ? result.data
              : { status: "error" as const, action: args.action, ...target, error: result.error };
          }
          case "remove": {
            const result = await taskService.removeOwnedTaskWorkspace(ownerWorkspaceId, target, {
              interruptActive,
              force,
            });
            return result.success
              ? result.data
              : { status: "error" as const, action: args.action, ...target, error: result.error };
          }
        }
      };

      // Lifecycle operations mutate shared config and nested removals depend on child completion.
      // Preserve caller order so a deepest-first target list deterministically removes the subtree.
      const results: Array<Awaited<ReturnType<typeof executeTarget>>> = [];
      for (const target of targets) {
        results.push(await executeTarget(target));
      }

      return parseToolResult(
        TaskWorkspaceLifecycleToolResultSchema,
        { results },
        "task_workspace_lifecycle"
      );
    },
  });
};
