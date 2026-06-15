import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config } from "@/node/config";
import type { ProjectWorkflowSchedule, ProjectsConfig, Workspace } from "@/common/types/project";
import type { WorkspaceWorkflowSchedule } from "@/common/types/workspace";
import {
  WorkflowSchedulerService,
  type WorkflowProjectScheduleCreateWorkspaceInput,
  type WorkflowSchedulerOptions,
  type WorkflowScheduleCreateWorkspaceInput,
  type WorkflowSchedulePrepareContextInput,
  type WorkflowScheduleStartInput,
} from "./WorkflowSchedulerService";

const WORKSPACE_ID = "sched-ws-1";

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("WorkflowSchedulerService", () => {
  let tempDir: string;
  let config: Config;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-scheduler-test-"));
    config = new Config(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function seedWorkspace(options: {
    schedule?: Partial<WorkspaceWorkflowSchedule>;
    archivedAt?: string;
  }): Promise<void> {
    await config.editConfig((cfg) => {
      cfg.projects.set("/repo", {
        workspaces: [
          {
            path: "/repo/sched",
            id: WORKSPACE_ID,
            name: "sched",
            ...(options.archivedAt != null ? { archivedAt: options.archivedAt } : {}),
            ...(options.schedule != null
              ? {
                  workflowSchedule: {
                    enabled: true,
                    workflowName: "reconcile",
                    intervalMs: 60_000,
                    ...options.schedule,
                  },
                }
              : {}),
          },
        ],
      });
      return cfg;
    });
  }

  function storedSchedule(): WorkspaceWorkflowSchedule | undefined {
    return config.loadConfigOrDefault().projects.get("/repo")?.workspaces.at(0)?.workflowSchedule;
  }

  async function seedProjectSchedule(
    schedule: Partial<ProjectWorkflowSchedule> = {}
  ): Promise<void> {
    await config.editConfig((cfg) => {
      cfg.projects.set("/repo", {
        workspaces: [
          {
            path: "/repo/control",
            id: WORKSPACE_ID,
            name: "control",
          },
        ],
        workflowSchedules: [
          {
            id: "automation-1",
            enabled: true,
            workflowName: "reconcile",
            intervalMs: 60_000,
            target: { type: "new-workspace", branchName: "scheduled-triage", trunkBranch: "main" },
            ...schedule,
          },
        ],
      });
      return cfg;
    });
  }

  function storedProjectSchedule(): ProjectWorkflowSchedule | undefined {
    return config.loadConfigOrDefault().projects.get("/repo")?.workflowSchedules?.at(0);
  }

  interface SchedulerSetup {
    enabled?: boolean;
    createWorkspaceForSchedule?: WorkflowSchedulerOptions["createWorkspaceForSchedule"];
    createWorkspaceForProjectSchedule?: WorkflowSchedulerOptions["createWorkspaceForProjectSchedule"];
    prepareContext?: WorkflowSchedulerOptions["prepareContext"];
    cleanupWorkspaceForSchedule?: WorkflowSchedulerOptions["cleanupWorkspaceForSchedule"];
    onScheduleStamped?: WorkflowSchedulerOptions["onScheduleStamped"];
    startWorkflow?: (
      input: WorkflowScheduleStartInput
    ) => Promise<{ runId: string; status: string }>;
  }

  function makeScheduler(options: SchedulerSetup = {}) {
    const startWorkflow = mock(
      options.startWorkflow ?? (() => Promise.resolve({ runId: "run-1", status: "completed" }))
    );
    const scheduler = new WorkflowSchedulerService({
      config,
      isEnabled: () => options.enabled ?? true,
      ...(options.createWorkspaceForSchedule != null
        ? { createWorkspaceForSchedule: options.createWorkspaceForSchedule }
        : {}),
      ...(options.createWorkspaceForProjectSchedule != null
        ? { createWorkspaceForProjectSchedule: options.createWorkspaceForProjectSchedule }
        : {}),
      ...(options.prepareContext != null ? { prepareContext: options.prepareContext } : {}),
      ...(options.cleanupWorkspaceForSchedule != null
        ? { cleanupWorkspaceForSchedule: options.cleanupWorkspaceForSchedule }
        : {}),
      ...(options.onScheduleStamped != null
        ? { onScheduleStamped: options.onScheduleStamped }
        : {}),
      startWorkflow,
      checkIntervalMs: 50,
    });
    return { scheduler, startWorkflow };
  }

  test("dispatches a never-run schedule immediately and persists lastRunStartedAt", async () => {
    await seedWorkspace({ schedule: { args: { dryRun: true } } });
    const { scheduler, startWorkflow } = makeScheduler();

    scheduler.tick();
    await scheduler.awaitActiveDispatches();

    expect(startWorkflow).toHaveBeenCalledTimes(1);
    expect(startWorkflow.mock.calls[0]?.[0]).toEqual({
      workspaceId: WORKSPACE_ID,
      sourceWorkspaceId: WORKSPACE_ID,
      name: "reconcile",
      args: { dryRun: true },
    });
    expect(storedSchedule()?.lastRunStartedAt).toBeDefined();
  });

  test("creates a fresh target workspace before running new-workspace schedules", async () => {
    await seedWorkspace({
      schedule: {
        target: {
          type: "new-workspace",
          branchName: "scheduled-triage",
          trunkBranch: "main",
          title: "Scheduled triage",
        },
      },
    });
    const createWorkspaceForSchedule = mock((_input: WorkflowScheduleCreateWorkspaceInput) =>
      Promise.resolve({ workspaceId: "target-ws-1" })
    );
    const { scheduler, startWorkflow } = makeScheduler({ createWorkspaceForSchedule });

    scheduler.tick();
    await scheduler.awaitActiveDispatches();

    expect(createWorkspaceForSchedule).toHaveBeenCalledTimes(1);
    expect(createWorkspaceForSchedule.mock.calls[0]?.[0]).toMatchObject({
      sourceWorkspaceId: WORKSPACE_ID,
      sourceProjectPath: "/repo",
      workflowName: "reconcile",
      target: {
        type: "new-workspace",
        branchName: "scheduled-triage",
        trunkBranch: "main",
        title: "Scheduled triage",
      },
    });
    expect(startWorkflow).toHaveBeenCalledWith({
      workspaceId: "target-ws-1",
      sourceWorkspaceId: WORKSPACE_ID,
      name: "reconcile",
      args: {},
    });
  });

  test("creates a fresh workspace for due project automation schedules", async () => {
    await seedProjectSchedule({ args: { label: "needs-triage" } });
    const createWorkspaceForProjectSchedule = mock(
      (_input: WorkflowProjectScheduleCreateWorkspaceInput) =>
        Promise.resolve({ workspaceId: "project-target-ws-1" })
    );
    const { scheduler, startWorkflow } = makeScheduler({ createWorkspaceForProjectSchedule });

    scheduler.tick();
    await scheduler.awaitActiveDispatches();

    expect(createWorkspaceForProjectSchedule).toHaveBeenCalledTimes(1);
    expect(createWorkspaceForProjectSchedule.mock.calls[0]?.[0]).toMatchObject({
      sourceProjectPath: "/repo",
      workflowName: "reconcile",
      scheduleId: "automation-1",
      target: {
        type: "new-workspace",
        branchName: "scheduled-triage",
        trunkBranch: "main",
      },
    });
    expect(startWorkflow).toHaveBeenCalledWith({
      workspaceId: "project-target-ws-1",
      sourceWorkspaceId: "project-target-ws-1",
      sourceProjectPath: "/repo",
      projectScheduleId: "automation-1",
      name: "reconcile",
      args: { label: "needs-triage" },
    });
    expect(storedProjectSchedule()?.lastRunStartedAt).toBeDefined();
  });

  test("runs project automation on demand without waiting for the interval", async () => {
    await seedProjectSchedule({
      lastRunStartedAt: "2026-01-01T00:00:00.000Z",
      target: { type: "existing-workspace", workspaceId: WORKSPACE_ID },
    });
    let releaseRun!: () => void;
    const running = new Promise<{ runId: string; status: string }>((resolve) => {
      releaseRun = () => resolve({ runId: "run-now-1", status: "backgrounded" });
    });
    const { scheduler, startWorkflow } = makeScheduler({ startWorkflow: () => running });

    const resultPromise = scheduler.runProjectScheduleNow({
      projectPath: "/repo",
      scheduleId: "automation-1",
    });
    await waitFor(() => startWorkflow.mock.calls.length === 1);

    const startInput = startWorkflow.mock.calls[0]?.[0];
    expect(startInput).toMatchObject({
      workspaceId: WORKSPACE_ID,
      sourceWorkspaceId: WORKSPACE_ID,
      sourceProjectPath: "/repo",
      projectScheduleId: "automation-1",
      name: "reconcile",
      args: {},
      backgroundOnMessageQueued: true,
    });
    expect(typeof startInput?.onTerminal).toBe("function");
    let duplicateError: unknown;
    try {
      await scheduler.runProjectScheduleNow({ projectPath: "/repo", scheduleId: "automation-1" });
    } catch (error) {
      duplicateError = error;
    }
    expect(duplicateError).toBeInstanceOf(Error);
    expect((duplicateError as Error).message).toMatch(/already starting or running/);

    releaseRun();
    const result = await resultPromise;
    expect(result).toEqual({ runId: "run-now-1", status: "backgrounded" });

    duplicateError = undefined;
    try {
      await scheduler.runProjectScheduleNow({ projectPath: "/repo", scheduleId: "automation-1" });
    } catch (error) {
      duplicateError = error;
    }
    expect(duplicateError).toBeInstanceOf(Error);
    expect((duplicateError as Error).message).toMatch(/already starting or running/);

    const terminalRun: Parameters<NonNullable<WorkflowScheduleStartInput["onTerminal"]>>[0]["run"] =
      {
        id: "run-now-1",
        workspaceId: WORKSPACE_ID,
        definition: {
          name: "reconcile",
          description: "Reconcile",
          scope: "project",
          sourcePath: "/repo/.mux/workflows/reconcile.js",
          executable: true,
        },
        definitionSource: "export default function workflow() {}",
        definitionHash: "hash",
        args: {},
        status: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        events: [],
        steps: [],
      };
    const terminalEvent: Parameters<NonNullable<WorkflowScheduleStartInput["onTerminal"]>>[0] = {
      runId: "run-now-1",
      status: "completed",
      result: null,
      run: terminalRun,
    };
    await startInput?.onTerminal?.(terminalEvent);
    await scheduler.awaitActiveDispatches();
    expect(storedProjectSchedule()?.lastRunStartedAt).not.toBe("2026-01-01T00:00:00.000Z");
  });

  test("releases manual project automation lock on interrupted background runs", async () => {
    await seedProjectSchedule({
      target: { type: "existing-workspace", workspaceId: WORKSPACE_ID },
    });
    let terminalCallback: WorkflowScheduleStartInput["onTerminal"] | undefined;
    const { scheduler, startWorkflow } = makeScheduler({
      startWorkflow: (input) => {
        terminalCallback = input.onTerminal;
        return Promise.resolve({ runId: "run-now-interrupted", status: "backgrounded" });
      },
    });

    const result = await scheduler.runProjectScheduleNow({
      projectPath: "/repo",
      scheduleId: "automation-1",
    });
    expect(result).toEqual({ runId: "run-now-interrupted", status: "backgrounded" });
    let duplicateError: unknown;
    try {
      await scheduler.runProjectScheduleNow({ projectPath: "/repo", scheduleId: "automation-1" });
    } catch (error) {
      duplicateError = error;
    }
    expect(duplicateError).toBeInstanceOf(Error);
    expect((duplicateError as Error).message).toMatch(/already starting or running/);

    const interruptedRun: Parameters<
      NonNullable<WorkflowScheduleStartInput["onTerminal"]>
    >[0]["run"] = {
      id: "run-now-interrupted",
      workspaceId: WORKSPACE_ID,
      definition: {
        name: "reconcile",
        description: "Reconcile",
        scope: "project",
        sourcePath: "/repo/.mux/workflows/reconcile.js",
        executable: true,
      },
      definitionSource: "export default function workflow() {}",
      definitionHash: "hash",
      args: {},
      status: "interrupted",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      events: [],
      steps: [],
    };
    await Promise.resolve(
      terminalCallback?.({
        runId: "run-now-interrupted",
        status: "interrupted",
        result: null,
        run: interruptedRun,
      })
    );
    await scheduler.awaitActiveDispatches();

    const secondResult = await scheduler.runProjectScheduleNow({
      projectPath: "/repo",
      scheduleId: "automation-1",
    });
    expect(secondResult).toEqual({ runId: "run-now-interrupted", status: "backgrounded" });
    expect(startWorkflow).toHaveBeenCalledTimes(2);
  });

  test("runs project automation schedules in an existing workspace target", async () => {
    await seedProjectSchedule({
      target: { type: "existing-workspace", workspaceId: WORKSPACE_ID },
    });
    const { scheduler, startWorkflow } = makeScheduler();

    scheduler.tick();
    await scheduler.awaitActiveDispatches();

    expect(startWorkflow).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      sourceWorkspaceId: WORKSPACE_ID,
      sourceProjectPath: "/repo",
      projectScheduleId: "automation-1",
      name: "reconcile",
      args: {},
    });
  });

  test("runs sub-project automation schedules in an owner workspace target", async () => {
    const subProjectPath = "/repo/packages/api";
    await config.editConfig((cfg) => {
      cfg.projects.set("/repo", {
        workspaces: [
          {
            path: "/repo/control",
            id: WORKSPACE_ID,
            name: "control",
            subProjectPath,
          },
        ],
      });
      cfg.projects.set(subProjectPath, {
        parentProjectPath: "/repo",
        workspaces: [],
        workflowSchedules: [
          {
            id: "subproject-automation",
            enabled: true,
            workflowName: "reconcile-api",
            intervalMs: 60_000,
            target: { type: "existing-workspace", workspaceId: WORKSPACE_ID },
          },
        ],
      });
      return cfg;
    });
    const { scheduler, startWorkflow } = makeScheduler();

    scheduler.tick();
    await scheduler.awaitActiveDispatches();

    expect(startWorkflow).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      sourceWorkspaceId: WORKSPACE_ID,
      sourceProjectPath: subProjectPath,
      projectScheduleId: "subproject-automation",
      name: "reconcile-api",
      args: {},
    });
  });

  test("skips archived existing-workspace project targets without stamping", async () => {
    const previousLastRun = "2026-01-01T00:00:00.000Z";
    await seedProjectSchedule({
      lastRunStartedAt: previousLastRun,
      target: { type: "existing-workspace", workspaceId: WORKSPACE_ID },
    });
    await config.editConfig((cfg) => {
      const workspace = cfg.projects.get("/repo")?.workspaces.at(0);
      if (workspace == null) throw new Error("Expected seeded workspace");
      workspace.archivedAt = "2026-01-02T00:00:00.000Z";
      return cfg;
    });
    const { scheduler, startWorkflow } = makeScheduler();

    scheduler.tick();
    await scheduler.awaitActiveDispatches();

    expect(startWorkflow).not.toHaveBeenCalled();
    expect(storedProjectSchedule()?.lastRunStartedAt).toBe(previousLastRun);
  });

  test("skips missing existing-workspace project targets without stamping", async () => {
    const previousLastRun = "2026-01-01T00:00:00.000Z";
    await seedProjectSchedule({
      lastRunStartedAt: previousLastRun,
      target: { type: "existing-workspace", workspaceId: "deleted-workspace" },
    });
    const { scheduler, startWorkflow } = makeScheduler();

    scheduler.tick();
    await scheduler.awaitActiveDispatches();

    expect(startWorkflow).not.toHaveBeenCalled();
    expect(storedProjectSchedule()?.lastRunStartedAt).toBe(previousLastRun);
  });

  test("prepares context only for existing-workspace project automation targets", async () => {
    await seedProjectSchedule({
      contextMode: "reset",
      target: { type: "existing-workspace", workspaceId: WORKSPACE_ID },
    });
    const prepareContext = mock((_input: WorkflowSchedulePrepareContextInput) => Promise.resolve());
    const { scheduler } = makeScheduler({ prepareContext });

    scheduler.tick();
    await scheduler.awaitActiveDispatches();

    expect(prepareContext).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      sourceWorkspaceId: WORKSPACE_ID,
      contextMode: "reset",
    });

    await seedProjectSchedule({ contextMode: "compact" });
    const createWorkspaceForProjectSchedule = mock(
      (_input: WorkflowProjectScheduleCreateWorkspaceInput) =>
        Promise.resolve({ workspaceId: "project-target-ws-1" })
    );
    const freshPrepareContext = mock((_input: WorkflowSchedulePrepareContextInput) =>
      Promise.resolve()
    );
    const fresh = makeScheduler({
      createWorkspaceForProjectSchedule,
      prepareContext: freshPrepareContext,
    });

    fresh.scheduler.tick();
    await fresh.scheduler.awaitActiveDispatches();

    expect(freshPrepareContext).not.toHaveBeenCalled();
    expect(fresh.startWorkflow).toHaveBeenCalledTimes(1);
  });

  test("cleans up a fresh target workspace when pre-start work fails", async () => {
    await seedWorkspace({
      schedule: {
        target: { type: "new-workspace", branchName: "scheduled-triage", trunkBranch: "main" },
      },
    });
    const cleanupWorkspaceForSchedule = mock(
      (
        _input: Parameters<NonNullable<WorkflowSchedulerOptions["cleanupWorkspaceForSchedule"]>>[0]
      ) => Promise.resolve()
    );
    const { scheduler, startWorkflow } = makeScheduler({
      createWorkspaceForSchedule: () => Promise.resolve({ workspaceId: "target-ws-1" }),
      cleanupWorkspaceForSchedule,
      startWorkflow: () => Promise.reject(new Error("workflow missing")),
    });

    scheduler.tick();
    await scheduler.awaitActiveDispatches();

    expect(startWorkflow).toHaveBeenCalledTimes(1);
    expect(cleanupWorkspaceForSchedule).toHaveBeenCalledTimes(1);
    expect(cleanupWorkspaceForSchedule.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: "target-ws-1",
      sourceWorkspaceId: WORKSPACE_ID,
      workflowName: "reconcile",
      error: "workflow missing",
    });
    expect(typeof cleanupWorkspaceForSchedule.mock.calls[0]?.[0]?.startedAt).toBe("string");
  });

  test("emits metadata after stamping lastRunStartedAt", async () => {
    await seedWorkspace({ schedule: {} });
    const onScheduleStamped = mock(
      (_input: Parameters<NonNullable<WorkflowSchedulerOptions["onScheduleStamped"]>>[0]) =>
        Promise.resolve()
    );
    const { scheduler } = makeScheduler({ onScheduleStamped });

    scheduler.tick();
    await scheduler.awaitActiveDispatches();

    expect(onScheduleStamped).toHaveBeenCalledTimes(1);
    expect(onScheduleStamped.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      workflowName: "reconcile",
    });
    expect(typeof onScheduleStamped.mock.calls[0]?.[0]?.startedAt).toBe("string");
  });

  test("skips malformed persisted schedules", async () => {
    const malformedSchedule: WorkspaceWorkflowSchedule = {
      enabled: true,
      workflowName: "reconcile",
      intervalMs: 0,
    };
    await config.editConfig((cfg) => {
      cfg.projects.set("/repo", {
        workspaces: [
          {
            path: "/repo/sched",
            id: WORKSPACE_ID,
            name: "sched",
            workflowSchedule: malformedSchedule,
          },
        ],
      });
      return cfg;
    });
    const { scheduler, startWorkflow } = makeScheduler();

    scheduler.tick();
    await scheduler.awaitActiveDispatches();

    expect(startWorkflow).not.toHaveBeenCalled();
  });

  test("prepares scheduled workflow context before starting", async () => {
    await seedWorkspace({ schedule: { contextMode: "reset" } });
    const events: string[] = [];
    const prepareContext = mock((input: WorkflowSchedulePrepareContextInput) => {
      events.push(`prepare:${input.workspaceId}:${input.contextMode}`);
      return Promise.resolve();
    });
    const { scheduler, startWorkflow } = makeScheduler({
      prepareContext,
      startWorkflow: (input) => {
        events.push(`start:${input.workspaceId}`);
        return Promise.resolve({ runId: "run-1", status: "completed" });
      },
    });

    scheduler.tick();
    await scheduler.awaitActiveDispatches();

    expect(prepareContext).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      sourceWorkspaceId: WORKSPACE_ID,
      contextMode: "reset",
    });
    expect(startWorkflow).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["prepare:sched-ws-1:reset", "start:sched-ws-1"]);
  });

  test("does not start the workflow when context preparation fails", async () => {
    await seedWorkspace({ schedule: { contextMode: "compact" } });
    const prepareContext = mock(() => Promise.reject(new Error("compaction failed")));
    const { scheduler, startWorkflow } = makeScheduler({ prepareContext });

    scheduler.tick();
    await scheduler.awaitActiveDispatches();

    expect(prepareContext).toHaveBeenCalledTimes(1);
    expect(startWorkflow).not.toHaveBeenCalled();
    expect(storedSchedule()?.lastRunStartedAt).toBeDefined();
  });

  test("wall-clock due check: skips fresh lastRunStartedAt, fires when overdue", async () => {
    await seedWorkspace({ schedule: { lastRunStartedAt: new Date().toISOString() } });
    const { scheduler, startWorkflow } = makeScheduler();

    scheduler.tick();
    await scheduler.awaitActiveDispatches();
    expect(startWorkflow).not.toHaveBeenCalled();

    // Simulate a restart long after the last run (at-least-once: overdue
    // schedules collapse into one dispatch on the next tick).
    await seedWorkspace({
      schedule: { lastRunStartedAt: new Date(Date.now() - 10 * 60_000).toISOString() },
    });
    const restarted = makeScheduler();
    restarted.scheduler.tick();
    await restarted.scheduler.awaitActiveDispatches();
    expect(restarted.startWorkflow).toHaveBeenCalledTimes(1);
  });

  test("skip-if-running: an active run blocks re-dispatch until it settles", async () => {
    await seedWorkspace({ schedule: {} });
    let releaseRun!: () => void;
    const running = new Promise<{ runId: string; status: string }>((resolve) => {
      releaseRun = () => resolve({ runId: "run-1", status: "completed" });
    });
    const { scheduler, startWorkflow } = makeScheduler({ startWorkflow: () => running });

    scheduler.tick();
    // Dispatch persists lastRunStartedAt before invoking startWorkflow; wait
    // for the invocation instead of racing it.
    await waitFor(() => startWorkflow.mock.calls.length === 1);
    scheduler.tick();
    expect(startWorkflow).toHaveBeenCalledTimes(1);

    releaseRun();
    await scheduler.awaitActiveDispatches();

    // Next interval: clear lastRunStartedAt to make it due again.
    await seedWorkspace({ schedule: {} });
    scheduler.tick();
    await scheduler.awaitActiveDispatches();
    expect(startWorkflow).toHaveBeenCalledTimes(2);
  });

  test("skips disabled schedules, archived workspaces, and disabled experiment", async () => {
    await seedWorkspace({ schedule: { enabled: false } });
    const disabled = makeScheduler();
    disabled.scheduler.tick();
    expect(disabled.startWorkflow).not.toHaveBeenCalled();

    await seedWorkspace({ schedule: {}, archivedAt: new Date().toISOString() });
    const archived = makeScheduler();
    archived.scheduler.tick();
    expect(archived.startWorkflow).not.toHaveBeenCalled();

    await seedWorkspace({ schedule: {} });
    const gated = makeScheduler({ enabled: false });
    gated.scheduler.tick();
    expect(gated.startWorkflow).not.toHaveBeenCalled();
  });

  test("a stale dispatch does not stamp lastRunStartedAt onto a freshly reset schedule", async () => {
    // Race: setWorkflowSchedule replaces the schedule between the tick's
    // config read and the dispatch's stamp write. The reset schedule is
    // documented to be immediately due — the stale dispatch must not delay it.
    const original: WorkspaceWorkflowSchedule = {
      enabled: true,
      workflowName: "reconcile",
      intervalMs: 60_000,
    };
    const replacement: WorkspaceWorkflowSchedule = {
      enabled: true,
      workflowName: "reconcile-v2",
      intervalMs: 120_000,
    };
    let workspace: Workspace = { path: "/repo/sched", id: WORKSPACE_ID, name: "sched" };
    workspace.workflowSchedule = { ...original };
    let projects: ProjectsConfig = { projects: new Map([["/repo", { workspaces: [workspace] }]]) };

    // editConfig defers its callback behind a gate so the test can swap the
    // schedule in the dispatch's persist window.
    let releaseEdit!: () => void;
    const editGate = new Promise<void>((resolve) => {
      releaseEdit = resolve;
    });
    const fakeConfig: WorkflowSchedulerOptions["config"] = {
      loadConfigOrDefault: () => projects,
      editConfig: async (fn) => {
        await editGate;
        projects = fn(projects);
      },
    };
    const startWorkflow = mock(() => Promise.resolve({ runId: "run-1", status: "completed" }));
    const scheduler = new WorkflowSchedulerService({
      config: fakeConfig,
      isEnabled: () => true,
      startWorkflow,
      checkIntervalMs: 50,
    });

    scheduler.tick(); // observes `original`, blocks on the edit gate
    workspace = { ...workspace, workflowSchedule: { ...replacement } }; // user reset mid-dispatch
    projects = { projects: new Map([["/repo", { workspaces: [workspace] }]]) };
    releaseEdit();
    await scheduler.awaitActiveDispatches();

    // The stale run is canceled, and the reset schedule keeps its due-now state.
    expect(startWorkflow).not.toHaveBeenCalled();
    const persisted = projects.projects.get("/repo")?.workspaces.at(0)?.workflowSchedule;
    expect(persisted?.workflowName).toBe("reconcile-v2");
    expect(persisted?.lastRunStartedAt).toBeUndefined();
  });

  test("a failing run is contained and retried only after the next interval", async () => {
    await seedWorkspace({ schedule: {} });
    const { scheduler, startWorkflow } = makeScheduler({
      startWorkflow: () => Promise.reject(new Error("boom")),
    });

    scheduler.tick();
    await scheduler.awaitActiveDispatches();
    expect(startWorkflow).toHaveBeenCalledTimes(1);
    // lastRunStartedAt advanced before the failure: an immediate tick must
    // NOT hot-loop the broken workflow.
    scheduler.tick();
    await scheduler.awaitActiveDispatches();
    expect(startWorkflow).toHaveBeenCalledTimes(1);
  });
});
