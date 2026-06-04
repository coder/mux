/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/require-await */
import { describe, expect, mock, test } from "bun:test";
import { Ok } from "@/common/types/result";
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
      experiments: { dynamicWorkflows: true, subagentFileReports: true },
    });

    await adapter.runAgent({
      id: "claims",
      prompt: "Extract claims",
      outputSchema: { type: "object" },
    });

    expect(createArgs).toMatchObject({
      prompt: "Extract claims",
      experiments: { dynamicWorkflows: true, subagentFileReports: true },
    });
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
