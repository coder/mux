import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config } from "@/node/config";
import type { ProjectsConfig, Workspace } from "@/common/types/project";
import type { WorkspaceWorkflowSchedule } from "@/common/types/workspace";
import {
  WorkflowSchedulerService,
  type WorkflowSchedulerOptions,
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

  interface SchedulerSetup {
    enabled?: boolean;
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
      name: "reconcile",
      args: { dryRun: true },
    });
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

    // Stale run still proceeded, but the reset schedule kept its due-now state.
    expect(startWorkflow).toHaveBeenCalledTimes(1);
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
