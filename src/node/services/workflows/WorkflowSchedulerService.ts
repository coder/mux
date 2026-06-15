/**
 * WorkflowSchedulerService — wall-clock dispatcher for per-workspace scheduled
 * workflow runs (`workspace.workflowSchedule` in config).
 *
 * Semantics (deliberately different from HeartbeatService, which is
 * idle-recency gated, needs a completed chat turn, and competes for
 * IdleDispatcher slots — all unsuitable for reconciliation loops):
 * - Wall-clock: a schedule is due when `intervalMs` has elapsed since
 *   `lastRunStartedAt`, regardless of workspace activity.
 * - At-least-once: a schedule with no `lastRunStartedAt` (or an overdue one)
 *   fires on the first tick after startup; missed intervals while the app was
 *   closed collapse into one run.
 * - Skip-if-running: while a dispatched run is still active in this process,
 *   the schedule is not re-dispatched. (Crash-orphaned runs from a previous
 *   process are not tracked; the next due tick starts a fresh run and the
 *   orphan stays resumable via workflow_resume.)
 *
 * `lastRunStartedAt` is persisted BEFORE the run starts so a crash mid-run
 * retries at most once per interval instead of hot-looping on startup.
 *
 * Everything is derived from config on each tick — no separate schedule
 * ledger. Deleting/archiving a workspace or disabling the schedule takes
 * effect on the next tick.
 */

import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { isWorkspaceArchived } from "@/common/utils/archive";
import {
  isWorkflowScheduleDue,
  parsePersistedProjectWorkflowSchedule,
  parsePersistedWorkflowSchedule,
} from "@/common/utils/workflowSchedule";
import type { ProjectConfig, ProjectWorkflowSchedule, Workspace } from "@/common/types/project";
import type { WorkspaceWorkflowSchedule } from "@/common/types/workspace";
import type { WorkflowBackgroundRunTerminalEvent } from "@/node/services/workflows/WorkflowService";
import type { Config } from "@/node/config";
import { log } from "@/node/services/log";
import {
  WORKFLOW_SCHEDULE_CHECK_INTERVAL_MS,
  WORKFLOW_SCHEDULE_DEFAULT_CONTEXT_MODE,
  type WorkflowScheduleContextMode,
} from "@/constants/workflowSchedule";

type WorkflowScheduleTarget = NonNullable<WorkspaceWorkflowSchedule["target"]>;
type WorkflowScheduleNewWorkspaceTarget = Extract<
  WorkflowScheduleTarget,
  { type: "new-workspace" }
>;

type ProjectScheduleTarget = ProjectWorkflowSchedule["target"];
type ProjectScheduleNewWorkspaceTarget = Extract<ProjectScheduleTarget, { type: "new-workspace" }>;

export interface WorkflowScheduleStartInput {
  workspaceId: string;
  sourceWorkspaceId: string;
  sourceProjectPath?: string;
  projectScheduleId?: string;
  name: string;
  args: Record<string, unknown>;
  /** When true, return after the workflow is safely backgrounded instead of waiting for terminal status. */
  backgroundOnMessageQueued?: boolean;
  /** Called when a backgrounded scheduled run reaches a terminal status. */
  onTerminal?: (event: WorkflowBackgroundRunTerminalEvent) => void | Promise<void>;
}

export interface WorkflowScheduleCreateWorkspaceInput {
  sourceWorkspaceId: string;
  sourceProjectPath: string;
  sourceWorkspace: Workspace;
  target: WorkflowScheduleNewWorkspaceTarget;
  workflowName: string;
  startedAt: string;
}

export interface WorkflowProjectScheduleCreateWorkspaceInput {
  sourceProjectPath: string;
  sourceProject: ProjectConfig;
  target: ProjectScheduleNewWorkspaceTarget;
  workflowName: string;
  scheduleId: string;
  startedAt: string;
}

export interface WorkflowSchedulePrepareContextInput {
  workspaceId: string;
  sourceWorkspaceId: string;
  contextMode: WorkflowScheduleContextMode;
}

export interface WorkflowScheduleCleanupWorkspaceInput {
  workspaceId: string;
  sourceWorkspaceId: string;
  sourceProjectPath?: string;
  projectScheduleId?: string;
  workflowName: string;
  startedAt: string;
  error: string;
}

