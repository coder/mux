/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/require-await, @typescript-eslint/restrict-template-expressions, local/no-sync-fs-methods */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ORPCError, createRouterClient } from "@orpc/server";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
import { Config } from "@/node/config";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { ForegroundWaitBackgroundedError } from "@/node/services/taskService";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import type { ORPCContext } from "./context";
import { router } from "./router";

describe("router workspace goal validation", () => {
  test("goal routes do not touch goal files for unknown workspaces", async () => {
    const getGoal = mock(() => Promise.resolve({ goalId: "should-not-read" }));
    const clearGoal = mock(() => Promise.resolve({ goalId: "should-not-clear" }));
    const setGoal = mock(() =>
      Promise.resolve({ success: true, data: { goalId: "should-not-set" } })
    );
    const context = {
      workspaceService: {
        getInfo: mock(() => Promise.resolve(null)),
      },
      workspaceGoalService: {
        getGoal,
        clearGoal,
        setGoal,
      },
    } as unknown as ORPCContext;
    const client = createRouterClient(router(), { context });

    const goalResult = await Promise.resolve(
      client.workspace.getGoal({ workspaceId: "../../tmp/not-a-workspace" })
    );
    expect(goalResult).toEqual({ goal: null });
    const clearResult = await Promise.resolve(
      client.workspace.clearGoal({ workspaceId: "../../tmp/not-a-workspace" })
    );
    expect(clearResult).toEqual({ cleared: false });
    const setResult = await Promise.resolve(
      client.workspace.setGoal({
        workspaceId: "../../tmp/not-a-workspace",
        objective: "do not write",
      })
    );
    expect(setResult).toEqual({
      success: false,
      error: { type: "invalid_transition", message: "Workspace not found." },
    });

    expect(getGoal).not.toHaveBeenCalled();
    expect(setGoal).not.toHaveBeenCalled();
    expect(clearGoal).not.toHaveBeenCalled();
  });
});

