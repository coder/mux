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
import type { WorkspaceWorkflowSchedule } from "@/common/types/workspace";
import type { Config } from "@/node/config";
import { log } from "@/node/services/log";
import { WORKFLOW_SCHEDULE_CHECK_INTERVAL_MS } from "@/constants/workflowSchedule";

export interface WorkflowScheduleStartInput {
  workspaceId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface WorkflowSchedulerOptions {
  config: Pick<Config, "loadConfigOrDefault" | "editConfig">;
  /** Gate (dynamic-workflows experiment); schedules are skipped while false. */
  isEnabled: () => boolean;
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
  /** workspaceId → in-flight dispatch (skip-if-running + test synchronization). */
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
      for (const projectConfig of config.projects.values()) {
        for (const workspace of projectConfig.workspaces) {
          const schedule = workspace.workflowSchedule;
          const workspaceId = workspace.id;
          if (schedule?.enabled !== true || workspaceId == null) {
            continue;
          }
          if (isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)) {
            continue;
          }
          if (this.activeDispatches.has(workspaceId)) {
            continue; // skip-if-running
          }
          const lastStarted =
            schedule.lastRunStartedAt != null ? Date.parse(schedule.lastRunStartedAt) : Number.NaN;
          if (Number.isFinite(lastStarted) && now - lastStarted < schedule.intervalMs) {
            continue; // not due yet
          }
          const dispatch = this.dispatch(workspaceId, schedule).finally(() => {
            this.activeDispatches.delete(workspaceId);
          });
          this.activeDispatches.set(workspaceId, dispatch);
        }
      }
    } catch (error) {
      log.error("WorkflowSchedulerService tick failed", { error: getErrorMessage(error) });
    }
  }

  /** Test hook: resolves when all currently in-flight dispatches settle. */
  async awaitActiveDispatches(): Promise<void> {
    await Promise.all(this.activeDispatches.values());
  }

  private async dispatch(workspaceId: string, schedule: WorkspaceWorkflowSchedule): Promise<void> {
    try {
      // Persist the dispatch time BEFORE starting: if the process crashes
      // mid-run, the next startup waits a full interval instead of re-running
      // immediately (the orphaned run may still be resumable).
      await this.persistLastRunStartedAt(workspaceId, schedule, new Date().toISOString());
      const result = await this.options.startWorkflow({
        workspaceId,
        name: schedule.workflowName,
        args: schedule.args ?? {},
      });
      log.info("Scheduled workflow run finished", {
        workspaceId,
        workflowName: schedule.workflowName,
        runId: result.runId,
        status: result.status,
      });
    } catch (error) {
      // Failures are logged, never thrown: the schedule retries on the next
      // due tick (lastRunStartedAt was already advanced).
      log.error("Scheduled workflow run failed", {
        workspaceId,
        workflowName: schedule.workflowName,
        error: getErrorMessage(error),
      });
    }
  }

  private async persistLastRunStartedAt(
    workspaceId: string,
    dispatched: WorkspaceWorkflowSchedule,
    timestamp: string
  ): Promise<void> {
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
        if (entry.workflowSchedule != null && schedulesEqual(entry.workflowSchedule, dispatched)) {
          entry.workflowSchedule = { ...entry.workflowSchedule, lastRunStartedAt: timestamp };
        }
        break;
      }
      return config;
    });
  }
}

/** Field-wise schedule identity (config objects are re-parsed per load, so reference equality is meaningless). */
function schedulesEqual(a: WorkspaceWorkflowSchedule, b: WorkspaceWorkflowSchedule): boolean {
  return (
    a.enabled === b.enabled &&
    a.workflowName === b.workflowName &&
    a.intervalMs === b.intervalMs &&
    a.lastRunStartedAt === b.lastRunStartedAt &&
    JSON.stringify(a.args ?? null) === JSON.stringify(b.args ?? null)
  );
}