export type WorkflowScheduleStampedInput =
  | {
      type: "workspace";
      workspaceId: string;
      workflowName: string;
      startedAt: string;
    }
  | {
      type: "project";
      projectPath: string;
      scheduleId: string;
      workflowName: string;
      startedAt: string;
    };

interface ProjectScheduleDispatchOptions {
  backgroundOnMessageQueued?: boolean;
  rethrowErrors?: boolean;
  onTerminal?: (event: WorkflowBackgroundRunTerminalEvent) => void | Promise<void>;
}

export interface WorkflowSchedulerOptions {
  config: Pick<Config, "loadConfigOrDefault" | "editConfig">;
  /** Gate (dynamic-workflows experiment); schedules are skipped while false. */
  isEnabled: () => boolean;
  /** Create a fresh run workspace for schedules that target a new workspace. */
  createWorkspaceForSchedule?: (
    input: WorkflowScheduleCreateWorkspaceInput
  ) => Promise<{ workspaceId: string }>;
  /** Create a fresh run workspace for project automations that target a new workspace. */
  createWorkspaceForProjectSchedule?: (
    input: WorkflowProjectScheduleCreateWorkspaceInput
  ) => Promise<{ workspaceId: string }>;
  /** Prepare target workspace context before starting the workflow. */
  prepareContext?: (input: WorkflowSchedulePrepareContextInput) => Promise<void>;
  /** Best-effort cleanup for a fresh target workspace when pre-start work throws. */
  cleanupWorkspaceForSchedule?: (input: WorkflowScheduleCleanupWorkspaceInput) => Promise<void>;
  /** Best-effort notification after scheduler-owned lastRunStartedAt is persisted. */
  onScheduleStamped?: (input: WorkflowScheduleStampedInput) => Promise<void>;
  /** Start a named workflow run; resolves when the run reaches a terminal status. */
  startWorkflow: (input: WorkflowScheduleStartInput) => Promise<{ runId: string; status: string }>;
  /** Test hook: scan cadence (default 30s). */
  checkIntervalMs?: number;
}

export class WorkflowSchedulerService {
  private readonly options: WorkflowSchedulerOptions;
  private readonly checkIntervalMs: number;
  private checkInterval: NodeJS.Timeout | null = null;
  private stopped = false;
  /** dispatch key → in-flight dispatch (skip-if-running + test synchronization). */
  private readonly activeDispatches = new Map<string, Promise<void>>();

  constructor(options: WorkflowSchedulerOptions) {
    this.checkIntervalMs = options.checkIntervalMs ?? WORKFLOW_SCHEDULE_CHECK_INTERVAL_MS;
    assert(this.checkIntervalMs > 0, "WorkflowSchedulerService: checkIntervalMs must be positive");
    this.options = options;
  }

  start(): void {
    assert(this.checkInterval == null, "WorkflowSchedulerService already started");
    this.stopped = false;
    // First tick immediately: overdue schedules (app was closed) fire on startup.
    this.tick();
    this.checkInterval = setInterval(() => {
      this.tick();
    }, this.checkIntervalMs);
    log.info("WorkflowSchedulerService started", { checkIntervalMs: this.checkIntervalMs });
  }

