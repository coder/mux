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