async function waitForRouterCondition(
  description: string,
  predicate: () => boolean
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForRouterWorkflowStatus(
  client: {
    workflows: {
      getRun(input: { workspaceId: string; runId: string }): Promise<{ status: string } | null>;
    };
  },
  workspaceId: string,
  runId: string,
  status: string
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const run = await client.workflows.getRun({ workspaceId, runId });
    if (run?.status === status) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const run = await client.workflows.getRun({ workspaceId, runId });
  throw new Error(`Timed out waiting for ${runId} to become ${status}; got ${run?.status}`);
}

describe("router workflow routes", () => {
  let tempDir: string;
  let config: Config;
  let projectPath: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-router-workflows-test-"));
    config = new Config(tempDir);
    projectPath = path.join(tempDir, "project");
    fs.mkdirSync(path.join(projectPath, ".mux", "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(projectPath, ".mux", "workflows", "demo.js"),
      `export const metadata = { description: "Demo workflow" };\nexport default function workflow({ args }) { return { reportMarkdown: args.topic }; }\n`
    );
    await config.editConfig((current) => {
      current.projects.set(projectPath, { workspaces: [], trusted: true });
      return current;
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createContext(options: {
    enabled: boolean;
    workspacePath?: string;
    subProjectPath?: string;
  }): ORPCContext {
    const workspacePath = options.workspacePath ?? projectPath;
    return {
      workflowSchedulerService: {
        runProjectScheduleNow: mock(async () => ({
          runId: "wfr_manual_project_schedule",
          status: "backgrounded",
        })),
      },
      workflowRuntimeFactory: new QuickJSRuntimeFactory(),
      config,
      aiService: {
        waitForInit: mock(async () => undefined),
        // No workspace.* host actions wired in this fixture; resolveWorkflowContext
        // tolerates undefined (actions fall through to their throwing stubs).
        getWorkflowHostActions: mock(() => undefined),
        getWorkspaceMetadata: mock(async () => ({
          success: true,
          data: {
            id: "workspace-1",
            name: "workspace-1",
            projectPath,
            namedWorkspacePath: workspacePath,
            ...(options.subProjectPath != null ? { subProjectPath: options.subProjectPath } : {}),
            runtimeConfig: { type: "local", srcBaseDir: tempDir },
          },
        })),
      },
      workspaceService: {
        waitForWorkspaceIdle: mock(async () => undefined),
        prepareManualWorkflowInvocation: mock(async () => undefined),
        appendWorkflowRunInvocation: mock(async () => true),
        isWorkflowInvocationCurrent: mock(async () => false),
        getWorkflowContinuationSendOptions: mock(() => null),
        sendMessage: mock(async () => ({ success: true, data: undefined })),
      },
      taskService: {},
      experimentsService: {
        isExperimentEnabled: mock(() => options.enabled),
      },
    } as unknown as ORPCContext;
  }

  test("lists workflow definitions only when dynamic workflows are enabled", async () => {
    const disabledClient = createRouterClient(router(), {
      context: createContext({ enabled: false }),
    });
    await expect(
      disabledClient.workflows.listDefinitions({ workspaceId: "workspace-1" })
    ).rejects.toThrow(/Dynamic workflows are disabled/);

    const enabledClient = createRouterClient(router(), {
      context: createContext({ enabled: true }),
    });
    await expect(
      enabledClient.workflows.readDefinition({ workspaceId: "workspace-1", name: "demo" })
    ).resolves.toMatchObject({
      descriptor: expect.objectContaining({ name: "demo", scope: "project" }),
      source: expect.stringContaining("reportMarkdown: args.topic"),
    });
    await expect(enabledClient.workflows.listDefinitions({ projectPath })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "demo", scope: "project", executable: true }),
      ])
    );
    await expect(
      enabledClient.workflows.listDefinitions({ workspaceId: "workspace-1" })
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "demo", scope: "project", executable: true }),
      ])
    );
  });

  test("resolves scheduled sub-project workflow definitions inside the target workspace", async () => {
    const workspacePath = path.join(tempDir, "workspace-checkout");
    const subProjectPath = path.join(projectPath, "packages", "api");
    const workspaceSubProjectPath = path.join(workspacePath, "packages", "api");
    fs.mkdirSync(path.join(workspaceSubProjectPath, ".mux", "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceSubProjectPath, ".mux", "workflows", "sub-scan.js"),
      `export const metadata = { description: "Sub-project scan" };\nexport default function workflow() { return {}; }\n`
    );
    await config.editConfig((current) => {
      current.projects.set(subProjectPath, {
        parentProjectPath: projectPath,
        workspaces: [],
      });
      return current;
    });
    const client = createRouterClient(router(), {
      context: createContext({ enabled: true, workspacePath }),
    });

    const definitions = await client.workflows.listDefinitions({
      workspaceId: "workspace-1",
      projectPath: subProjectPath,
    });

    expect(definitions).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "sub-scan", scope: "project" })])
    );
    expect(definitions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "demo" })])
    );
  });

  test("project workflow discovery scans the requested project, not an active workspace checkout", async () => {
    const workspacePath = path.join(tempDir, "workspace-checkout");
    fs.mkdirSync(path.join(workspacePath, ".mux", "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, ".mux", "workflows", "workspace-only.js"),
      `export const metadata = { description: "Workspace-only workflow" };\nexport default function workflow() { return {}; }\n`
    );
    await config.editConfig((current) => {
      current.projects.set(projectPath, {
        ...(current.projects.get(projectPath) ?? { workspaces: [] }),
        workspaces: [{ id: "workspace-1", path: workspacePath }],
      });
      return current;
    });
    const client = createRouterClient(router(), {
      context: createContext({ enabled: true, workspacePath }),
    });

    const definitions = await client.workflows.listDefinitions({ projectPath });

    expect(definitions).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "demo", scope: "project" })])
    );
    expect(definitions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "workspace-only" })])
    );
  });

  test("rejects missing workflow definition discovery inputs", async () => {
    const client = createRouterClient(router(), {
      context: createContext({ enabled: true }),
    });

    await expect(client.workflows.listDefinitions({} as never)).rejects.toThrow();
  });

  test("validates sub-project new-workspace schedules against owner workspace templates", async () => {
    const subProjectPath = path.join(projectPath, "packages", "api");
    await config.editConfig((current) => {
      current.projects.set(projectPath, {
        trusted: true,
        workspaces: [
          {
            id: "project-dir-template",
            path: projectPath,
            name: "project-dir-template",
            runtimeConfig: { type: "local" },
          },
        ],
      });
      current.projects.set(subProjectPath, {
        parentProjectPath: projectPath,
        workspaces: [],
      });
      return current;
    });
    const client = createRouterClient(router(), { context: createContext({ enabled: true }) });

    const result = await client.projects.workflowSchedules.set({
      projectPath: subProjectPath,
      schedule: {
        enabled: true,
        workflowName: "demo",
        intervalMs: 60_000,
        target: { type: "new-workspace", trunkBranch: "main" },
      },
    });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("project-dir local workspaces"),
    });
  });

  test("rejects existing-workspace conflicts with workspace schedules", async () => {
    await config.editConfig((current) => {
      current.projects.set(projectPath, {
        trusted: true,
        workspaces: [
          {
            id: "workspace-1",
            path: path.join(tempDir, "workspace-1"),
            workflowSchedule: {
              enabled: true,
              workflowName: "demo",
              intervalMs: 60_000,
            },
          },
        ],
      });
      return current;
    });
    const client = createRouterClient(router(), { context: createContext({ enabled: true }) });

    const result = await client.projects.workflowSchedules.set({
      projectPath,
      schedule: {
        enabled: true,
        workflowName: "demo",
        intervalMs: 60_000,
        target: { type: "existing-workspace", workspaceId: "workspace-1" },
      },
    });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("already has an automation"),
    });
  });

  test("rejects existing-workspace conflicts across owner project schedules", async () => {
    const subProjectPath = path.join(projectPath, "packages", "api");
    await config.editConfig((current) => {
      current.projects.set(projectPath, {
        trusted: true,
        workspaces: [{ id: "workspace-1", path: path.join(tempDir, "workspace-1") }],
        workflowSchedules: [
          {
            id: "parent-schedule",
            enabled: true,
            workflowName: "demo",
            intervalMs: 60_000,
            target: { type: "existing-workspace", workspaceId: "workspace-1" },
          },
        ],
      });
      current.projects.set(subProjectPath, {
        parentProjectPath: projectPath,
        workspaces: [],
      });
      return current;
    });
    const client = createRouterClient(router(), { context: createContext({ enabled: true }) });

    const result = await client.projects.workflowSchedules.set({
      projectPath: subProjectPath,
      schedule: {
        enabled: true,
        workflowName: "demo",
        intervalMs: 60_000,
        target: { type: "existing-workspace", workspaceId: "workspace-1" },
      },
    });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("already has an automation"),
    });
  });

  test("saves project workflow schedules through the API", async () => {
    const client = createRouterClient(router(), { context: createContext({ enabled: true }) });

    const result = await client.projects.workflowSchedules.set({
      projectPath,
      schedule: {
        title: "GitHub triage",
        enabled: true,
        workflowName: "demo",
        intervalMs: 6 * 60 * 60_000,
        args: { label: "needs-triage" },
        contextMode: "reset",
        target: { type: "new-workspace", trunkBranch: "main", branchName: "scheduled-triage" },
      },
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        title: "GitHub triage",
        enabled: true,
        workflowName: "demo",
        intervalMs: 6 * 60 * 60_000,
        args: { label: "needs-triage" },
        target: { type: "new-workspace", trunkBranch: "main", branchName: "scheduled-triage" },
      },
    });
    const storedSchedule = config.loadConfigOrDefault().projects.get(projectPath)
      ?.workflowSchedules?.[0];
    expect(storedSchedule?.contextMode).toBeUndefined();
    expect(storedSchedule).toMatchObject({
      id: expect.any(String),
      title: "GitHub triage",
      workflowName: "demo",
    });
  });

  test("rejects multiple project schedules targeting the same existing workspace", async () => {
    await config.editConfig((current) => {
      current.projects.set(projectPath, {
        ...(current.projects.get(projectPath) ?? { workspaces: [] }),
        workspaces: [{ id: "workspace-1", path: path.join(projectPath, "workspace-1") }],
      });
      return current;
    });
    const client = createRouterClient(router(), { context: createContext({ enabled: true }) });

    const first = await client.projects.workflowSchedules.set({
      projectPath,
      schedule: {
        enabled: true,
        workflowName: "demo",
        intervalMs: 15 * 60_000,
        target: { type: "existing-workspace", workspaceId: "workspace-1" },
      },
    });
    expect(first.success).toBe(true);

    if (!first.success) throw new Error("Expected first project schedule save to succeed");
    const update = await client.projects.workflowSchedules.set({
      projectPath,
      schedule: {
        id: first.data.id,
        enabled: false,
        workflowName: "demo",
        intervalMs: 30 * 60_000,
        target: { type: "existing-workspace", workspaceId: "workspace-1" },
      },
    });
    expect(update.success).toBe(true);

    const duplicate = await client.projects.workflowSchedules.set({
      projectPath,
      schedule: {
        enabled: true,
        workflowName: "demo",
        intervalMs: 30 * 60_000,
        target: { type: "existing-workspace", workspaceId: "workspace-1" },
      },
    });

    expect(duplicate).toEqual({
      success: false,
      error:
        "Failed to save project workflow schedule: Existing-workspace project automation target already has an automation",
    });
  });

  test("rejects unsupported fresh-workspace project automations on save", async () => {
    await config.editConfig((current) => {
      current.projects.set(projectPath, {
        ...(current.projects.get(projectPath) ?? { workspaces: [] }),
        workspaces: [
          {
            id: "workspace-1",
            path: projectPath,
            runtimeConfig: { type: "local" },
          },
        ],
      });
      return current;
    });
    const client = createRouterClient(router(), { context: createContext({ enabled: true }) });

    const result = await client.projects.workflowSchedules.set({
      projectPath,
      schedule: {
        enabled: true,
        workflowName: "demo",
        intervalMs: 15 * 60_000,
        target: { type: "new-workspace", trunkBranch: "main" },
      },
    });

    expect(result).toEqual({
      success: false,
      error:
        "Failed to save project workflow schedule: New-workspace scheduled runs are not supported for project-dir local workspaces yet.",
    });
  });

  test("runs project workflow schedules through the API", async () => {
    const context = createContext({ enabled: true });
    const runProjectScheduleNow = mock(
      async (_input: { projectPath: string; scheduleId: string }) => ({
        runId: "wfr_manual_project_schedule",
        status: "backgrounded",
      })
    );
    context.workflowSchedulerService = {
      runProjectScheduleNow,
    } as unknown as ORPCContext["workflowSchedulerService"];
    const client = createRouterClient(router(), { context });

    const result = await client.projects.workflowSchedules.run({
      projectPath: `${projectPath}/`,
      scheduleId: "automation-1",
    });

    expect(result).toEqual({
      success: true,
      data: { runId: "wfr_manual_project_schedule", status: "backgrounded" },
    });
    expect(runProjectScheduleNow).toHaveBeenCalledWith({
      projectPath,
      scheduleId: "automation-1",
    });
  });

  test("promotes a scratch workflow run through the API", async () => {
    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir("workspace-1") });
    await runStore.createRun({
      id: "wfr_scratch_api",
      workspaceId: "workspace-1",
      definition: { name: "scratch", description: "Scratch", scope: "scratch", executable: true },
      definitionSource:
        "export default function workflow() { return { reportMarkdown: 'scratch api' }; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const client = createRouterClient(router(), { context: createContext({ enabled: true }) });

    await expect(
      client.workflows.promoteScratch({
        workspaceId: "workspace-1",
        runId: "wfr_scratch_api",
        name: "scratch-api",
        description: "Scratch API workflow",
        location: "project",
        overwrite: false,
      })
    ).resolves.toMatchObject({ name: "scratch-api", scope: "project", executable: true });
    expect(
      fs.readFileSync(path.join(projectPath, ".mux", "workflows", "scratch-api.js"), "utf-8")
    ).toContain("Scratch API workflow");
  });

  test("promotes a workspace scratch workflow definition through the API without a run", async () => {
    const scratchRoot = path.join(projectPath, ".mux", "workflows", ".scratch");
    fs.mkdirSync(scratchRoot, { recursive: true });
    fs.writeFileSync(
      path.join(scratchRoot, "scratch-draft.js"),
      "export const metadata = { description: \"Scratch draft\" };\nexport default function workflow() { return { reportMarkdown: 'scratch api' }; }\n",
      "utf-8"
    );
    const client = createRouterClient(router(), { context: createContext({ enabled: true }) });

    await expect(
      client.workflows.promoteScratchDefinition({
        workspaceId: "workspace-1",
        name: "scratch-draft",
        description: "Reusable draft workflow",
        location: "project",
        overwrite: false,
      })
    ).resolves.toMatchObject({ name: "scratch-draft", scope: "project", executable: true });
    expect(
      fs.readFileSync(path.join(projectPath, ".mux", "workflows", "scratch-draft.js"), "utf-8")
    ).toContain("Reusable draft workflow");
  });

  test("interrupts and resumes workflow runs through the API", async () => {
    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir("workspace-1") });
    await runStore.createRun({
      id: "wfr_api_resume",
      workspaceId: "workspace-1",
      definition: { name: "demo", description: "Demo", scope: "built-in", executable: true },
      definitionSource:
        "export default function workflow() { return { reportMarkdown: 'resumed via api' }; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });

    const client = createRouterClient(router(), { context: createContext({ enabled: true }) });

    await expect(
      client.workflows.interrupt({ workspaceId: "workspace-1", runId: "wfr_api_resume" })
    ).resolves.toMatchObject({ id: "wfr_api_resume", status: "interrupted" });
    await expect(
      client.workflows.resume({ workspaceId: "workspace-1", runId: "wfr_api_resume" })
    ).resolves.toEqual({
      runId: "wfr_api_resume",
      status: "running",
      result: null,
    });
    await waitForRouterWorkflowStatus(client, "workspace-1", "wfr_api_resume", "completed");
  });

  test("retries a recoverable failed workflow through the API", async () => {
    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir("workspace-1") });
    await runStore.createRun({
      id: "wfr_api_retry",
      workspaceId: "workspace-1",
      definition: { name: "demo", description: "Demo", scope: "built-in", executable: true },
      definitionSource:
        "export default function workflow() { return { reportMarkdown: 'retried via api' }; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendEvent("wfr_api_retry", {
      sequence: 1,
      type: "error",
      at: "2026-05-29T00:00:00.750Z",
      message: "Execution interrupted",
    });
    await runStore.appendStatus("wfr_api_retry", "failed", "2026-05-29T00:00:00.751Z");
    const client = createRouterClient(router(), { context: createContext({ enabled: true }) });

    await expect(
      client.workflows.retryFromCheckpoint({ workspaceId: "workspace-1", runId: "wfr_api_retry" })
    ).resolves.toEqual({
      runId: "wfr_api_retry",
      status: "running",
      result: null,
    });
    await waitForRouterWorkflowStatus(client, "workspace-1", "wfr_api_retry", "completed");
  });

  test("continues current workflow invocations after checkpoint retry completes", async () => {
    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir("workspace-1") });
    await runStore.createRun({
      id: "wfr_api_retry_continue",
      workspaceId: "workspace-1",
      definition: { name: "demo", description: "Demo", scope: "built-in", executable: true },
      definitionSource:
        "export default function workflow() { return { reportMarkdown: 'continued after retry' }; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendEvent("wfr_api_retry_continue", {
      sequence: 1,
      type: "error",
      at: "2026-05-29T00:00:00.750Z",
      message: "Execution interrupted",
    });
    await runStore.appendStatus("wfr_api_retry_continue", "failed", "2026-05-29T00:00:00.751Z");
    const context = createContext({ enabled: true });
    const workspaceService = context.workspaceService as unknown as {
      isWorkflowInvocationCurrent: ReturnType<typeof mock>;
      getWorkflowContinuationSendOptions: ReturnType<typeof mock>;
      sendMessage: ReturnType<typeof mock>;
    };
    workspaceService.isWorkflowInvocationCurrent = mock(async () => true);
    workspaceService.getWorkflowContinuationSendOptions = mock(() => ({
      model: "test:model",
      agentId: "exec",
    }));
    workspaceService.sendMessage = mock(async () => ({ success: true, data: undefined }));
    const client = createRouterClient(router(), { context });

    await expect(
      client.workflows.retryFromCheckpoint({
        workspaceId: "workspace-1",
        runId: "wfr_api_retry_continue",
      })
    ).resolves.toEqual({
      runId: "wfr_api_retry_continue",
      status: "running",
      result: null,
    });
    await waitForRouterCondition(
      "checkpoint retry continuation",
      () => workspaceService.sendMessage.mock.calls.length === 1
    );

    expect(workspaceService.sendMessage.mock.calls[0]?.[0]).toBe("workspace-1");
    expect(workspaceService.sendMessage.mock.calls[0]?.[1]).toContain("<mux_workflow_result>");
    expect(workspaceService.sendMessage.mock.calls[0]?.[2]).toMatchObject({
      model: "test:model",
      agentId: "exec",
      skipAiSettingsPersistence: true,
      muxMetadata: {
        type: "workflow-result",
        rawCommand: "workflow_run demo",
        commandPrefix: "workflow_run",
        runId: "wfr_api_retry_continue",
        requestedModel: "test:model",
      },
    });
    expect(workspaceService.sendMessage.mock.calls[0]?.[3]).toMatchObject({
      skipAutoResumeReset: true,
      synthetic: true,
      agentInitiated: true,
      requireIdle: true,
      startStreamInBackground: true,
    });
  });

  test("starts a trusted project-local workflow through the API", async () => {
    const client = createRouterClient(router(), { context: createContext({ enabled: true }) });

    const result = await client.workflows.start({
      workspaceId: "workspace-1",
      name: "demo",
      args: { topic: "workflow routes" },
    });

    expect(result.status).toBe("completed");
    expect(result.runId).toMatch(/^wfr_/);
    expect(result.result).toEqual({ reportMarkdown: "workflow routes" });

    await expect(
      client.workflows.getRun({ workspaceId: "workspace-1", runId: result.runId })
    ).resolves.toMatchObject({
      id: result.runId,
      workspaceId: "workspace-1",
      definition: expect.objectContaining({ name: "demo" }),
      status: "completed",
    });
    await expect(client.workflows.listRuns({ workspaceId: "workspace-1" })).resolves.toEqual([
      expect.objectContaining({ id: result.runId, status: "completed" }),
    ]);
  });

  test("persists workflow slash invocations before returning", async () => {
    const context = createContext({ enabled: true });
    const workspaceService = context.workspaceService as unknown as {
      appendWorkflowRunInvocation: ReturnType<typeof mock>;
    };
    const client = createRouterClient(router(), { context });

    const result = await client.workflows.start({
      workspaceId: "workspace-1",
      name: "demo",
      runInBackground: true,
      args: { input: "workflow routes" },
      rawCommand: "/demo workflow routes",
    });

    expect(result).toMatchObject({
      status: "running",
      invocationMessagePersisted: true,
    });
    expect(workspaceService.appendWorkflowRunInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        rawCommand: "/demo workflow routes",
        name: "demo",
        args: { input: "workflow routes" },
        runId: result.runId,
        status: "running",
      })
    );
    await waitForRouterWorkflowStatus(client, "workspace-1", result.runId, "completed");
  });

  test("fills projectPath defaults for slash workflow arg schemas", async () => {
    fs.writeFileSync(
      path.join(projectPath, ".mux", "workflows", "needs-project-path.js"),
      `const s = mux.schema;
export const metadata = {
  description: "Needs project path",
  argsSchema: s.object({
    projectPath: s.string(),
    input: s.optional(s.string()),
  }),
};
export default function workflow({ args }) { return { reportMarkdown: args.projectPath + ":" + args.input }; }
`
    );
    const context = createContext({ enabled: true });
    const workspaceService = context.workspaceService as unknown as {
      appendWorkflowRunInvocation: ReturnType<typeof mock>;
    };
    const client = createRouterClient(router(), { context });

    const result = await client.workflows.start({
      workspaceId: "workspace-1",
      name: "needs-project-path",
      runInBackground: true,
      args: { input: "hello" },
      rawCommand: "/workflow needs-project-path hello",
    });

    const run = await client.workflows.getRun({ workspaceId: "workspace-1", runId: result.runId });
    expect(run?.args).toEqual({ projectPath, input: "hello" });
    expect(workspaceService.appendWorkflowRunInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        args: { input: "hello" },
        rawCommand: "/workflow needs-project-path hello",
      })
    );
  });

  test("fills slash projectPath defaults from the active sub-project checkout", async () => {
    const workspacePath = path.join(tempDir, "workspace-checkout");
    const subProjectPath = path.join(projectPath, "packages", "api");
    const workspaceSubProjectPath = path.join(workspacePath, "packages", "api");
    fs.mkdirSync(path.join(workspacePath, ".mux", "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, ".mux", "workflows", "needs-active-project.js"),
      `const s = mux.schema;
export const metadata = {
  description: "Needs active project",
  argsSchema: s.object({ projectPath: s.string() }),
};
export default function workflow({ args }) { return { reportMarkdown: args.projectPath }; }
`
    );
    const client = createRouterClient(router(), {
      context: createContext({ enabled: true, workspacePath, subProjectPath }),
    });

    const result = await client.workflows.start({
      workspaceId: "workspace-1",
      name: "needs-active-project",
      runInBackground: true,
      args: {},
      rawCommand: "/workflow needs-active-project",
    });

    const run = await client.workflows.getRun({ workspaceId: "workspace-1", runId: result.runId });
    expect(run?.args).toEqual({ projectPath: workspaceSubProjectPath });
  });

  test("reports workflow argument validation as a bad request", async () => {
    fs.writeFileSync(
      path.join(projectPath, ".mux", "workflows", "needs-topic.js"),
      `const s = mux.schema;
export const metadata = {
  description: "Needs topic",
  argsSchema: s.object({ topic: s.string() }),
};
export default function workflow({ args }) { return { reportMarkdown: args.topic }; }
`
    );
    const client = createRouterClient(router(), { context: createContext({ enabled: true }) });

    let thrown: unknown;
    try {
      await client.workflows.start({
        workspaceId: "workspace-1",
        name: "needs-topic",
        args: {},
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ORPCError);
    expect((thrown as { code?: string }).code).toBe("BAD_REQUEST");
    expect(thrown).toHaveProperty("message", "Workflow argument topic is required");
  });

  test("reports malformed workflow argument schemas as a bad request", async () => {
    fs.writeFileSync(
      path.join(projectPath, ".mux", "workflows", "bad-args-schema.js"),
      `export const metadata = {
  description: "Bad args schema",
  argsSchema: { type: "object", properties: { topic: "bad" } },
};
export default function workflow() { return { reportMarkdown: "should not run" }; }
`
    );
    const client = createRouterClient(router(), { context: createContext({ enabled: true }) });

    let thrown: unknown;
    try {
      await client.workflows.start({
        workspaceId: "workspace-1",
        name: "bad-args-schema",
        args: { topic: "hello" },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ORPCError);
    expect((thrown as { code?: string }).code).toBe("BAD_REQUEST");
    expect(thrown).toHaveProperty(
      "message",
      "Workflow args property topic must be an object schema"
    );
  });

  test("waits for chat idle before starting slash workflow invocations", async () => {
    const context = createContext({ enabled: true });
    const workspaceService = context.workspaceService as unknown as {
      waitForWorkspaceIdle: ReturnType<typeof mock>;
      prepareManualWorkflowInvocation: ReturnType<typeof mock>;
      appendWorkflowRunInvocation: ReturnType<typeof mock>;
    };
    let releaseIdle: (() => void) | undefined;
    workspaceService.waitForWorkspaceIdle = mock(
      () =>
        new Promise<void>((resolve) => {
          releaseIdle = resolve;
        })
    );
    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir("workspace-1") });
    const client = createRouterClient(router(), { context });

    const startPromise = client.workflows.start({
      workspaceId: "workspace-1",
      name: "demo",
      runInBackground: true,
      args: { topic: "queued until idle" },
      rawCommand: "/demo queued until idle",
    });

    await waitForRouterCondition(
      "slash workflow idle barrier",
      () => workspaceService.waitForWorkspaceIdle.mock.calls.length === 1
    );
    expect(workspaceService.waitForWorkspaceIdle).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({ manualFollowUp: true })
    );
    expect(workspaceService.prepareManualWorkflowInvocation).not.toHaveBeenCalled();
    expect(await runStore.listRuns()).toEqual([]);
    expect(workspaceService.appendWorkflowRunInvocation).not.toHaveBeenCalled();

    releaseIdle?.();
    const result = await startPromise;

    expect(workspaceService.prepareManualWorkflowInvocation).toHaveBeenCalledWith("workspace-1");
    expect(result).toMatchObject({ status: "running", invocationMessagePersisted: true });
    expect(workspaceService.appendWorkflowRunInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        rawCommand: "/demo queued until idle",
        status: "running",
      })
    );
    await waitForRouterWorkflowStatus(client, "workspace-1", result.runId, "completed");
  });

  test("waits for foreground slash invocation persistence before terminal continuation", async () => {
    fs.writeFileSync(
      path.join(projectPath, ".mux", "workflows", "backgroundable.js"),
      "export const metadata = { description: \"Backgroundable workflow\" };\nexport default function workflow({ agent }) { return agent({ id: 'slow-step', prompt: 'slow' }); }\n"
    );
    const context = createContext({ enabled: true });
    const workspaceService = context.workspaceService as unknown as {
      appendWorkflowRunInvocation: ReturnType<typeof mock>;
      isWorkflowInvocationCurrent: ReturnType<typeof mock>;
      sendMessage: ReturnType<typeof mock>;
    };
    let releaseInvocationPersistence: (() => void) | undefined;
    workspaceService.appendWorkflowRunInvocation = mock(async () => {
      await new Promise<void>((resolve) => {
        releaseInvocationPersistence = resolve;
      });
      return true;
    });
    workspaceService.isWorkflowInvocationCurrent = mock(async () => true);
    workspaceService.sendMessage = mock(async () => ({ success: true, data: {} }));

    let waitCalls = 0;
    context.taskService = {
      create: mock(async () => ({ success: true, data: { taskId: "task_slow" } })),
      waitForAgentReport: mock(async () => {
        waitCalls += 1;
        if (waitCalls === 1) {
          throw new ForegroundWaitBackgroundedError();
        }
        return { reportMarkdown: "done" };
      }),
    } as unknown as ORPCContext["taskService"];

    const client = createRouterClient(router(), { context });
    const startPromise = client.workflows.start({
      workspaceId: "workspace-1",
      name: "backgroundable",
      args: { input: "slow" },
      rawCommand: "/backgroundable slow",
      continuationOptions: { model: "test:model", agentId: "exec" },
    });

    await waitForRouterCondition(
      "foreground invocation persistence to start",
      () => workspaceService.appendWorkflowRunInvocation.mock.calls.length === 1
    );
    await waitForRouterCondition(
      "background resume to finish its agent wait",
      () => waitCalls === 2
    );
    expect(workspaceService.sendMessage).not.toHaveBeenCalled();
    releaseInvocationPersistence?.();

    const result = await startPromise;
    expect(result).toMatchObject({ status: "backgrounded", invocationMessagePersisted: true });
    await waitForRouterCondition(
      "workflow terminal continuation to send after invocation persistence",
      () => workspaceService.sendMessage.mock.calls.length === 1
    );
    expect(workspaceService.sendMessage.mock.calls[0]?.[0]).toBe("workspace-1");
    expect(workspaceService.sendMessage.mock.calls[0]?.[1]).toContain("<mux_workflow_result>");
  });

  test("starts a workflow in the background when requested through the API", async () => {
    const context = createContext({ enabled: true });
    const workspaceService = context.workspaceService as unknown as {
      waitForWorkspaceIdle: ReturnType<typeof mock>;
      prepareManualWorkflowInvocation: ReturnType<typeof mock>;
    };
    const client = createRouterClient(router(), { context });

    const result = await client.workflows.start({
      workspaceId: "workspace-1",
      name: "demo",
      runInBackground: true,
      args: { topic: "background workflow routes" },
    });

    expect(workspaceService.prepareManualWorkflowInvocation).not.toHaveBeenCalled();
    expect(workspaceService.waitForWorkspaceIdle).not.toHaveBeenCalled();
    expect(result.status).toBe("running");
    expect(result.runId).toMatch(/^wfr_/);
    expect(result.result).toBeNull();
    await waitForRouterWorkflowStatus(client, "workspace-1", result.runId, "completed");
  });
});