  stop(): void {
    this.stopped = true;
    if (this.checkInterval != null) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Scan config and dispatch every due schedule. Dispatches run concurrently
   * (one per workspace) and outlive the tick; ticks themselves never block on
   * workflow completion (synchronize via awaitActiveDispatches). Public for
   * tests; never throws (startup safety).
   */
  tick(): void {
    try {
      if (this.stopped || !this.options.isEnabled()) {
        return;
      }
      const config = this.options.config.loadConfigOrDefault();
      const now = Date.now();
      for (const [sourceProjectPath, projectConfig] of config.projects) {
        for (const rawSchedule of projectConfig.workflowSchedules ?? []) {
          const schedule = parsePersistedProjectWorkflowSchedule(rawSchedule);
          if (rawSchedule != null && schedule == null) {
            log.warn("Skipping malformed persisted project workflow schedule", {
              sourceProjectPath,
            });
          }
          if (schedule?.enabled !== true) {
            continue;
          }
          const dispatchKey = getProjectScheduleDispatchKey(sourceProjectPath, schedule.id);
          if (this.activeDispatches.has(dispatchKey)) {
            continue; // skip-if-running
          }
          if (!isWorkflowScheduleDue(schedule, now)) {
            continue; // not due yet
          }
          const dispatch = this.dispatchProjectSchedule(sourceProjectPath, projectConfig, schedule)
            .then(() => undefined)
            .finally(() => {
              this.activeDispatches.delete(dispatchKey);
            });
          this.activeDispatches.set(dispatchKey, dispatch);
        }

        for (const workspace of projectConfig.workspaces) {
          const workspaceId = workspace.id;
          const schedule = parsePersistedWorkflowSchedule(workspace.workflowSchedule);
          if (workspace.workflowSchedule != null && schedule == null) {
            log.warn("Skipping malformed persisted workflow schedule", { workspaceId });
          }
          if (schedule?.enabled !== true || workspaceId == null) {
            continue;
          }
          if (isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)) {
            continue;
          }
          const dispatchKey = getWorkspaceScheduleDispatchKey(workspaceId);
          if (this.activeDispatches.has(dispatchKey)) {
            continue; // skip-if-running
          }
          if (!isWorkflowScheduleDue(schedule, now)) {
            continue; // not due yet
          }
          const dispatch = this.dispatch(sourceProjectPath, workspace, schedule).finally(() => {
            this.activeDispatches.delete(dispatchKey);
          });
          this.activeDispatches.set(dispatchKey, dispatch);
        }
      }
    } catch (error) {
      log.error("WorkflowSchedulerService tick failed", { error: getErrorMessage(error) });
    }
  }

  async runProjectScheduleNow(input: {
    projectPath: string;
    scheduleId: string;
  }): Promise<{ runId: string; status: string }> {
    const projectPath = input.projectPath.trim();
    const scheduleId = input.scheduleId.trim();
    assert(
      projectPath.length > 0,
      "WorkflowSchedulerService.runProjectScheduleNow requires projectPath"
    );
    assert(
      scheduleId.length > 0,
      "WorkflowSchedulerService.runProjectScheduleNow requires scheduleId"
    );
    if (!this.options.isEnabled()) {
      throw new Error("Dynamic workflows are disabled");
    }

    const config = this.options.config.loadConfigOrDefault();
    const sourceProject = config.projects.get(projectPath);
    if (sourceProject == null) {
      throw new Error(`Project not found: ${projectPath}`);
    }

    const rawSchedule = (sourceProject.workflowSchedules ?? []).find(
      (schedule) => schedule.id === scheduleId
    );
    const schedule = parsePersistedProjectWorkflowSchedule(rawSchedule);
    if (rawSchedule != null && schedule == null) {
      throw new Error("Project automation schedule is malformed");
    }
    if (schedule == null) {
      throw new Error("Project automation schedule not found");
    }
    if (!schedule.enabled) {
      throw new Error("Project automation is disabled");
    }

    const dispatchKey = getProjectScheduleDispatchKey(projectPath, schedule.id);
    if (this.activeDispatches.has(dispatchKey)) {
      throw new Error("Project automation is already starting or running");
    }

    let resolveTerminalRun: (() => void) | null = null;
    const terminalRun = new Promise<void>((resolve) => {
      resolveTerminalRun = resolve;
    });
    const dispatch = this.dispatchProjectSchedule(projectPath, sourceProject, schedule, {
      backgroundOnMessageQueued: true,
      rethrowErrors: true,
      onTerminal: () => {
        assert(resolveTerminalRun != null, "Manual project automation terminal resolver missing");
        resolveTerminalRun();
      },
    });
    const trackedDispatch = (async () => {
      try {
        const result = await dispatch;
        if (result?.status === "backgrounded") {
          await terminalRun;
        }
      } catch {
        // The caller receives the original dispatch error; this tracked promise only owns cleanup.
      } finally {
        this.activeDispatches.delete(dispatchKey);
      }
    })();
    this.activeDispatches.set(dispatchKey, trackedDispatch);

    const result = await dispatch;
    assert(result != null, "Manual project automation dispatch must return a workflow run result");
    return result;
  }

