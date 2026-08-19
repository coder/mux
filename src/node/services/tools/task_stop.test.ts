/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns `any` in bun:test types */
import { describe, it, expect, mock } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { createTaskStopTool } from "./task_stop";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import type { TaskService } from "@/node/services/taskService";
import { Err, Ok, type Result } from "@/common/types/result";

const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

describe("task_stop tool", () => {
  it("returns not_found when the task does not exist", async () => {
    using tempDir = new TestTempDir("test-task-terminate-not-found");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["child-task"]),
      stopDescendantAgentTask: mock(
        (): Promise<Result<{ stoppedTaskIds: string[] }, string>> =>
          Promise.resolve(Err("Task not found"))
      ),
    } as unknown as TaskService;

    const tool = createTaskStopTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["missing-task"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [{ status: "not_found", taskId: "missing-task" }],
    });
  });

  it("returns invalid_scope when the task is outside the workspace scope", async () => {
    using tempDir = new TestTempDir("test-task-terminate-invalid-scope");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const listRuns = mock(() => Promise.resolve([]));
    const stopDescendantAgentTask = mock(
      (): Promise<Result<{ stoppedTaskIds: string[] }, string>> =>
        Promise.resolve(Err("Task is not a descendant of this workspace"))
    );
    const taskService = {
      listActiveDescendantAgentTaskIds: mock(() => ["child-task"]),
      listDescendantAgentTasks: mock(() => []),
      isDescendantAgentTask: mock(() => Promise.resolve(false)),
      stopDescendantAgentTask,
    } as unknown as TaskService;

    const tool = createTaskStopTool({
      ...baseConfig,
      taskService,
      workflowService: { listRuns },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["other-task"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [{ status: "invalid_scope", taskId: "other-task" }],
    });
    expect(listRuns).not.toHaveBeenCalled();
    expect(stopDescendantAgentTask).toHaveBeenCalledTimes(1);
  });

  it("reports aggregated cleanup failures as error, not invalid_scope", async () => {
    using tempDir = new TestTempDir("test-task-terminate-cleanup-error");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });
    const cleanupError =
      "Timed out stopping task stream (child-task); " +
      "Skipped removing task workspace (parent-task): a descendant task workspace was not removed";

    const taskService = {
      stopDescendantAgentTask: mock(
        (): Promise<Result<{ stoppedTaskIds: string[] }, string>> =>
          Promise.resolve(Err(cleanupError))
      ),
      listActiveDescendantAgentTaskIds: mock(() => []),
    } as unknown as TaskService;

    const tool = createTaskStopTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["parent-task"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [{ status: "error", taskId: "parent-task", error: cleanupError }],
    });
  });

  it("returns terminated with stoppedTaskIds on success", async () => {
    using tempDir = new TestTempDir("test-task-terminate-ok");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const taskService = {
      stopDescendantAgentTask: mock(
        (): Promise<Result<{ stoppedTaskIds: string[] }, string>> =>
          Promise.resolve(Ok({ stoppedTaskIds: ["child-task", "parent-task"] }))
      ),
    } as unknown as TaskService;

    const tool = createTaskStopTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["parent-task"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        {
          status: "stopped",
          taskId: "parent-task",
          stoppedTaskIds: ["child-task", "parent-task"],
        },
      ],
    });
  });

  it("stops ordinary task trees when dynamic workflow services are unavailable", async () => {
    using tempDir = new TestTempDir("test-task-stop-without-workflow-service");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });
    const taskService = {
      listDescendantAgentTasks: mock(() => [
        { taskId: "ordinary-grandchild", status: "running" as const },
      ]),
      stopDescendantAgentTask: mock(
        (): Promise<Result<{ stoppedTaskIds: string[] }, string>> =>
          Promise.resolve(Ok({ stoppedTaskIds: ["ordinary-grandchild", "ordinary-child"] }))
      ),
    } as unknown as TaskService;
    const tool = createTaskStopTool({ ...baseConfig, taskService });

    expect(
      await Promise.resolve(tool.execute!({ task_ids: ["ordinary-child"] }, mockToolCallOptions))
    ).toEqual({
      results: [
        {
          status: "stopped",
          taskId: "ordinary-child",
          stoppedTaskIds: ["ordinary-grandchild", "ordinary-child"],
        },
      ],
    });
  });

  it("returns an interrupted error promptly while completed task IDs still resolve", async () => {
    using tempDir = new TestTempDir("test-task-terminate-abort");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });
    const controller = new AbortController();

    const finished = Promise.withResolvers<void>();
    const taskService = {
      stopDescendantAgentTask: mock(
        (
          _workspaceId: string,
          taskId: string
        ): Promise<Result<{ stoppedTaskIds: string[] }, string>> => {
          if (taskId === "stuck-task") {
            return new Promise(() => undefined);
          }
          finished.resolve();
          return Promise.resolve(Ok({ stoppedTaskIds: [taskId] }));
        }
      ),
    } as unknown as TaskService;
    const tool = createTaskStopTool({ ...baseConfig, taskService });

    const resultPromise = Promise.resolve(
      tool.execute!(
        { task_ids: ["stuck-task", "finished-task"] },
        { ...mockToolCallOptions, abortSignal: controller.signal }
      )
    );
    await finished.promise;
    // Let the completed branch propagate through the tool's abort race before aborting the stuck one.
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
    controller.abort();

    expect(await resultPromise).toEqual({
      results: [
        {
          status: "error",
          taskId: "stuck-task",
          error: "Termination interrupted; cleanup continues in the background",
        },
        {
          status: "stopped",
          taskId: "finished-task",
          stoppedTaskIds: ["finished-task"],
        },
      ],
    });
  });

  it("interrupts a workspace turn without deleting the workspace", async () => {
    using tempDir = new TestTempDir("test-task-terminate-workspace-turn");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const interruptWorkspaceTurn = mock(
      (): Promise<Result<{ workspaceId: string }, string>> =>
        Promise.resolve(Ok({ workspaceId: "child-workspace" }))
    );
    const taskService = {
      interruptWorkspaceTurn,
      stopDescendantAgentTask: mock(() => {
        throw new Error("workspace turn IDs must not reach agent task termination");
      }),
    } as unknown as TaskService;

    const tool = createTaskStopTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["wst_turn"] }, mockToolCallOptions)
    );

    expect(interruptWorkspaceTurn).toHaveBeenCalledWith("root-workspace", "wst_turn");
    expect(result).toEqual({
      results: [
        {
          status: "stopped",
          taskId: "wst_turn",
          note: "Workspace turn stopped. The workspace is preserved for future messages.",
        },
      ],
    });
  });

  it("treats stopping a terminal workspace turn as idempotent", async () => {
    using tempDir = new TestTempDir("test-task-stop-terminal-workspace-turn");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });
    const interruptWorkspaceTurn = mock(
      (): Promise<Result<{ workspaceId: string; alreadyInactive?: boolean }, string>> =>
        Promise.resolve(Ok({ workspaceId: "child-workspace", alreadyInactive: true }))
    );
    const tool = createTaskStopTool({
      ...baseConfig,
      taskService: { interruptWorkspaceTurn } as unknown as TaskService,
    });

    expect(
      await Promise.resolve(tool.execute!({ task_ids: ["wst_turn"] }, mockToolCallOptions))
    ).toEqual({
      results: [{ status: "already_inactive", taskId: "wst_turn" }],
    });
  });

  const buildWorkflowRun = (status: string) => ({
    id: "wfr_run_1",
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

  it("interrupts a workflow run and reports it as resumable", async () => {
    using tempDir = new TestTempDir("test-task-terminate-workflow");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const getRun = mock(() => Promise.resolve(buildWorkflowRun("running")));
    const interruptRun = mock((input: { onRunInterrupted?: (runId: string) => void }) => {
      input.onRunInterrupted?.("wfr_run_1");
      return Promise.resolve(buildWorkflowRun("interrupted"));
    });
    const taskService = {
      stopDescendantAgentTask: mock(() => {
        throw new Error("workflow IDs must not reach agent task termination");
      }),
    } as unknown as TaskService;

    const tool = createTaskStopTool({
      ...baseConfig,
      taskService,
      workflowService: {
        getRun,
        interruptRun,
      },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["wfr_run_1"] }, mockToolCallOptions)
    );

    expect(getRun).toHaveBeenCalledWith({ workspaceId: "root-workspace", runId: "wfr_run_1" });
    expect(interruptRun).toHaveBeenCalledWith({
      workspaceId: "root-workspace",
      runId: "wfr_run_1",
      onRunInterrupted: expect.any(Function),
    });
    expect(result).toEqual({
      results: [
        {
          status: "stopped",
          taskId: "wfr_run_1",
          note: expect.stringContaining("workflow_resume"),
        },
      ],
    });
  });

  it("interrupts workflow runs owned by an agent subtree before stopping user-owned tasks", async () => {
    using tempDir = new TestTempDir("test-task-stop-agent-workflows-first");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });
    const events: string[] = [];
    const workflowRun = { ...buildWorkflowRun("running"), workspaceId: "child-task" };
    const workerWorkflowRun = {
      ...buildWorkflowRun("running"),
      id: "wfr_worker",
      workspaceId: "workflow-worker",
    };
    const taskService = {
      listDescendantAgentTasks: mock(
        (_taskId: string, options?: { excludeWorkflowTasks?: boolean }) =>
          options?.excludeWorkflowTasks === true
            ? []
            : [
                {
                  taskId: "workflow-worker",
                  status: "running" as const,
                  workflowRunId: "wfr_run_1",
                  workflowOwnerWorkspaceId: "child-task",
                },
              ]
      ),
      isDescendantAgentTask: mock(() => Promise.resolve(true)),
      isWorkflowOwnedDescendantAgentTask: mock(() => Promise.resolve(false)),
      stopDescendantAgentTask: mock(
        async (
          _workspaceId: string,
          _taskId: string,
          options?: { beforeStop?: () => Promise<string | null> }
        ): Promise<Result<{ stoppedTaskIds: string[] }, string>> => {
          const beforeStopError = await options?.beforeStop?.();
          if (beforeStopError != null) {
            return Err(beforeStopError);
          }
          events.push("task");
          return Ok({ stoppedTaskIds: ["child-task"] });
        }
      ),
      markWorkflowRunEnded: mock((workflowRunId: string) => {
        events.push(`sweep:${workflowRunId}`);
        return Promise.resolve();
      }),
    } as unknown as TaskService;
    const interruptRun =
      (runId: string, run: ReturnType<typeof buildWorkflowRun>, event: string) =>
      (input: {
        deferTaskSweep?: boolean;
        lockAlreadyHeld?: boolean;
        onRunInterrupted?: (interruptedRunId: string) => void;
      }) => {
        expect(input.deferTaskSweep).toBe(true);
        expect(input.lockAlreadyHeld).toBe(true);
        input.onRunInterrupted?.(runId);
        events.push(event);
        return Promise.resolve({ ...run, status: "interrupted" });
      };
    const childWorkflowService = {
      listRuns: mock(() => Promise.resolve([workflowRun])),
      getRun: mock(() => Promise.resolve(workflowRun)),
      interruptRun: mock(interruptRun("wfr_run_1", workflowRun, "workflow:child")),
    };
    const workerWorkflowService = {
      listRuns: mock(() => Promise.resolve([workerWorkflowRun])),
      getRun: mock(() => Promise.resolve(workerWorkflowRun)),
      interruptRun: mock(interruptRun("wfr_worker", workerWorkflowRun, "workflow:workflow-worker")),
    };
    const workflowServiceForWorkspace = mock((ownerWorkspaceId: string) => {
      if (ownerWorkspaceId === "child-task") return childWorkflowService;
      if (ownerWorkspaceId === "workflow-worker") return workerWorkflowService;
      throw new Error(`Unexpected workflow owner ${ownerWorkspaceId}`);
    });
    const tool = createTaskStopTool({
      ...baseConfig,
      taskService,
      workflowService: {
        listRuns: mock(() => {
          throw new Error("Parent workflow store must not be used for child-owned runs");
        }),
      },
      workflowServiceForWorkspace,
    });

    expect(
      await Promise.resolve(tool.execute!({ task_ids: ["child-task"] }, mockToolCallOptions))
    ).toEqual({
      results: [{ status: "stopped", taskId: "child-task", stoppedTaskIds: ["child-task"] }],
    });
    expect(workflowServiceForWorkspace.mock.calls.map((call) => call[0])).toEqual([
      "child-task",
      "workflow-worker",
    ]);
    expect(events).toEqual([
      "workflow:child",
      "workflow:workflow-worker",
      "task",
      "sweep:wfr_run_1",
      "sweep:wfr_worker",
    ]);
  });

  it("does not let a healthy workflow run mask an orphaned active workflow worker", async () => {
    using tempDir = new TestTempDir("test-task-stop-orphaned-workflow-worker");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });
    const healthyRun = { ...buildWorkflowRun("running"), id: "wfr_healthy", workspaceId: "child" };
    const stopDescendantAgentTask = mock(
      async (
        _workspaceId: string,
        _taskId: string,
        options?: { beforeStop?: () => Promise<string | null> }
      ): Promise<Result<{ stoppedTaskIds: string[] }, string>> => {
        const error = await options?.beforeStop?.();
        return error == null ? Ok({ stoppedTaskIds: ["child"] }) : Err(error);
      }
    );
    const taskService = {
      listDescendantAgentTasks: mock(
        (_taskId: string, options?: { excludeWorkflowTasks?: boolean }) =>
          options?.excludeWorkflowTasks === true
            ? []
            : [
                {
                  taskId: "healthy-worker",
                  status: "running" as const,
                  workflowRunId: "wfr_healthy",
                  workflowOwnerWorkspaceId: "child",
                },
                {
                  taskId: "orphan-worker",
                  status: "running" as const,
                  workflowRunId: "wfr_missing",
                  workflowOwnerWorkspaceId: "child",
                },
              ]
      ),
      stopDescendantAgentTask,
    } as unknown as TaskService;
    const ownerWorkflowService = {
      listRuns: mock(() => Promise.resolve([healthyRun])),
      getRun: mock((input: { runId: string }) =>
        Promise.resolve(input.runId === "wfr_healthy" ? healthyRun : null)
      ),
      interruptRun: mock((input: { onRunInterrupted?: (runId: string) => void }) => {
        input.onRunInterrupted?.("wfr_healthy");
        return Promise.resolve({ ...healthyRun, status: "interrupted" });
      }),
    };
    const emptyWorkflowService = {
      listRuns: mock(() => Promise.resolve([])),
      getRun: mock(() => Promise.resolve(null)),
      interruptRun: mock(() => Promise.resolve(null)),
    };
    const tool = createTaskStopTool({
      ...baseConfig,
      taskService,
      workflowServiceForWorkspace: (ownerWorkspaceId) =>
        ownerWorkspaceId === "child" ? ownerWorkflowService : emptyWorkflowService,
    });

    expect(
      await Promise.resolve(tool.execute!({ task_ids: ["child"] }, mockToolCallOptions))
    ).toEqual({
      results: [
        {
          status: "error",
          taskId: "child",
          error:
            "Owning workflow run wfr_missing for active descendant orphan-worker is missing or unreadable",
        },
      ],
    });
    expect(ownerWorkflowService.interruptRun).toHaveBeenCalledTimes(1);
    expect(stopDescendantAgentTask).toHaveBeenCalledTimes(1);
  });

  it("does not start termination when the signal is already aborted", async () => {
    using tempDir = new TestTempDir("test-task-terminate-preaborted");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });
    const controller = new AbortController();
    controller.abort();

    const stopDescendantAgentTask = mock(
      (): Promise<Result<{ stoppedTaskIds: string[] }, string>> =>
        Promise.resolve(Ok({ stoppedTaskIds: ["child-task"] }))
    );
    const tool = createTaskStopTool({
      ...baseConfig,
      taskService: { stopDescendantAgentTask } as unknown as TaskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        { task_ids: ["child-task"] },
        { ...mockToolCallOptions, abortSignal: controller.signal }
      )
    );

    expect(stopDescendantAgentTask).not.toHaveBeenCalled();
    expect(result).toEqual({
      results: [
        {
          status: "error",
          taskId: "child-task",
          error: "Termination interrupted before it started",
        },
      ],
    });
  });

  it("returns a per-task error when a workflow branch throws", async () => {
    using tempDir = new TestTempDir("test-task-terminate-workflow-throws");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const tool = createTaskStopTool({
      ...baseConfig,
      taskService: {} as unknown as TaskService,
      workflowService: {
        getRun: mock(() => Promise.reject(new Error("workflow lookup failed"))),
        interruptRun: mock(() => Promise.reject(new Error("unused"))),
      },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["wfr_run_1"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [{ status: "error", taskId: "wfr_run_1", error: "workflow lookup failed" }],
    });
  });

  it("treats interrupting an already-interrupted workflow run as idempotent success", async () => {
    using tempDir = new TestTempDir("test-task-terminate-workflow-idempotent");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const interruptRun = mock(
      (input: { retryTaskCleanup?: boolean; onRunInterrupted?: (runId: string) => void }) => {
        expect(input.retryTaskCleanup).toBe(true);
        input.onRunInterrupted?.("wfr_run_1");
        return Promise.resolve(buildWorkflowRun("interrupted"));
      }
    );
    const tool = createTaskStopTool({
      ...baseConfig,
      taskService: {} as unknown as TaskService,
      workflowService: {
        getRun: mock(() => Promise.resolve(buildWorkflowRun("interrupted"))),
        interruptRun,
      },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["wfr_run_1"] }, mockToolCallOptions)
    );

    expect(interruptRun).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      results: [
        {
          status: "already_inactive",
          taskId: "wfr_run_1",
        },
      ],
    });
  });

  it("treats stopping terminal workflow runs as idempotent", async () => {
    using tempDir = new TestTempDir("test-task-stop-workflow-terminal");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const interruptRun = mock(() => Promise.reject(new Error("must not interrupt terminal runs")));
    const tool = createTaskStopTool({
      ...baseConfig,
      taskService: {} as unknown as TaskService,
      workflowService: {
        getRun: mock(() => Promise.resolve(buildWorkflowRun("completed"))),
        interruptRun,
      },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["wfr_run_1"] }, mockToolCallOptions)
    );

    expect(interruptRun).not.toHaveBeenCalled();
    expect(result).toEqual({
      results: [{ status: "already_inactive", taskId: "wfr_run_1" }],
    });
  });

  it("treats a workflow that settles during interruption as already inactive", async () => {
    using tempDir = new TestTempDir("test-task-stop-workflow-settlement-race");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });
    const runs = [buildWorkflowRun("running"), buildWorkflowRun("completed")];
    const tool = createTaskStopTool({
      ...baseConfig,
      taskService: {} as unknown as TaskService,
      workflowService: {
        getRun: mock(() => Promise.resolve(runs.shift() ?? buildWorkflowRun("completed"))),
        interruptRun: mock(() => Promise.reject(new Error("invalid workflow transition"))),
      },
    });

    expect(
      await Promise.resolve(tool.execute!({ task_ids: ["wfr_run_1"] }, mockToolCallOptions))
    ).toEqual({
      results: [{ status: "already_inactive", taskId: "wfr_run_1" }],
    });
  });

  it("surfaces cleanup failure after this interruption persisted terminal state", async () => {
    using tempDir = new TestTempDir("test-task-stop-workflow-post-persist-failure");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });
    const getRun = mock(() => Promise.resolve(buildWorkflowRun("running")));
    const tool = createTaskStopTool({
      ...baseConfig,
      taskService: {} as unknown as TaskService,
      workflowService: {
        getRun,
        interruptRun: mock(
          (input: { onRunInterrupted?: (runId: string) => void }): Promise<never> => {
            input.onRunInterrupted?.("wfr_run_1");
            return Promise.reject(new Error("workflow worker cleanup failed"));
          }
        ),
      },
    });

    expect(
      await Promise.resolve(tool.execute!({ task_ids: ["wfr_run_1"] }, mockToolCallOptions))
    ).toEqual({
      results: [
        {
          status: "error",
          taskId: "wfr_run_1",
          error: "workflow worker cleanup failed",
        },
      ],
    });
    expect(getRun).toHaveBeenCalledTimes(1);
  });

  it("retries workflow task cleanup after a post-persistence failure", async () => {
    using tempDir = new TestTempDir("test-task-stop-workflow-cleanup-retry");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });
    const runs = [buildWorkflowRun("running"), buildWorkflowRun("interrupted")];
    let interruptCalls = 0;
    const tool = createTaskStopTool({
      ...baseConfig,
      taskService: {} as unknown as TaskService,
      workflowService: {
        getRun: mock(() => Promise.resolve(runs.shift() ?? buildWorkflowRun("interrupted"))),
        interruptRun: mock(
          (input: { retryTaskCleanup?: boolean; onRunInterrupted?: (runId: string) => void }) => {
            interruptCalls += 1;
            input.onRunInterrupted?.("wfr_run_1");
            return interruptCalls === 1
              ? Promise.reject(new Error("workflow worker cleanup failed"))
              : Promise.resolve(buildWorkflowRun("interrupted"));
          }
        ),
      },
    });

    expect(
      await Promise.resolve(tool.execute!({ task_ids: ["wfr_run_1"] }, mockToolCallOptions))
    ).toEqual({
      results: [
        {
          status: "error",
          taskId: "wfr_run_1",
          error: "workflow worker cleanup failed",
        },
      ],
    });
    expect(
      await Promise.resolve(tool.execute!({ task_ids: ["wfr_run_1"] }, mockToolCallOptions))
    ).toEqual({
      results: [{ status: "already_inactive", taskId: "wfr_run_1" }],
    });
    expect(interruptCalls).toBe(2);
  });

  it("reports workflow runs outside this workspace as not found", async () => {
    using tempDir = new TestTempDir("test-task-terminate-workflow-not-found");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const tool = createTaskStopTool({
      ...baseConfig,
      taskService: {} as unknown as TaskService,
      workflowService: {
        getRun: mock(() => Promise.resolve(null)),
        interruptRun: mock(() => Promise.reject(new Error("unused"))),
      },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["wfr_other_workspace"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [{ status: "not_found", taskId: "wfr_other_workspace" }],
    });
  });

  it("errors when workflow interrupts are requested without workflow support", async () => {
    using tempDir = new TestTempDir("test-task-terminate-workflow-no-service");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const tool = createTaskStopTool({
      ...baseConfig,
      taskService: {} as unknown as TaskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_ids: ["wfr_run_1"] }, mockToolCallOptions)
    );

    expect(result).toEqual({
      results: [
        {
          status: "error",
          taskId: "wfr_run_1",
          error: expect.stringContaining("Workflow service not available"),
        },
      ],
    });
  });
});
