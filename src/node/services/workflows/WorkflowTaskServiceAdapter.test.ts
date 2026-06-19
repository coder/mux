/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/require-await */
import assert from "node:assert/strict";
import { describe, expect, mock, test } from "bun:test";
import { Ok } from "@/common/types/result";
import type { TaskCreateResult } from "@/node/services/taskService";
import { WorkflowTaskServiceAdapter } from "./WorkflowTaskServiceAdapter";

describe("WorkflowTaskServiceAdapter", () => {
  test("spawns a workflow child task with workflow metadata and returns its report", async () => {
    const outputSchema = { type: "object", properties: { claims: { type: "array" } } };
    const create = mock(async (_args: unknown) =>
      Ok({ taskId: "task_1", kind: "agent" as const, status: "running" as const })
    );
    const waitForAgentReport = mock(async () => ({
      reportMarkdown: "child report",
      structuredOutput: { claims: ["durable"] },
    }));
    const adapter = new WorkflowTaskServiceAdapter({
      taskService: { create, waitForAgentReport },
      parentWorkspaceId: "parent_1",
      workflowRunId: "wfr_123",
      defaultAgentId: "explore",
    });

    const result = await adapter.runAgent({
      id: "claims",
      prompt: "Extract claims",
      title: "Claim extractor",
      outputSchema,
    });

    expect(create).toHaveBeenCalledWith({
      parentWorkspaceId: "parent_1",
      kind: "agent",
      agentId: "explore",
      prompt: "Extract claims",
      title: "Claim extractor",
      workflowTask: {
        runId: "wfr_123",
        stepId: "claims",
        outputSchema,
      },
    });
    expect(waitForAgentReport).toHaveBeenCalledWith("task_1", {
      requestingWorkspaceId: "parent_1",
      backgroundOnMessageQueued: true,
    });
    expect(result).toEqual({
      taskId: "task_1",
      reportMarkdown: "child report",
      structuredOutput: { claims: ["durable"] },
    });
  });

  test("propagates terminal task failures (model refusal) instead of hanging", async () => {
    const refusalMessage =
      "The model refused to continue (finishReason: content-filter): anthropic:claude-fable-5.";
    const create = mock(async (_args: unknown) =>
      Ok({ taskId: "task_1", kind: "agent" as const, status: "running" as const })
    );
    // TaskService rejects the report wait when the child settles terminally
    // (e.g. model_refusal). The adapter must surface that rejection so the
    // workflow step fails fast with the refusal text.
    const waitForAgentReport = mock(async () => {
      throw new Error(refusalMessage);
    });
    const adapter = new WorkflowTaskServiceAdapter({
      taskService: { create, waitForAgentReport },
      parentWorkspaceId: "parent_1",
      workflowRunId: "wfr_123",
      defaultAgentId: "explore",
    });

    await expect(adapter.runAgent({ id: "verify", prompt: "Verify claims" })).rejects.toThrow(
      refusalMessage
    );
  });

  test("inherits experiments for task creation", async () => {
    let createArgs: unknown;
    const create = mock(async (args: unknown) => {
      createArgs = args;
      return Ok({ taskId: "task_1", kind: "agent" as const, status: "running" as const });
    });
    const waitForAgentReport = mock(async () => ({ reportMarkdown: "child report" }));
    const adapter = new WorkflowTaskServiceAdapter({
      taskService: { create, waitForAgentReport },
      parentWorkspaceId: "parent_1",
      workflowRunId: "wfr_123",
      defaultAgentId: "explore",
      experiments: { dynamicWorkflows: true },
    });

    await adapter.runAgent({
      id: "claims",
      agentId: "exec",
      prompt: "Extract claims",
      outputSchema: { type: "object" },
    });

    expect(createArgs).toMatchObject({
      agentId: "exec",
      prompt: "Extract claims",
      experiments: { dynamicWorkflows: true },
    });
  });

  test("passes onRefusal through to task creation so refusal policy persists on the child", async () => {
    let createArgs: unknown;
    const create = mock(async (args: unknown) => {
      createArgs = args;
      return Ok({ taskId: "task_1", kind: "agent" as const, status: "running" as const });
    });
    let createManyArgs: unknown;
    const createMany = mock(async (args: unknown) => {
      createManyArgs = args;
      return Ok([{ taskId: "task_2", kind: "agent" as const, status: "starting" as const }]);
    });
    const waitForAgentReport = mock(async () => ({ reportMarkdown: "child report" }));
    const adapter = new WorkflowTaskServiceAdapter({
      taskService: { create, createMany, waitForAgentReport },
      parentWorkspaceId: "parent_1",
      workflowRunId: "wfr_123",
      defaultAgentId: "explore",
    });

    await adapter.runAgent({ id: "verify", prompt: "Verify claims", onRefusal: "fail" });
    expect(createArgs).toMatchObject({ onRefusal: "fail" });

    // The parallel path must preserve the refusal policy too: a verifier step
    // marked onRefusal: "fail" must fail honestly instead of silently
    // continuing on a configured fallback model.
    await adapter.createAgentTasks([
      { id: "verify-parallel", prompt: "Verify claims in parallel", onRefusal: "fail" },
    ]);
    expect(createManyArgs).toMatchObject([{ onRefusal: "fail" }]);
  });

  test("passes CLI-selected model and thinking level to workflow child task creation", async () => {
    let createArgs: unknown;
    const create = mock(async (args: unknown) => {
      createArgs = args;
      return Ok({ taskId: "task_1", kind: "agent" as const, status: "running" as const });
    });
    const waitForAgentReport = mock(async () => ({ reportMarkdown: "child report" }));
    const adapter = new WorkflowTaskServiceAdapter({
      taskService: { create, waitForAgentReport },
      parentWorkspaceId: "parent_1",
      workflowRunId: "wfr_123",
      defaultAgentId: "exec",
      modelString: "openai/gpt-5.1-codex-max",
      thinkingLevel: "high",
    });

    await adapter.runAgent({ id: "impl", prompt: "Implement" });

    expect(createArgs).toMatchObject({
      agentId: "exec",
      modelString: "openai/gpt-5.1-codex-max",
      thinkingLevel: "high",
    });
  });

  test("passes workflow experiments to Explore workflow task creation", async () => {
    let createArgs: unknown;
    const create = mock(async (args: unknown) => {
      createArgs = args;
      return Ok({ taskId: "task_1", kind: "agent" as const, status: "running" as const });
    });
    const waitForAgentReport = mock(async () => ({ reportMarkdown: "child report" }));
    const adapter = new WorkflowTaskServiceAdapter({
      taskService: { create, waitForAgentReport },
      parentWorkspaceId: "parent_1",
      workflowRunId: "wfr_123",
      defaultAgentId: "explore",
      experiments: { dynamicWorkflows: true },
    });

    await adapter.runAgent({ id: "source", prompt: "Read source" });

    expect(createArgs).toMatchObject({
      agentId: "explore",
      experiments: { dynamicWorkflows: true },
    });
  });

  test("bulk creates workflow child tasks with workflow metadata", async () => {
    const createMany = mock(
      async (
        _args: unknown[],
        options?: {
          onTaskReserved?: (index: number, result: TaskCreateResult) => Promise<void> | void;
        }
      ) => {
        const results = [
          { taskId: "task_1", kind: "agent" as const, status: "starting" as const },
          { taskId: "task_2", kind: "agent" as const, status: "queued" as const },
        ];
        for (const [index, result] of results.entries()) {
          await options?.onTaskReserved?.(index, result);
        }
        return Ok(results);
      }
    );
    const create = mock(async () =>
      Ok({ taskId: "unused", kind: "agent" as const, status: "running" as const })
    );
    const waitForAgentReport = mock(async () => ({ reportMarkdown: "unused" }));
    const adapter = new WorkflowTaskServiceAdapter({
      taskService: { create, createMany, waitForAgentReport },
      parentWorkspaceId: "parent_1",
      workflowRunId: "wfr_123",
      defaultAgentId: "explore",
      experiments: { dynamicWorkflows: true },
    });

    const created: Array<[number, string]> = [];
    const result = await adapter.createAgentTasks(
      [
        { id: "first", prompt: "Do first", title: "First" },
        { id: "second", prompt: "Do second", agentId: "exec", outputSchema: { type: "object" } },
      ],
      {
        onTaskCreated: (index, taskId) => {
          created.push([index, taskId]);
        },
      }
    );

    expect(result).toEqual([
      { taskId: "task_1", status: "starting" },
      { taskId: "task_2", status: "queued" },
    ]);
    expect(created).toEqual([
      [0, "task_1"],
      [1, "task_2"],
    ]);
    expect(createMany.mock.calls[0]?.[0]).toEqual([
      {
        parentWorkspaceId: "parent_1",
        kind: "agent",
        agentId: "explore",
        prompt: "Do first",
        title: "First",
        workflowTask: { runId: "wfr_123", stepId: "first" },
        experiments: { dynamicWorkflows: true },
      },
      {
        parentWorkspaceId: "parent_1",
        kind: "agent",
        agentId: "exec",
        prompt: "Do second",
        title: "second",
        workflowTask: { runId: "wfr_123", stepId: "second", outputSchema: { type: "object" } },
        experiments: { dynamicWorkflows: true },
      },
    ]);
    const createManyOptions: unknown = createMany.mock.calls[0]?.[1];
    assert(createManyOptions != null && typeof createManyOptions === "object");
    expect(typeof (createManyOptions as { onTaskReserved?: unknown }).onTaskReserved).toBe(
      "function"
    );
  });

  test("stamps the workflow name onto spawned tasks when known", async () => {
    const create = mock(async (_args: unknown) =>
      Ok({ taskId: "task_1", kind: "agent" as const, status: "running" as const })
    );
    const createMany = mock(async (args: unknown[]) =>
      Ok(
        args.map((_, index) => ({
          taskId: `task_${index}`,
          kind: "agent" as const,
          status: "queued" as const,
        }))
      )
    );
    const waitForAgentReport = mock(async () => ({ reportMarkdown: "child report" }));
    const adapter = new WorkflowTaskServiceAdapter({
      taskService: { create, createMany, waitForAgentReport },
      parentWorkspaceId: "parent_1",
      workflowRunId: "wfr_123",
      workflowName: "sidebar-demo",
      defaultAgentId: "explore",
    });

    await adapter.runAgent({ id: "claims", prompt: "Extract claims", title: "Claim extractor" });
    await adapter.createAgentTasks([{ id: "first", prompt: "Do first", title: "First" }]);

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      workflowTask: { runId: "wfr_123", stepId: "claims", workflowName: "sidebar-demo" },
    });
    expect(createMany.mock.calls[0]?.[0]).toMatchObject([
      { workflowTask: { runId: "wfr_123", stepId: "first", workflowName: "sidebar-demo" } },
    ]);
  });

  test("forwards run-end lifecycle hooks to the task service", async () => {
    const markWorkflowRunEnded = mock(async (_runId: string) => undefined);
    const adapter = new WorkflowTaskServiceAdapter({
      taskService: {
        create: mock(async () =>
          Ok({ taskId: "task_1", kind: "agent" as const, status: "running" as const })
        ),
        waitForAgentReport: mock(async () => ({ reportMarkdown: "unused" })),
        markWorkflowRunEnded,
      },
      parentWorkspaceId: "parent_1",
      workflowRunId: "wfr_123",
      defaultAgentId: "explore",
    });

    await adapter.onRunEnded();

    expect(markWorkflowRunEnded).toHaveBeenCalledWith("wfr_123");
  });

  test("passes workflow wait options into report waits", async () => {
    const abortController = new AbortController();
    const create = mock(async () =>
      Ok({ taskId: "task_1", kind: "agent" as const, status: "running" as const })
    );
    const waitForAgentReport = mock(async () => ({ reportMarkdown: "child report" }));
    const adapter = new WorkflowTaskServiceAdapter({
      taskService: { create, waitForAgentReport },
      parentWorkspaceId: "parent_1",
      workflowRunId: "wfr_123",
      defaultAgentId: "explore",
    });

    await adapter.runAgent({ id: "claims", prompt: "Extract claims" }, undefined, {
      abortSignal: abortController.signal,
      timeoutMs: 1_234,
      backgroundOnMessageQueued: false,
    });

    expect(waitForAgentReport).toHaveBeenCalledWith("task_1", {
      abortSignal: abortController.signal,
      timeoutMs: 1_234,
      requestingWorkspaceId: "parent_1",
      backgroundOnMessageQueued: false,
    });
  });

  test("dry-runs before applying workflow patch artifacts", async () => {
    const create = mock(async () =>
      Ok({ taskId: "task_1", kind: "agent" as const, status: "running" as const })
    );
    const waitForAgentReport = mock(async () => ({ reportMarkdown: "unused" }));
    const calls: unknown[] = [];
    const adapter = new WorkflowTaskServiceAdapter({
      taskService: { create, waitForAgentReport },
      parentWorkspaceId: "parent_1",
      workflowRunId: "wfr_123",
      defaultAgentId: "explore",
      getProjectTrusted: () => true,
      applyPatchArtifact: async (args) => {
        calls.push(args);
        return {
          success: true,
          taskId: args.task_id,
          dryRun: args.dry_run === true,
          projectResults: [{ projectPath: "/repo", projectName: "repo", status: "applied" }],
        };
      },
    });

    const result = await adapter.applyPatch({
      id: "apply-impl",
      sourceTaskId: "task_impl",
      target: "parent",
      projectPath: "/repo",
      threeWay: true,
      force: false,
    });

    expect(calls).toEqual([
      {
        task_id: "task_impl",
        project_path: "/repo",
        three_way: true,
        force: false,
        dry_run: true,
      },
      {
        task_id: "task_impl",
        project_path: "/repo",
        three_way: true,
        force: false,
        dry_run: false,
      },
    ]);
    expect(result).toMatchObject({ success: true, dryRun: false });
  });

  test("returns dry-run conflicts without applying workflow patches", async () => {
    const create = mock(async () =>
      Ok({ taskId: "task_1", kind: "agent" as const, status: "running" as const })
    );
    const waitForAgentReport = mock(async () => ({ reportMarkdown: "unused" }));
    const calls: unknown[] = [];
    const adapter = new WorkflowTaskServiceAdapter({
      taskService: { create, waitForAgentReport },
      parentWorkspaceId: "parent_1",
      workflowRunId: "wfr_123",
      defaultAgentId: "explore",
      getProjectTrusted: () => true,
      applyPatchArtifact: async (args) => {
        calls.push(args);
        return {
          success: false,
          taskId: args.task_id,
          dryRun: true,
          error: "Patch failed",
          conflictPaths: ["src/auth.ts"],
        };
      },
    });

    const result = await adapter.applyPatch({
      id: "apply-impl",
      sourceTaskId: "task_impl",
      target: "parent",
      threeWay: true,
      force: false,
    });

    expect(calls).toEqual([{ task_id: "task_impl", three_way: true, force: false, dry_run: true }]);
    expect(result).toMatchObject({ success: false, conflictPaths: ["src/auth.ts"] });
  });

  test("requires live Project Trust before applying workflow patches", async () => {
    const create = mock(async () =>
      Ok({ taskId: "task_1", kind: "agent" as const, status: "running" as const })
    );
    const waitForAgentReport = mock(async () => ({ reportMarkdown: "unused" }));
    const applyPatchArtifact = mock(async () => ({
      success: true as const,
      taskId: "task_impl",
      projectResults: [],
    }));
    const adapter = new WorkflowTaskServiceAdapter({
      taskService: { create, waitForAgentReport },
      parentWorkspaceId: "parent_1",
      workflowRunId: "wfr_123",
      defaultAgentId: "explore",
      getProjectTrusted: () => false,
      applyPatchArtifact,
    });

    await expect(
      adapter.applyPatch({
        id: "apply-impl",
        sourceTaskId: "task_impl",
        target: "parent",
        threeWay: true,
        force: false,
      })
    ).rejects.toThrow(/Project Trust/);
    expect(applyPatchArtifact).not.toHaveBeenCalled();
  });

  test("interrupts preserved descendant task workspaces for the parent workspace", async () => {
    const create = mock(async () =>
      Ok({ taskId: "task_1", kind: "agent" as const, status: "running" as const })
    );
    const waitForAgentReport = mock(async () => ({ reportMarkdown: "unused" }));
    const terminateAllDescendantAgentTasks = mock(async () => ["task_1"]);
    const adapter = new WorkflowTaskServiceAdapter({
      taskService: { create, waitForAgentReport, terminateAllDescendantAgentTasks },
      parentWorkspaceId: "parent_1",
      workflowRunId: "wfr_123",
      defaultAgentId: "explore",
    });

    await adapter.interruptRun();

    expect(terminateAllDescendantAgentTasks).toHaveBeenCalledWith("parent_1", {
      workflowRunId: "wfr_123",
    });
  });

  test("fails fast when task creation fails", async () => {
    const create = mock(async () => ({ success: false as const, error: "no runnable agent" }));
    const waitForAgentReport = mock(async () => ({ reportMarkdown: "should not wait" }));
    const adapter = new WorkflowTaskServiceAdapter({
      taskService: { create, waitForAgentReport },
      parentWorkspaceId: "parent_1",
      workflowRunId: "wfr_123",
      defaultAgentId: "explore",
    });

    await expect(adapter.runAgent({ id: "claims", prompt: "Extract claims" })).rejects.toThrow(
      /no runnable agent/
    );
    expect(waitForAgentReport).not.toHaveBeenCalled();
  });
});