  /** Test hook: resolves when all currently in-flight dispatches settle. */
  async awaitActiveDispatches(): Promise<void> {
    await Promise.all(this.activeDispatches.values());
  }

  private async dispatch(
    sourceProjectPath: string,
    sourceWorkspace: Workspace,
    schedule: WorkspaceWorkflowSchedule
  ): Promise<void> {
    const sourceWorkspaceId = sourceWorkspace.id;
    assert(sourceWorkspaceId != null, "Scheduled workflow dispatch requires a source workspace id");
    let startedAt = "";
    let targetWorkspaceId = sourceWorkspaceId;
    let createdFreshTarget = false;

    try {
      // Persist the dispatch time BEFORE target creation/start: if the process
      // crashes mid-run (or after creating a fresh target workspace), the next
      // startup waits a full interval instead of hot-looping duplicate work.
      startedAt = new Date().toISOString();
      const didStamp = await this.persistLastRunStartedAt(sourceWorkspaceId, schedule, startedAt);
      if (didStamp) {
        await this.emitScheduleStampedMetadata({
          type: "workspace",
          workspaceId: sourceWorkspaceId,
          workflowName: schedule.workflowName,
          startedAt,
        });
      }
      if (!didStamp) {
        log.info("Skipping stale automation dispatch after workspace schedule changed", {
          sourceWorkspaceId,
          workflowName: schedule.workflowName,
        });
        return;
      }
      const targetResolution = await this.resolveTargetWorkspaceId({
        sourceProjectPath,
        sourceWorkspace,
        schedule,
        startedAt,
      });
      targetWorkspaceId = targetResolution.workspaceId;
      createdFreshTarget = targetResolution.createdFreshTarget;
      const contextMode = getWorkflowScheduleContextMode(schedule);
      if (contextMode !== WORKFLOW_SCHEDULE_DEFAULT_CONTEXT_MODE) {
        if (this.options.prepareContext == null) {
          throw new Error("Scheduled workflow context preparation is unavailable");
        }
        await this.options.prepareContext({
          workspaceId: targetWorkspaceId,
          sourceWorkspaceId,
          contextMode,
        });
      }
      const result = await this.options.startWorkflow({
        workspaceId: targetWorkspaceId,
        sourceWorkspaceId,
        name: schedule.workflowName,
        args: schedule.args ?? {},
      });
      log.info("Scheduled workflow run finished", {
        sourceWorkspaceId,
        targetWorkspaceId,
        workflowName: schedule.workflowName,
        runId: result.runId,
        status: result.status,
      });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      if (createdFreshTarget) {
        await this.cleanupFreshTargetAfterFailure({
          workspaceId: targetWorkspaceId,
          sourceWorkspaceId,
          workflowName: schedule.workflowName,
          startedAt,
          error: errorMessage,
        });
      }
      // Failures are logged, never thrown: the schedule retries on the next
      // due tick (lastRunStartedAt was already advanced).
      log.error("Scheduled workflow run failed", {
        sourceWorkspaceId,
        targetWorkspaceId,
        workflowName: schedule.workflowName,
        error: errorMessage,
      });
    }
  }

