import * as path from "node:path";

import { describe, it, expect, mock } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { createTaskListTool } from "./task_list";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import { Config, type Workspace } from "@/node/config";
import type { AgentTaskStatus, TaskService } from "@/node/services/taskService";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type {
  WorkspaceTurnTaskHandleRecord,
  WorkspaceTurnTaskStatus,
} from "@/node/services/taskHandleStore";

const mockToolCallOptions: ToolExecutionOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

interface WorkspaceFixtureOptions {
  parentWorkspaceId?: string;
  archivedAt?: string;
  unarchivedAt?: string;
}

function buildWorkspace(
  tempDir: string,
  id: string,
  options: WorkspaceFixtureOptions = {}
): Workspace {
  return {
    id,
    path: path.join(tempDir, id),
    parentWorkspaceId: options.parentWorkspaceId,
    archivedAt: options.archivedAt,
    unarchivedAt: options.unarchivedAt,
  };
}

async function writeWorkspaceConfig(tempDir: string, workspaces: Workspace[]): Promise<void> {
  const config = new Config(tempDir);
  const cfg = config.loadConfigOrDefault();
  cfg.projects.set(path.join(tempDir, "project"), { workspaces });
  await config.saveConfig(cfg);
}

function buildAgentTask(
  taskId: string,
  status: AgentTaskStatus,
  parentWorkspaceId = "root-workspace",
  depth = 1
) {
  return {
    taskId,
    status,
    parentWorkspaceId,
    agentType: "exec",
    workspaceName: taskId,
    title: taskId,
    createdAt: "2026-06-23T00:00:00.000Z",
    depth,
  };
}

function buildWorkspaceTurn(
  handleId: string,
  workspaceId: string,
  status: WorkspaceTurnTaskStatus
): WorkspaceTurnTaskHandleRecord {
  return {
    kind: "workspace_turn",
    handleId,
    ownerWorkspaceId: "root-workspace",
    workspaceId,
    turnId: `${handleId}-turn`,
    status,
    createdAt: "2026-06-23T00:00:00.000Z",
    updatedAt: "2026-06-23T00:00:01.000Z",
    createdWorkspace: true,
    disposableWorkspace: false,
    title: handleId,
  };
}

function taskIds(result: unknown): string[] {
  const parsed = result as { tasks: Array<{ taskId: string }> };
  return parsed.tasks.map((task) => task.taskId);
}

