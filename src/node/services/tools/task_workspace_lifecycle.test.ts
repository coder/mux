import { describe, it, expect, mock } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { Ok, type Result } from "@/common/types/result";
import type { TaskService } from "@/node/services/taskService";
import { createTaskWorkspaceLifecycleTool } from "./task_workspace_lifecycle";
import { TestTempDir, createTestToolConfig } from "./testHelpers";

const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

describe("task_workspace_lifecycle tool", () => {
  it("archives each target through the scoped task service lifecycle API", async () => {
    using tempDir = new TestTempDir("test-task-workspace-lifecycle-archive");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const archiveOwnedWorkspaceTurnWorkspace = mock(
      (): Promise<Result<unknown, string>> =>
        Promise.resolve(
          Ok({ status: "archived" as const, action: "archive" as const, workspaceId: "child-a" })
        )
    );
    const taskService = { archiveOwnedWorkspaceTurnWorkspace } as unknown as TaskService;
    const tool = createTaskWorkspaceLifecycleTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        { action: "archive", targets: [{ workspaceId: "child-a" }], interrupt_active: true },
        mockToolCallOptions
      )
    );

    expect(archiveOwnedWorkspaceTurnWorkspace).toHaveBeenCalledWith(
      "root-workspace",
      { workspaceId: "child-a" },
      {
        interruptActive: true,
        acknowledgedUntrackedPaths: undefined,
        acknowledgedUntrackedPathsByWorkspaceId: undefined,
      }
    );
    expect(result).toEqual({
      results: [{ status: "archived", action: "archive", workspaceId: "child-a" }],
    });
  });

  it("routes delete_worktree and remove actions independently", async () => {
    using tempDir = new TestTempDir("test-task-workspace-lifecycle-route-actions");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const deleteOwnedWorkspaceTurnWorktree = mock(
      (): Promise<Result<unknown, string>> =>
        Promise.resolve(
          Ok({
            status: "deleted_worktree" as const,
            action: "delete_worktree" as const,
            taskId: "wst_delete",
            workspaceId: "child-delete",
          })
        )
    );
    const removeOwnedWorkspaceTurnWorkspace = mock(
      (): Promise<Result<unknown, string>> =>
        Promise.resolve(
          Ok({ status: "removed" as const, action: "remove" as const, workspaceId: "child-remove" })
        )
    );
    const taskService = {
      deleteOwnedWorkspaceTurnWorktree,
      removeOwnedWorkspaceTurnWorkspace,
    } as unknown as TaskService;

    const deleteTool = createTaskWorkspaceLifecycleTool({ ...baseConfig, taskService });
    const deleteResult: unknown = await Promise.resolve(
      deleteTool.execute!(
        { action: "delete_worktree", targets: [{ taskId: "wst_delete" }] },
        mockToolCallOptions
      )
    );

    expect(deleteOwnedWorkspaceTurnWorktree).toHaveBeenCalledWith(
      "root-workspace",
      { taskId: "wst_delete" },
      { interruptActive: false }
    );
    expect(deleteResult).toEqual({
      results: [
        {
          status: "deleted_worktree",
          action: "delete_worktree",
          taskId: "wst_delete",
          workspaceId: "child-delete",
        },
      ],
    });

    const removeTool = createTaskWorkspaceLifecycleTool({ ...baseConfig, taskService });
    const removeResult: unknown = await Promise.resolve(
      removeTool.execute!(
        { action: "remove", targets: [{ workspaceId: "child-remove" }], force: true },
        mockToolCallOptions
      )
    );

    expect(removeOwnedWorkspaceTurnWorkspace).toHaveBeenCalledWith(
      "root-workspace",
      { workspaceId: "child-remove" },
      { interruptActive: false, force: true }
    );
    expect(removeResult).toEqual({
      results: [{ status: "removed", action: "remove", workspaceId: "child-remove" }],
    });
  });

  it("rejects plan-agent usage", async () => {
    using tempDir = new TestTempDir("test-task-workspace-lifecycle-plan-agent");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });
    const tool = createTaskWorkspaceLifecycleTool({
      ...baseConfig,
      planFileOnly: true,
      taskService: {} as unknown as TaskService,
    });

    let caught: unknown;
    try {
      await Promise.resolve(
        tool.execute!(
          { action: "archive", targets: [{ workspaceId: "child" }] },
          mockToolCallOptions
        )
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof Error ? caught.message : "").toContain("not available in plan mode");
  });
});