  private async dispatchProjectSchedule(
    sourceProjectPath: string,
    sourceProject: ProjectConfig,
    schedule: ProjectWorkflowSchedule,
    options: ProjectScheduleDispatchOptions = {}
  ): Promise<{ runId: string; status: string } | void> {
    let startedAt = "";
    let targetWorkspaceId = "";
    let createdFreshTarget = false;

    try {
      const unavailableTargetReason = this.getExistingProjectTargetUnavailableReason(
        sourceProjectPath,
        sourceProject,
        schedule
      );
      if (unavailableTargetReason != null) {
        log.warn("Skipping unavailable project automation target", {
          sourceProjectPath,
          scheduleId: schedule.id,
          workflowName: schedule.workflowName,
          reason: unavailableTargetReason,
        });
        if (options.rethrowErrors === true) {
          throw new Error(unavailableTargetReason);
        }
        return;
      }
      // Project automations own the schedule; workspaces are resolved only when a run is due.
      startedAt = new Date().toISOString();
      const didStamp = await this.persistProjectLastRunStartedAt(
        sourceProjectPath,
        schedule,
        startedAt
      );
      if (didStamp) {
        await this.emitScheduleStampedMetadata({
          type: "project",
          projectPath: sourceProjectPath,
          scheduleId: schedule.id,
          workflowName: schedule.workflowName,
          startedAt,
        });
      }
      if (!didStamp) {
        log.info("Skipping stale automation dispatch after project schedule changed", {
          sourceProjectPath,
          scheduleId: schedule.id,
          workflowName: schedule.workflowName,
        });
        return;
      }
      const targetResolution = await this.resolveProjectTargetWorkspaceId({
        sourceProjectPath,
        sourceProject,
        schedule,
        startedAt,
      });
      targetWorkspaceId = targetResolution.workspaceId;
      createdFreshTarget = targetResolution.createdFreshTarget;
      const contextMode = getProjectWorkflowScheduleContextMode(schedule);
      if (contextMode !== WORKFLOW_SCHEDULE_DEFAULT_CONTEXT_MODE) {
        if (this.options.prepareContext == null) {
          throw new Error("Scheduled workflow context preparation is unavailable");
        }
        await this.options.prepareContext({
          workspaceId: targetWorkspaceId,
          sourceWorkspaceId: targetWorkspaceId,
          contextMode,
        });
      }
      const result = await this.options.startWorkflow({
        workspaceId: targetWorkspaceId,
        sourceWorkspaceId: targetWorkspaceId,
        sourceProjectPath,
        projectScheduleId: schedule.id,
        name: schedule.workflowName,
        args: schedule.args ?? {},
        ...(options.backgroundOnMessageQueued === true ? { backgroundOnMessageQueued: true } : {}),
        ...(options.onTerminal != null ? { onTerminal: options.onTerminal } : {}),
      });
      log.info("Project scheduled workflow run finished", {
        sourceProjectPath,
        targetWorkspaceId,
        workflowName: schedule.workflowName,
        scheduleId: schedule.id,
        runId: result.runId,
        status: result.status,
      });
      return result;
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      if (createdFreshTarget) {
        await this.cleanupFreshTargetAfterFailure({
          workspaceId: targetWorkspaceId,
          sourceWorkspaceId: targetWorkspaceId,
          sourceProjectPath,
          projectScheduleId: schedule.id,
          workflowName: schedule.workflowName,
          startedAt,
          error: errorMessage,
        });
      }
      log.error("Project scheduled workflow run failed", {
        sourceProjectPath,
        targetWorkspaceId,
        workflowName: schedule.workflowName,
        scheduleId: schedule.id,
        error: errorMessage,
      });
      if (options.rethrowErrors === true) {
        throw error;
      }
    }
  }

  private getProjectWorkspaceOwner(
    sourceProjectPath: string,
    sourceProject: ProjectConfig
  ): ProjectConfig | null {
    const ownerProjectPath = sourceProject.parentProjectPath ?? sourceProjectPath;
    if (ownerProjectPath === sourceProjectPath) {
      return sourceProject;
    }
    return this.options.config.loadConfigOrDefault().projects.get(ownerProjectPath) ?? null;
  }