describe("router config.saveConfig", () => {
  let tempDir: string;
  let config: Config;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-router-test-"));
    config = new Config(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createContext(): ORPCContext {
    // saveConfig only touches Config and TaskService, so this partial context keeps the
    // router-level test focused on the config mutation under test.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Other services are not used by saveConfig.
    return {
      config,
      taskService: {
        maybeStartQueuedTasks: () => Promise.resolve(undefined),
      },
    } as ORPCContext;
  }

  test("preserves agent enable flags when a mirrored legacy subagent entry is removed", async () => {
    await config.editConfig((current) => ({
      ...current,
      agentAiDefaults: {
        foo: {
          modelString: "anthropic:claude-3-5-sonnet",
          thinkingLevel: "high",
          enabled: true,
          advisorEnabled: true,
        },
      },
      subagentAiDefaults: {
        foo: {
          modelString: "anthropic:claude-3-5-sonnet",
          thinkingLevel: "high",
        },
      },
    }));

    const client = createRouterClient(router(), { context: createContext() });

    await client.config.saveConfig({
      taskSettings: DEFAULT_TASK_SETTINGS,
      subagentAiDefaults: {},
    });

    const saved = config.loadConfigOrDefault();

    expect(saved.agentAiDefaults?.foo?.modelString).toBeUndefined();
    expect(saved.agentAiDefaults?.foo?.thinkingLevel).toBeUndefined();
    expect(saved.agentAiDefaults?.foo?.enabled).toBe(true);
    expect(saved.agentAiDefaults?.foo?.advisorEnabled).toBe(true);
    expect(saved.subagentAiDefaults?.foo).toBeUndefined();
  });

  test("persists the full-width chat transcript config flag", async () => {
    const client = createRouterClient(router(), { context: createContext() });

    expect((await client.config.getConfig()).chatTranscriptFullWidth).toBe(false);

    await client.config.updateChatTranscriptFullWidth({ enabled: true });

    expect((await client.config.getConfig()).chatTranscriptFullWidth).toBe(true);
    expect(config.loadConfigOrDefault().chatTranscriptFullWidth).toBe(true);

    await client.config.updateChatTranscriptFullWidth({ enabled: false });

    expect((await client.config.getConfig()).chatTranscriptFullWidth).toBe(false);
    expect(config.loadConfigOrDefault().chatTranscriptFullWidth).toBeUndefined();
  });

  test("getConfig and saveConfig round trip user preferences", async () => {
    const client = createRouterClient(router(), { context: createContext() });

    await client.config.saveConfig({
      taskSettings: DEFAULT_TASK_SETTINGS,
      userPreferences: {
        appearance: { theme: "dark" },
        notifications: { notifyOnResponseByWorkspace: { "ws-1": true } },
      },
    });

    expect((await client.config.getConfig()).userPreferencesInitialized).toBe(true);
    expect((await client.config.getConfig()).userPreferences).toEqual({
      appearance: { theme: "dark" },
      notifications: { notifyOnResponseByWorkspace: { "ws-1": true } },
    });
    expect(config.loadConfigOrDefault().userPreferences).toEqual({
      appearance: { theme: "dark" },
      notifications: { notifyOnResponseByWorkspace: { "ws-1": true } },
    });
  });

  test("saveConfig preserves task settings when user preference saves omit them", async () => {
    await config.editConfig((current) => ({
      ...current,
      taskSettings: {
        ...DEFAULT_TASK_SETTINGS,
        maxParallelAgentTasks: 7,
        preserveSubagentsUntilArchive: true,
      },
    }));
    const client = createRouterClient(router(), { context: createContext() });

    await client.config.saveConfig({
      userPreferences: { appearance: { theme: "dark" } },
    });

    expect(config.loadConfigOrDefault().taskSettings).toEqual({
      ...DEFAULT_TASK_SETTINGS,
      maxParallelAgentTasks: 7,
      preserveSubagentsUntilArchive: true,
    });
  });

  test("saveConfig clears user preferences when explicitly set to null", async () => {
    await config.editConfig((current) => ({
      ...current,
      userPreferences: { appearance: { theme: "flexoki-light" } },
    }));
    const client = createRouterClient(router(), { context: createContext() });

    await client.config.saveConfig({
      userPreferences: null,
    });

    expect((await client.config.getConfig()).userPreferencesInitialized).toBe(true);
    expect(config.loadConfigOrDefault().userPreferences).toBeUndefined();
  });

  test("saveConfig preserves existing user preferences when omitted", async () => {
    await config.editConfig((current) => ({
      ...current,
      userPreferences: { appearance: { theme: "flexoki-light" } },
    }));
    const client = createRouterClient(router(), { context: createContext() });

    await client.config.saveConfig({
      taskSettings: DEFAULT_TASK_SETTINGS,
      advisorModelString: null,
    });

    expect(config.loadConfigOrDefault().userPreferences).toEqual({
      appearance: { theme: "flexoki-light" },
    });
  });

  test("preserves optional task settings when a save omits them", async () => {
    await config.editConfig((current) => ({
      ...current,
      taskSettings: {
        ...DEFAULT_TASK_SETTINGS,
        preserveSubagentsUntilArchive: true,
        proposePlanImplementReplacesChatHistory: true,
      },
    }));

    const client = createRouterClient(router(), { context: createContext() });

    await client.config.saveConfig({
      // Simulate an older/unrelated settings client that only sends the originally required
      // task limits. Optional task flags must stay sticky, or the sub-agent preservation toggle
      // silently turns itself off before cleanup evaluates it.
      taskSettings: {
        maxParallelAgentTasks: 4,
        maxTaskNestingDepth: 5,
      },
      advisorModelString: null,
    });

    const saved = config.loadConfigOrDefault();
    const savedTaskSettings = saved.taskSettings;
    if (!savedTaskSettings) {
      throw new Error("Expected saved task settings");
    }

    expect(savedTaskSettings.maxParallelAgentTasks).toBe(4);
    expect(savedTaskSettings.maxTaskNestingDepth).toBe(5);
    expect(savedTaskSettings.preserveSubagentsUntilArchive).toBe(true);
    expect(savedTaskSettings.proposePlanImplementReplacesChatHistory).toBe(true);
  });
});