describe("task_list tool", () => {
  it("uses default statuses when none are provided", async () => {
    using tempDir = new TestTempDir("test-task-list-default-statuses");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const listDescendantAgentTasks = mock(() => []);
    const taskService = { listDescendantAgentTasks } as unknown as TaskService;

    const tool = createTaskListTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(result).toEqual({ tasks: [] });
    expect(listDescendantAgentTasks).toHaveBeenCalledWith("root-workspace", {
      statuses: ["queued", "starting", "running", "awaiting_report"],
      excludeWorkflowTasks: true,
    });
  });

  it("passes through provided statuses", async () => {
    using tempDir = new TestTempDir("test-task-list-statuses");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const listDescendantAgentTasks = mock(() => []);
    const taskService = { listDescendantAgentTasks } as unknown as TaskService;

    const tool = createTaskListTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ statuses: ["running"] }, mockToolCallOptions)
    );

    expect(result).toEqual({ tasks: [] });
    expect(listDescendantAgentTasks).toHaveBeenCalledWith("root-workspace", {
      statuses: ["running"],
      excludeWorkflowTasks: true,
    });
  });

  it("returns tasks with metadata", async () => {
    using tempDir = new TestTempDir("test-task-list-ok");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const listDescendantAgentTasks = mock(() => [
      {
        taskId: "task-1",
        status: "running",
        parentWorkspaceId: "root-workspace",
        agentType: "exec",
        workspaceName: "agent_exec_task-1",
        title: "t",
        createdAt: "2025-01-01T00:00:00.000Z",
        modelString: "anthropic:claude-haiku-4-5",
        thinkingLevel: "low",
        depth: 1,
      },
    ]);
    const taskService = { listDescendantAgentTasks } as unknown as TaskService;

    const tool = createTaskListTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(result).toEqual({
      tasks: [
        {
          taskId: "task-1",
          status: "running",
          parentWorkspaceId: "root-workspace",
          agentType: "exec",
          workspaceName: "agent_exec_task-1",
          title: "t",
          createdAt: "2025-01-01T00:00:00.000Z",
          modelString: "anthropic:claude-haiku-4-5",
          thinkingLevel: "low",
          depth: 1,
        },
      ],
    });
  });

  it("hides archived non-actionable descendant agent tasks by default", async () => {
    using tempDir = new TestTempDir("test-task-list-agent-archive-filter");
    await writeWorkspaceConfig(tempDir.path, [
      buildWorkspace(tempDir.path, "root-workspace", {
        archivedAt: "2026-06-23T00:00:00.000Z",
      }),
      buildWorkspace(tempDir.path, "archived-reported", {
        parentWorkspaceId: "root-workspace",
        archivedAt: "2026-06-23T00:01:00.000Z",
      }),
      buildWorkspace(tempDir.path, "archived-running", {
        parentWorkspaceId: "root-workspace",
        archivedAt: "2026-06-23T00:02:00.000Z",
      }),
      buildWorkspace(tempDir.path, "archived-interrupted", {
        parentWorkspaceId: "root-workspace",
        archivedAt: "2026-06-23T00:03:00.000Z",
      }),
      buildWorkspace(tempDir.path, "archived-parent", {
        parentWorkspaceId: "root-workspace",
        archivedAt: "2026-06-23T00:04:00.000Z",
      }),
      buildWorkspace(tempDir.path, "ancestor-archived-child", {
        parentWorkspaceId: "archived-parent",
      }),
      buildWorkspace(tempDir.path, "open-reported", {
        parentWorkspaceId: "root-workspace",
      }),
      buildWorkspace(tempDir.path, "unarchived-reported", {
        parentWorkspaceId: "root-workspace",
        archivedAt: "2026-06-23T00:05:00.000Z",
        unarchivedAt: "2026-06-23T00:06:00.000Z",
      }),
    ]);
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const listDescendantAgentTasks = mock(() => [
      buildAgentTask("archived-reported", "reported"),
      buildAgentTask("archived-running", "running"),
      buildAgentTask("archived-interrupted", "interrupted"),
      buildAgentTask("ancestor-archived-child", "reported", "archived-parent", 2),
      buildAgentTask("open-reported", "reported"),
      buildAgentTask("unarchived-reported", "reported"),
      buildAgentTask("missing-reported", "reported"),
    ]);
    const taskService = { listDescendantAgentTasks } as unknown as TaskService;
    const tool = createTaskListTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ statuses: ["reported", "running", "interrupted"] }, mockToolCallOptions)
    );

    expect(taskIds(result)).toEqual([
      "archived-running",
      "open-reported",
      "unarchived-reported",
      "missing-reported",
    ]);
  });

  it("includes archived descendant agent tasks when requested", async () => {
    using tempDir = new TestTempDir("test-task-list-agent-archive-include");
    await writeWorkspaceConfig(tempDir.path, [
      buildWorkspace(tempDir.path, "root-workspace"),
      buildWorkspace(tempDir.path, "archived-reported", {
        parentWorkspaceId: "root-workspace",
        archivedAt: "2026-06-23T00:01:00.000Z",
      }),
      buildWorkspace(tempDir.path, "archived-parent", {
        parentWorkspaceId: "root-workspace",
        archivedAt: "2026-06-23T00:02:00.000Z",
      }),
      buildWorkspace(tempDir.path, "ancestor-archived-child", {
        parentWorkspaceId: "archived-parent",
      }),
      buildWorkspace(tempDir.path, "open-reported", {
        parentWorkspaceId: "root-workspace",
      }),
    ]);
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });
    const listDescendantAgentTasks = mock(() => [
      buildAgentTask("archived-reported", "reported"),
      buildAgentTask("ancestor-archived-child", "reported", "archived-parent", 2),
      buildAgentTask("open-reported", "reported"),
    ]);
    const taskService = { listDescendantAgentTasks } as unknown as TaskService;
    const tool = createTaskListTool({ ...baseConfig, taskService });

    const defaultResult: unknown = await Promise.resolve(
      tool.execute!({ statuses: ["reported"], includeArchived: null }, mockToolCallOptions)
    );
    const includeArchivedResult: unknown = await Promise.resolve(
      tool.execute!({ statuses: ["reported"], includeArchived: true }, mockToolCallOptions)
    );

    expect(taskIds(defaultResult)).toEqual(["open-reported"]);
    expect(taskIds(includeArchivedResult)).toEqual([
      "archived-reported",
      "ancestor-archived-child",
      "open-reported",
    ]);
  });

  it("lists workspace-turn handles with workspace metadata", async () => {
    using tempDir = new TestTempDir("test-task-list-workspace-turns");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const listDescendantAgentTasks = mock(() => []);
    const listWorkspaceTurnTasks = mock(() => [
      {
        kind: "workspace_turn" as const,
        handleId: "wst_turn",
        ownerWorkspaceId: "root-workspace",
        workspaceId: "child-workspace",
        turnId: "turn-1",
        status: "running" as const,
        createdAt: "2026-06-19T00:00:00.000Z",
        updatedAt: "2026-06-19T00:00:01.000Z",
        createdWorkspace: true,
        disposableWorkspace: false,
        title: "Summary",
      },
    ]);
    const taskService = {
      listDescendantAgentTasks,
      listWorkspaceTurnTasks,
    } as unknown as TaskService;

    const tool = createTaskListTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ statuses: ["running"] }, mockToolCallOptions)
    );

    expect(listWorkspaceTurnTasks).toHaveBeenCalledWith("root-workspace", {
      statuses: ["running"],
    });
    expect(result).toEqual({
      tasks: [
        {
          taskId: "wst_turn",
          status: "running",
          parentWorkspaceId: "root-workspace",
          handleKind: "workspace_turn",
          workspaceId: "child-workspace",
          title: "Summary",
          createdAt: "2026-06-19T00:00:00.000Z",
          depth: 1,
        },
      ],
    });
  });

  it("hides archived non-actionable workspace-turn tasks by default", async () => {
    using tempDir = new TestTempDir("test-task-list-workspace-turn-archive-filter");
    await writeWorkspaceConfig(tempDir.path, [
      buildWorkspace(tempDir.path, "root-workspace"),
      buildWorkspace(tempDir.path, "archived-turn-workspace", {
        parentWorkspaceId: "root-workspace",
        archivedAt: "2026-06-23T00:01:00.000Z",
      }),
      buildWorkspace(tempDir.path, "archived-running-workspace", {
        parentWorkspaceId: "root-workspace",
        archivedAt: "2026-06-23T00:02:00.000Z",
      }),
      buildWorkspace(tempDir.path, "archived-turn-parent", {
        parentWorkspaceId: "root-workspace",
        archivedAt: "2026-06-23T00:03:00.000Z",
      }),
      buildWorkspace(tempDir.path, "ancestor-archived-turn-workspace", {
        parentWorkspaceId: "archived-turn-parent",
      }),
      buildWorkspace(tempDir.path, "open-turn-workspace", {
        parentWorkspaceId: "root-workspace",
      }),
    ]);
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const listDescendantAgentTasks = mock(() => []);
    const listWorkspaceTurnTasks = mock(() => [
      buildWorkspaceTurn("turn-archived-completed", "archived-turn-workspace", "completed"),
      buildWorkspaceTurn("turn-archived-running", "archived-running-workspace", "running"),
      buildWorkspaceTurn("turn-ancestor-error", "ancestor-archived-turn-workspace", "error"),
      buildWorkspaceTurn("turn-open-completed", "open-turn-workspace", "completed"),
      buildWorkspaceTurn("turn-missing-completed", "missing-turn-workspace", "completed"),
    ]);
    const taskService = {
      listDescendantAgentTasks,
      listWorkspaceTurnTasks,
    } as unknown as TaskService;
    const tool = createTaskListTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ statuses: ["completed", "failed", "running"] }, mockToolCallOptions)
    );

    expect(listWorkspaceTurnTasks).toHaveBeenCalledWith("root-workspace", {
      statuses: ["completed", "error", "running"],
    });
    expect(taskIds(result)).toEqual([
      "turn-archived-running",
      "turn-open-completed",
      "turn-missing-completed",
    ]);
  });

  it("includes archived workspace-turn tasks when requested", async () => {
    using tempDir = new TestTempDir("test-task-list-workspace-turn-archive-include");
    await writeWorkspaceConfig(tempDir.path, [
      buildWorkspace(tempDir.path, "root-workspace"),
      buildWorkspace(tempDir.path, "archived-turn-workspace", {
        parentWorkspaceId: "root-workspace",
        archivedAt: "2026-06-23T00:01:00.000Z",
      }),
      buildWorkspace(tempDir.path, "archived-turn-parent", {
        parentWorkspaceId: "root-workspace",
        archivedAt: "2026-06-23T00:02:00.000Z",
      }),
      buildWorkspace(tempDir.path, "ancestor-archived-turn-workspace", {
        parentWorkspaceId: "archived-turn-parent",
      }),
      buildWorkspace(tempDir.path, "open-turn-workspace", {
        parentWorkspaceId: "root-workspace",
      }),
    ]);
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });
    const listDescendantAgentTasks = mock(() => []);
    const listWorkspaceTurnTasks = mock(() => [
      buildWorkspaceTurn("turn-archived-completed", "archived-turn-workspace", "completed"),
      buildWorkspaceTurn("turn-ancestor-error", "ancestor-archived-turn-workspace", "error"),
      buildWorkspaceTurn("turn-open-completed", "open-turn-workspace", "completed"),
    ]);
    const taskService = {
      listDescendantAgentTasks,
      listWorkspaceTurnTasks,
    } as unknown as TaskService;
    const tool = createTaskListTool({ ...baseConfig, taskService });

    const defaultResult: unknown = await Promise.resolve(
      tool.execute!({ statuses: ["completed", "failed"] }, mockToolCallOptions)
    );
    const includeArchivedResult: unknown = await Promise.resolve(
      tool.execute!(
        { statuses: ["completed", "failed"], includeArchived: true },
        mockToolCallOptions
      )
    );

    expect(taskIds(defaultResult)).toEqual(["turn-open-completed"]);
    expect(taskIds(includeArchivedResult)).toEqual([
      "turn-archived-completed",
      "turn-ancestor-error",
      "turn-open-completed",
    ]);
  });

  it("hides archived non-running background bash tasks by default", async () => {
    using tempDir = new TestTempDir("test-task-list-background-archive-filter");
    await writeWorkspaceConfig(tempDir.path, [
      buildWorkspace(tempDir.path, "root-workspace"),
      buildWorkspace(tempDir.path, "archived-bash-workspace", {
        parentWorkspaceId: "root-workspace",
        archivedAt: "2026-06-23T00:01:00.000Z",
      }),
      buildWorkspace(tempDir.path, "open-bash-workspace", {
        parentWorkspaceId: "root-workspace",
      }),
    ]);
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });
    const listDescendantAgentTasks = mock(() => [
      buildAgentTask("archived-bash-workspace", "running"),
      buildAgentTask("open-bash-workspace", "running"),
    ]);
    const isDescendantAgentTask = mock((_root: string, candidate: string) =>
      ["archived-bash-workspace", "open-bash-workspace"].includes(candidate)
    );
    const isWorkflowOwnedDescendantAgentTask = mock(() => false);
    const taskService = {
      listDescendantAgentTasks,
      isDescendantAgentTask,
      isWorkflowOwnedDescendantAgentTask,
    } as unknown as TaskService;
    const backgroundProcessManager = {
      list: mock(() =>
        Promise.resolve([
          {
            id: "archived-exited-proc",
            workspaceId: "archived-bash-workspace",
            status: "exited" as const,
            startTime: 1,
          },
          {
            id: "archived-running-proc",
            workspaceId: "archived-bash-workspace",
            status: "running" as const,
            startTime: 2,
          },
          {
            id: "open-exited-proc",
            workspaceId: "open-bash-workspace",
            status: "exited" as const,
            startTime: 3,
          },
        ])
      ),
    } as unknown as BackgroundProcessManager;
    const tool = createTaskListTool({
      ...baseConfig,
      taskService,
      backgroundProcessManager,
    });

    const defaultResult: unknown = await Promise.resolve(
      tool.execute!({ statuses: ["running", "reported"] }, mockToolCallOptions)
    );
    const includeArchivedResult: unknown = await Promise.resolve(
      tool.execute!(
        { statuses: ["running", "reported"], includeArchived: true },
        mockToolCallOptions
      )
    );

    expect(taskIds(defaultResult)).toEqual([
      "archived-bash-workspace",
      "open-bash-workspace",
      "bash:archived-running-proc",
      "bash:open-exited-proc",
    ]);
    expect(taskIds(includeArchivedResult)).toEqual([
      "archived-bash-workspace",
      "open-bash-workspace",
      "bash:archived-exited-proc",
      "bash:archived-running-proc",
      "bash:open-exited-proc",
    ]);
  });

  const buildWorkflowRun = (id: string, status: string) => ({
    id,
    workspaceId: "root-workspace",
    workflow: {
      name: "deep-research",
      description: "Deep research",
      scope: "built-in" as const,
      executable: true,
    },
    source: "export default function workflow() { return null; }",
    sourceHash: "sha256:test",
    args: {},
    status,
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:01.000Z",
    events: [],
    steps: [],
  });

  it("includes workflow runs with their native statuses", async () => {
    using tempDir = new TestTempDir("test-task-list-workflows");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const listDescendantAgentTasks = mock(() => []);
    const taskService = { listDescendantAgentTasks } as unknown as TaskService;
    const activeRun = {
      ...buildWorkflowRun("wfr_active", "backgrounded"),
      events: [
        {
          sequence: 1,
          type: "phase" as const,
          at: "2026-05-29T00:00:01.000Z",
          name: "verify",
          details: { claimCount: 2 },
        },
        {
          sequence: 2,
          type: "task" as const,
          at: "2026-05-29T00:00:02.000Z",
          stepId: "verify-1",
          taskId: "child-task-id",
          title: "Verify claim 1",
          status: "started",
        },
      ],
      steps: [
        {
          stepId: "verify-1",
          inputHash: "sha256:verify-1",
          status: "started" as const,
          taskId: "child-task-id",
          startedAt: "2026-05-29T00:00:02.000Z",
        },
      ],
    };
    const listRuns = mock(() =>
      Promise.resolve([
        activeRun,
        // Terminal/interrupted runs are excluded by the default (active) status filter.
        buildWorkflowRun("wfr_done", "completed"),
        buildWorkflowRun("wfr_stopped", "interrupted"),
      ])
    );

    const tool = createTaskListTool({
      ...baseConfig,
      taskService,
      workflowService: {
        listRuns,
      },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ includeArchived: false }, mockToolCallOptions)
    );

    expect(listRuns).toHaveBeenCalledWith({ workspaceId: "root-workspace" });
    expect(result).toEqual({
      tasks: [
        {
          taskId: "wfr_active",
          status: "backgrounded",
          parentWorkspaceId: "root-workspace",
          title: "deep-research",
          createdAt: "2026-05-29T00:00:00.000Z",
          workflowProgress: {
            name: "deep-research",
            latestPhase: {
              name: "verify",
              at: "2026-05-29T00:00:01.000Z",
            },
            lastProgressAt: "2026-05-29T00:00:02.000Z",
            stepCounts: { started: 1, completed: 0, failed: 0, interrupted: 0 },
          },
          depth: 1,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("child-task-id");
    expect(JSON.stringify(result)).not.toContain("claimCount");
  });

  it("discovers resumable workflow runs without querying agent tasks", async () => {
    using tempDir = new TestTempDir("test-task-list-resumable-workflows");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const listDescendantAgentTasks = mock(() => {
      throw new Error("workflow-only statuses must not hit the agent task index");
    });
    const taskService = { listDescendantAgentTasks } as unknown as TaskService;
    const listRuns = mock(() =>
      Promise.resolve([
        buildWorkflowRun("wfr_running", "running"),
        buildWorkflowRun("wfr_failed", "failed"),
      ])
    );

    const tool = createTaskListTool({
      ...baseConfig,
      taskService,
      workflowService: {
        listRuns,
      },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ statuses: ["failed"] }, mockToolCallOptions)
    );

    expect(listDescendantAgentTasks).not.toHaveBeenCalled();
    expect(result).toEqual({
      tasks: [
        {
          taskId: "wfr_failed",
          status: "failed",
          parentWorkspaceId: "root-workspace",
          title: "deep-research",
          createdAt: "2026-05-29T00:00:00.000Z",
          depth: 1,
        },
      ],
    });
  });
});