  private getExistingProjectTargetUnavailableReason(
    sourceProjectPath: string,
    sourceProject: ProjectConfig,
    schedule: ProjectWorkflowSchedule
  ): string | null {
    const target = schedule.target;
    if (target.type !== "existing-workspace") {
      return null;
    }

    const ownerProject = this.getProjectWorkspaceOwner(sourceProjectPath, sourceProject);
    if (ownerProject == null) {
      return "Project scheduled workflow owner project was not found";
    }
    const workspace = ownerProject.workspaces.find((entry) => entry.id === target.workspaceId);
    if (workspace == null) {
      return "Project scheduled workflow target workspace was not found";
    }
    if (isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)) {
      return "Project scheduled workflow target workspace is archived";
    }
    return null;
  }

  private async resolveProjectTargetWorkspaceId(input: {
    sourceProjectPath: string;
    sourceProject: ProjectConfig;
    schedule: ProjectWorkflowSchedule;
    startedAt: string;
  }): Promise<{ workspaceId: string; createdFreshTarget: boolean }> {
    const target = input.schedule.target;
    if (target.type === "existing-workspace") {
      const ownerProject = this.getProjectWorkspaceOwner(
        input.sourceProjectPath,
        input.sourceProject
      );
      if (ownerProject == null) {
        throw new Error("Project scheduled workflow owner project was not found");
      }
      const workspace = ownerProject.workspaces.find((entry) => entry.id === target.workspaceId);
      if (workspace == null) {
        throw new Error("Project scheduled workflow target workspace was not found");
      }
      if (isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)) {
        throw new Error("Project scheduled workflow target workspace is archived");
      }
      return { workspaceId: target.workspaceId, createdFreshTarget: false };
    }

    if (this.options.createWorkspaceForProjectSchedule == null) {
      throw new Error("Project scheduled workflow new-workspace target is unavailable");
    }

    const created = await this.options.createWorkspaceForProjectSchedule({
      sourceProjectPath: input.sourceProjectPath,
      sourceProject: input.sourceProject,
      target,
      workflowName: input.schedule.workflowName,
      scheduleId: input.schedule.id,
      startedAt: input.startedAt,
    });
    assert(
      created.workspaceId.trim().length > 0,
      "Project scheduled workflow target creation must return a workspaceId"
    );
    return { workspaceId: created.workspaceId, createdFreshTarget: true };
  }

  private async resolveTargetWorkspaceId(input: {
    sourceProjectPath: string;
    sourceWorkspace: Workspace;
    schedule: WorkspaceWorkflowSchedule;
    startedAt: string;
  }): Promise<{ workspaceId: string; createdFreshTarget: boolean }> {
    const sourceWorkspaceId = input.sourceWorkspace.id;
    assert(sourceWorkspaceId != null, "Scheduled workflow target resolution requires a source id");

    const target = getWorkflowScheduleTarget(input.schedule);
    if (target.type === "current-workspace") {
      return { workspaceId: sourceWorkspaceId, createdFreshTarget: false };
    }

    if (this.options.createWorkspaceForSchedule == null) {
      throw new Error("Scheduled workflow new-workspace target is unavailable");
    }

    const created = await this.options.createWorkspaceForSchedule({
      sourceWorkspaceId,
      sourceProjectPath: input.sourceProjectPath,
      sourceWorkspace: input.sourceWorkspace,
      target,
      workflowName: input.schedule.workflowName,
      startedAt: input.startedAt,
    });
    assert(
      created.workspaceId.trim().length > 0,
      "Scheduled workflow target creation must return a workspaceId"
    );
    return { workspaceId: created.workspaceId, createdFreshTarget: true };
  }

  private async emitScheduleStampedMetadata(input: WorkflowScheduleStampedInput): Promise<void> {
    if (this.options.onScheduleStamped == null) {
      return;
    }
    try {
      await this.options.onScheduleStamped(input);
    } catch (error) {
      log.debug("Failed to emit scheduled workflow metadata update", {
        ...(input.type === "workspace"
          ? { workspaceId: input.workspaceId }
          : { projectPath: input.projectPath, scheduleId: input.scheduleId }),
        workflowName: input.workflowName,
        error: getErrorMessage(error),
      });
    }
  }

  private async cleanupFreshTargetAfterFailure(
    input: WorkflowScheduleCleanupWorkspaceInput
  ): Promise<void> {
    if (this.options.cleanupWorkspaceForSchedule == null) {
      return;
    }
    try {
      await this.options.cleanupWorkspaceForSchedule(input);
    } catch (cleanupError) {
      log.error("Failed to cleanup scheduled workflow target workspace", {
        workspaceId: input.workspaceId,
        sourceWorkspaceId: input.sourceWorkspaceId,
        workflowName: input.workflowName,
        error: getErrorMessage(cleanupError),
        originalError: input.error,
      });
    }
  }

  private async persistLastRunStartedAt(
    workspaceId: string,
    dispatched: WorkspaceWorkflowSchedule,
    timestamp: string
  ): Promise<boolean> {
    let didStamp = false;
    await this.options.config.editConfig((config) => {
      for (const projectConfig of config.projects.values()) {
        const entry = projectConfig.workspaces.find((workspace) => workspace.id === workspaceId);
        if (entry == null) {
          continue;
        }
        // Guard against a setWorkflowSchedule racing this write: a freshly
        // (re)set schedule is documented to be immediately due, so a stale
        // dispatch must not stamp it (that would silently delay the new
        // schedule by a full interval). Only stamp the exact schedule this
        // dispatch observed; on mismatch the stale run still proceeds but the
        // new schedule keeps its due-now state.
        const persistedSchedule = parsePersistedWorkflowSchedule(entry.workflowSchedule);
        if (persistedSchedule != null && schedulesEqual(persistedSchedule, dispatched)) {
          entry.workflowSchedule = { ...persistedSchedule, lastRunStartedAt: timestamp };
          didStamp = true;
        }
        break;
      }
      return config;
    });
    return didStamp;
  }

  private async persistProjectLastRunStartedAt(
    projectPath: string,
    dispatched: ProjectWorkflowSchedule,
    timestamp: string
  ): Promise<boolean> {
    let didStamp = false;
    await this.options.config.editConfig((config) => {
      const project = config.projects.get(projectPath);
      if (project == null) {
        return config;
      }
      const schedules = project.workflowSchedules ?? [];
      const scheduleIndex = schedules.findIndex((schedule) => schedule.id === dispatched.id);
      if (scheduleIndex < 0) {
        return config;
      }
      const persistedSchedule = parsePersistedProjectWorkflowSchedule(schedules[scheduleIndex]);
      if (persistedSchedule != null && projectSchedulesEqual(persistedSchedule, dispatched)) {
        const nextSchedules = [...schedules];
        nextSchedules[scheduleIndex] = { ...persistedSchedule, lastRunStartedAt: timestamp };
        project.workflowSchedules = nextSchedules;
        didStamp = true;
      }
      return config;
    });
    return didStamp;
  }
}

function getWorkflowScheduleContextMode(
  schedule: WorkspaceWorkflowSchedule
): WorkflowScheduleContextMode {
  return schedule.contextMode ?? WORKFLOW_SCHEDULE_DEFAULT_CONTEXT_MODE;
}

function getWorkflowScheduleTarget(schedule: WorkspaceWorkflowSchedule): WorkflowScheduleTarget {
  return schedule.target ?? { type: "current-workspace" };
}

function getProjectWorkflowScheduleContextMode(
  schedule: ProjectWorkflowSchedule
): WorkflowScheduleContextMode {
  return schedule.target.type === "existing-workspace"
    ? (schedule.contextMode ?? WORKFLOW_SCHEDULE_DEFAULT_CONTEXT_MODE)
    : WORKFLOW_SCHEDULE_DEFAULT_CONTEXT_MODE;
}

function getWorkspaceScheduleDispatchKey(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

function getProjectScheduleDispatchKey(projectPath: string, scheduleId: string): string {
  return `project:${projectPath}:${scheduleId}`;
}

/** Field-wise schedule identity (config objects are re-parsed per load, so reference equality is meaningless). */
function projectSchedulesEqual(a: ProjectWorkflowSchedule, b: ProjectWorkflowSchedule): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.enabled === b.enabled &&
    a.workflowName === b.workflowName &&
    a.intervalMs === b.intervalMs &&
    a.lastRunStartedAt === b.lastRunStartedAt &&
    getProjectWorkflowScheduleContextMode(a) === getProjectWorkflowScheduleContextMode(b) &&
    JSON.stringify(a.target) === JSON.stringify(b.target) &&
    JSON.stringify(a.args ?? null) === JSON.stringify(b.args ?? null)
  );
}

function schedulesEqual(a: WorkspaceWorkflowSchedule, b: WorkspaceWorkflowSchedule): boolean {
  return (
    a.enabled === b.enabled &&
    a.workflowName === b.workflowName &&
    a.intervalMs === b.intervalMs &&
    a.lastRunStartedAt === b.lastRunStartedAt &&
    getWorkflowScheduleContextMode(a) === getWorkflowScheduleContextMode(b) &&
    JSON.stringify(getWorkflowScheduleTarget(a)) === JSON.stringify(getWorkflowScheduleTarget(b)) &&
    JSON.stringify(a.args ?? null) === JSON.stringify(b.args ?? null)
  );
}
