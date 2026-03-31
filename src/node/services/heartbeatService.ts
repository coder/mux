import assert from "@/common/utils/assert";
import type { MuxMessage } from "@/common/types/message";
import type { ProjectsConfig, Workspace } from "@/common/types/project";
import type { WorkspaceActivitySnapshot, WorkspaceMetadata } from "@/common/types/workspace";
import { isWorkspaceArchived } from "@/common/utils/archive";
import {
  HEARTBEAT_DEFAULT_INTERVAL_MS,
  HEARTBEAT_MAX_INTERVAL_MS,
  HEARTBEAT_MIN_INTERVAL_MS,
} from "@/constants/heartbeat";
import type { Config } from "@/node/config";
import type { ExtensionMetadataService } from "./ExtensionMetadataService";
import { log } from "./log";
import type { TaskService } from "./taskService";
import type { WorkspaceService } from "./workspaceService";

const STARTUP_DELAY_MS = 60 * 1000; // 60s - let startup settle
const CHECK_INTERVAL_MS = 30 * 1000; // 30s tick
const MAX_CONCURRENT_HEARTBEATS = 1;

interface HeartbeatEligibilityResult {
  eligible: boolean;
  reason?: string;
}

export class HeartbeatService {
  private readonly config: Config;
  private readonly extensionMetadata: ExtensionMetadataService;
  private readonly workspaceService: WorkspaceService;
  private readonly taskService: TaskService;

  private startupTimeout: ReturnType<typeof setTimeout> | null = null;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private stopped = true;

  private readonly nextEligibleAtByWorkspaceId = new Map<string, number>();
  private readonly trackedIntervalMsByWorkspaceId = new Map<string, number>();
  private readonly activeWorkspaceIds = new Set<string>();
  private readonly queuedWorkspaceIds = new Set<string>();
  private isProcessingQueue = false;
  private tickInFlight = false;
  private lifecycleVersion = 0;

  private readonly onActivity: (event: {
    workspaceId: string;
    activity: WorkspaceActivitySnapshot | null;
  }) => void;
  private readonly onMetadata: (event: {
    workspaceId: string;
    metadata: WorkspaceMetadata | null;
  }) => void;

  constructor(
    config: Config,
    extensionMetadata: ExtensionMetadataService,
    workspaceService: WorkspaceService,
    taskService: TaskService
  ) {
    this.config = config;
    this.extensionMetadata = extensionMetadata;
    this.workspaceService = workspaceService;
    this.taskService = taskService;

    this.onActivity = (event) => this.handleActivityEvent(event);
    this.onMetadata = (event) => this.handleMetadataEvent(event);
  }

  start(): void {
    assert(this.stopped, "HeartbeatService.start() called while already running");
    this.stopped = false;
    this.lifecycleVersion += 1;

    this.workspaceService.on("activity", this.onActivity);
    this.workspaceService.on("metadata", this.onMetadata);

    this.startupTimeout = setTimeout(() => {
      if (this.stopped) {
        return;
      }

      this.startupTimeout = null;
      this.tick();
      this.checkInterval = setInterval(() => {
        this.tick();
      }, CHECK_INTERVAL_MS);
    }, STARTUP_DELAY_MS);

    log.info("HeartbeatService started", {
      startupDelayMs: STARTUP_DELAY_MS,
      checkIntervalMs: CHECK_INTERVAL_MS,
    });
  }

  stop(): void {
    this.stopped = true;
    this.lifecycleVersion += 1;

    if (this.startupTimeout) {
      clearTimeout(this.startupTimeout);
      this.startupTimeout = null;
    }
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    this.workspaceService.off("activity", this.onActivity);
    this.workspaceService.off("metadata", this.onMetadata);

    this.nextEligibleAtByWorkspaceId.clear();
    this.trackedIntervalMsByWorkspaceId.clear();
    this.activeWorkspaceIds.clear();
    this.queuedWorkspaceIds.clear();
    this.isProcessingQueue = false;
    this.tickInFlight = false;

    log.info("HeartbeatService stopped");
  }

  private tick(): void {
    if (this.stopped || this.tickInFlight) {
      return;
    }

    const now = Date.now();
    const lifecycleVersion = this.lifecycleVersion;
    this.tickInFlight = true;
    void this.runTick(now, lifecycleVersion);
  }

  private async runTick(now: number, lifecycleVersion: number): Promise<void> {
    assert(Number.isFinite(now), "HeartbeatService.runTick requires a finite timestamp");

    try {
      await this.resyncFromConfig(now, lifecycleVersion);
      if (this.stopped || this.lifecycleVersion !== lifecycleVersion) {
        return;
      }

      this.checkAllWorkspaces(now);
    } catch (error) {
      log.error("HeartbeatService tick failed", { error });
    } finally {
      this.tickInFlight = false;
    }
  }

  private async resyncFromConfig(
    now: number,
    lifecycleVersion: number = this.lifecycleVersion
  ): Promise<void> {
    assert(Number.isFinite(now), "HeartbeatService.resyncFromConfig requires a finite timestamp");

    const activitySnapshots = await this.extensionMetadata.getAllSnapshots();
    if (this.lifecycleVersion !== lifecycleVersion) {
      return;
    }

    const config = this.config.loadConfigOrDefault();
    const configuredWorkspaceIds = new Set<string>();

    for (const [, projectConfig] of config.projects) {
      if (this.lifecycleVersion !== lifecycleVersion) {
        return;
      }

      for (const workspace of projectConfig.workspaces) {
        if (this.lifecycleVersion !== lifecycleVersion) {
          return;
        }

        const workspaceId = this.getWorkspaceId(workspace);
        if (!workspaceId) {
          continue;
        }

        configuredWorkspaceIds.add(workspaceId);
        const trackingIntervalMs = this.getTrackingIntervalMsForWorkspace(workspace, config);
        if (trackingIntervalMs != null) {
          const nextEligibleAt = this.nextEligibleAtByWorkspaceId.has(workspaceId)
            ? now + trackingIntervalMs
            : this.deriveInitialNextEligibleAt(
                now,
                workspaceId,
                trackingIntervalMs,
                activitySnapshots.get(workspaceId)
              );
          this.ensureTrackedWorkspace(workspaceId, nextEligibleAt, trackingIntervalMs);
          continue;
        }

        this.purgeWorkspace(workspaceId, "config_resync_ineligible");
      }
    }

    for (const workspaceId of this.getTrackedWorkspaceIds()) {
      if (this.lifecycleVersion !== lifecycleVersion) {
        return;
      }
      if (!configuredWorkspaceIds.has(workspaceId)) {
        this.purgeWorkspace(workspaceId, "config_resync_missing");
      }
    }
  }

  private deriveInitialNextEligibleAt(
    now: number,
    workspaceId: string,
    trackingIntervalMs: number,
    activity: WorkspaceActivitySnapshot | undefined
  ): number {
    assert(
      Number.isFinite(now),
      "HeartbeatService.deriveInitialNextEligibleAt requires a finite timestamp"
    );
    assert(
      workspaceId.trim().length > 0,
      "HeartbeatService.deriveInitialNextEligibleAt requires a workspaceId"
    );
    assert(
      this.isValidTrackingIntervalMs(trackingIntervalMs),
      "HeartbeatService.deriveInitialNextEligibleAt requires an interval within supported bounds"
    );

    const fallbackDeadline = now + trackingIntervalMs;
    if (!activity || activity.streaming) {
      return fallbackDeadline;
    }

    const { recency } = activity;
    if (!Number.isFinite(recency) || recency < 0 || recency > now) {
      log.warn("HeartbeatService: ignoring invalid persisted activity recency", {
        workspaceId,
        recency,
        trackingIntervalMs,
        now,
      });
      return fallbackDeadline;
    }

    const derivedNextEligibleAt = recency + trackingIntervalMs;
    if (!Number.isFinite(derivedNextEligibleAt)) {
      log.warn("HeartbeatService: ignoring overflowed persisted activity deadline", {
        workspaceId,
        recency,
        trackingIntervalMs,
      });
      return fallbackDeadline;
    }

    return Math.max(derivedNextEligibleAt, now);
  }

  private ensureTrackedWorkspace(
    workspaceId: string,
    nextEligibleAt: number,
    trackingIntervalMs: number
  ): void {
    assert(
      workspaceId.trim().length > 0,
      "HeartbeatService.ensureTrackedWorkspace requires a workspaceId"
    );
    assert(
      Number.isFinite(nextEligibleAt),
      "HeartbeatService.ensureTrackedWorkspace requires a finite deadline"
    );
    assert(
      this.isValidTrackingIntervalMs(trackingIntervalMs),
      "HeartbeatService.ensureTrackedWorkspace requires an interval within supported bounds"
    );

    const previousNextEligibleAt = this.nextEligibleAtByWorkspaceId.get(workspaceId);
    const previousIntervalMs = this.trackedIntervalMsByWorkspaceId.get(workspaceId);
    if (previousNextEligibleAt != null && previousIntervalMs === trackingIntervalMs) {
      return;
    }

    this.nextEligibleAtByWorkspaceId.set(workspaceId, nextEligibleAt);
    this.trackedIntervalMsByWorkspaceId.set(workspaceId, trackingIntervalMs);
    log.debug(
      previousNextEligibleAt == null
        ? "HeartbeatService: tracking workspace"
        : "HeartbeatService: updated tracked workspace deadline",
      {
        workspaceId,
        previousNextEligibleAt,
        previousIntervalMs,
        nextEligibleAt,
        trackingIntervalMs,
      }
    );
  }

  private purgeWorkspace(workspaceId: string, reason: string): void {
    assert(workspaceId.trim().length > 0, "HeartbeatService.purgeWorkspace requires a workspaceId");
    assert(reason.trim().length > 0, "HeartbeatService.purgeWorkspace requires a reason");

    const removedDeadline = this.nextEligibleAtByWorkspaceId.delete(workspaceId);
    const removedInterval = this.trackedIntervalMsByWorkspaceId.delete(workspaceId);
    const removedActive = this.activeWorkspaceIds.delete(workspaceId);
    const removedQueued = this.queuedWorkspaceIds.delete(workspaceId);
    if (!removedDeadline && !removedInterval && !removedActive && !removedQueued) {
      return;
    }

    log.debug("HeartbeatService: purged workspace", {
      workspaceId,
      reason,
      removedDeadline,
      removedInterval,
      removedActive,
      removedQueued,
    });
  }

  private handleActivityEvent(event: {
    workspaceId: string;
    activity: WorkspaceActivitySnapshot | null;
  }): void {
    if (this.stopped) {
      return;
    }

    const { workspaceId, activity } = event;
    if (!activity || activity.streaming) {
      return;
    }
    if (!this.nextEligibleAtByWorkspaceId.has(workspaceId)) {
      return;
    }

    const config = this.config.loadConfigOrDefault();
    const intervalMs = this.getHeartbeatIntervalMs(workspaceId, config);
    if (intervalMs == null) {
      this.purgeWorkspace(workspaceId, "activity_event_ineligible");
      return;
    }

    this.nextEligibleAtByWorkspaceId.set(workspaceId, Date.now() + intervalMs);
    this.trackedIntervalMsByWorkspaceId.set(workspaceId, intervalMs);
    log.debug("HeartbeatService: activity event reset countdown", { workspaceId, intervalMs });
  }

  private handleMetadataEvent(event: {
    workspaceId: string;
    metadata: WorkspaceMetadata | null;
  }): void {
    if (this.stopped) {
      return;
    }

    const { workspaceId, metadata } = event;
    if (!metadata) {
      this.purgeWorkspace(workspaceId, "workspace_deleted");
      return;
    }
    if (metadata.parentWorkspaceId != null) {
      this.purgeWorkspace(workspaceId, "child_workspace");
      return;
    }
    if (isWorkspaceArchived(metadata.archivedAt, metadata.unarchivedAt)) {
      this.purgeWorkspace(workspaceId, "archived");
      return;
    }

    if (metadata.heartbeat?.enabled) {
      const config = this.config.loadConfigOrDefault();
      const intervalMs = this.getSanitizedTrackingIntervalMs(
        workspaceId,
        metadata.heartbeat.intervalMs,
        config,
        "metadata_event"
      );
      if (intervalMs == null) {
        this.purgeWorkspace(workspaceId, "heartbeat_invalid_interval");
        return;
      }

      this.ensureTrackedWorkspace(workspaceId, Date.now() + intervalMs, intervalMs);
      return;
    }

    this.purgeWorkspace(workspaceId, "heartbeat_disabled");
  }

  private getHeartbeatIntervalMs(workspaceId: string, config: ProjectsConfig): number | null {
    const workspace = this.findWorkspaceConfigEntry(workspaceId, config);
    if (workspace?.heartbeat?.enabled !== true) {
      return null;
    }

    return this.getSanitizedTrackingIntervalMs(
      workspaceId,
      workspace.heartbeat.intervalMs,
      config,
      "heartbeat_lookup"
    );
  }

  private checkAllWorkspaces(now: number): void {
    assert(Number.isFinite(now), "HeartbeatService.checkAllWorkspaces requires a finite timestamp");

    for (const [workspaceId, nextEligibleAt] of this.nextEligibleAtByWorkspaceId) {
      if (now < nextEligibleAt) {
        continue;
      }
      if (this.activeWorkspaceIds.has(workspaceId) || this.queuedWorkspaceIds.has(workspaceId)) {
        continue;
      }

      this.queueWorkspace(workspaceId);
    }
  }

  private queueWorkspace(workspaceId: string): void {
    assert(
      workspaceId.trim().length > 0,
      "HeartbeatService: queueWorkspace requires a workspaceId"
    );

    if (this.queuedWorkspaceIds.has(workspaceId) || this.activeWorkspaceIds.has(workspaceId)) {
      log.debug("HeartbeatService: skipping duplicate queue entry", { workspaceId });
      return;
    }

    this.queuedWorkspaceIds.add(workspaceId);
    log.info("HeartbeatService: queued heartbeat", {
      workspaceId,
      queueSize: this.queuedWorkspaceIds.size,
    });
    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.stopped) {
      return;
    }

    this.isProcessingQueue = true;

    try {
      while (this.queuedWorkspaceIds.size > 0) {
        if (this.stopped) {
          return;
        }

        assert(
          this.activeWorkspaceIds.size <= MAX_CONCURRENT_HEARTBEATS,
          "HeartbeatService: active heartbeat count exceeded concurrency cap"
        );
        if (this.activeWorkspaceIds.size >= MAX_CONCURRENT_HEARTBEATS) {
          return;
        }

        const workspaceId = this.queuedWorkspaceIds.values().next().value;
        if (typeof workspaceId !== "string") {
          break;
        }

        this.queuedWorkspaceIds.delete(workspaceId);
        this.activeWorkspaceIds.add(workspaceId);

        try {
          const eligibility = await this.checkEligibility(workspaceId, Date.now());
          if (!eligibility.eligible) {
            log.info("HeartbeatService: skipped queued heartbeat (ineligible)", {
              workspaceId,
              reason: eligibility.reason,
            });
            continue;
          }

          log.info("HeartbeatService: executing heartbeat", {
            workspaceId,
            remainingQueued: this.queuedWorkspaceIds.size,
          });

          await this.workspaceService.executeHeartbeat(workspaceId);
        } catch (error) {
          log.error("HeartbeatService: heartbeat execution failed", { workspaceId, error });
        } finally {
          this.activeWorkspaceIds.delete(workspaceId);
          if (!this.stopped) {
            const config = this.config.loadConfigOrDefault();
            const trackingIntervalMs = this.getTrackingIntervalMs(workspaceId, config);
            if (trackingIntervalMs != null) {
              this.nextEligibleAtByWorkspaceId.set(workspaceId, Date.now() + trackingIntervalMs);
              this.trackedIntervalMsByWorkspaceId.set(workspaceId, trackingIntervalMs);
            } else {
              this.purgeWorkspace(workspaceId, "post_dispatch_ineligible");
            }
          }
        }
      }
    } finally {
      this.isProcessingQueue = false;
      if (!this.stopped && this.queuedWorkspaceIds.size > 0) {
        void this.processQueue();
      }
    }
  }

  async checkEligibility(workspaceId: string, now: number): Promise<HeartbeatEligibilityResult> {
    assert(
      workspaceId.trim().length > 0,
      "HeartbeatService.checkEligibility requires a workspaceId"
    );
    assert(Number.isFinite(now), "HeartbeatService.checkEligibility requires a finite timestamp");

    const config = this.config.loadConfigOrDefault();
    const workspace = this.findWorkspaceConfigEntry(workspaceId, config);
    if (!workspace) {
      return { eligible: false, reason: "workspace_not_found" };
    }
    if (workspace.heartbeat?.enabled !== true) {
      return { eligible: false, reason: "heartbeat_disabled" };
    }
    if (isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)) {
      return { eligible: false, reason: "archived" };
    }
    if (workspace.parentWorkspaceId != null) {
      return { eligible: false, reason: "child_workspace" };
    }

    const activity = await this.extensionMetadata.getSnapshot(workspaceId);
    if (activity?.streaming === true) {
      return { eligible: false, reason: "currently_streaming" };
    }
    if (this.taskService.hasActiveDescendantAgentTasksForWorkspace(workspaceId)) {
      return { eligible: false, reason: "active_descendant_tasks" };
    }

    const history = await this.workspaceService.getChatHistory(workspaceId);
    if (history.length === 0 || !history.some((message) => message.role === "assistant")) {
      return { eligible: false, reason: "no_completed_turn" };
    }

    const lastMessage = history[history.length - 1];
    if (lastMessage?.role === "user") {
      return { eligible: false, reason: "awaiting_response" };
    }
    if (lastMessage?.role === "assistant" && this.hasInteractiveToolInput(lastMessage)) {
      return { eligible: false, reason: "awaiting_interactive_input" };
    }

    return { eligible: true };
  }

  private getTrackedWorkspaceIds(): string[] {
    return Array.from(
      new Set([
        ...this.nextEligibleAtByWorkspaceId.keys(),
        ...this.activeWorkspaceIds,
        ...this.queuedWorkspaceIds,
      ])
    );
  }

  private getTrackingIntervalMs(workspaceId: string, config: ProjectsConfig): number | null {
    const workspace = this.findWorkspaceConfigEntry(workspaceId, config);
    return workspace ? this.getTrackingIntervalMsForWorkspace(workspace, config) : null;
  }

  private getTrackingIntervalMsForWorkspace(
    workspace: Workspace,
    config: ProjectsConfig
  ): number | null {
    if (workspace.heartbeat?.enabled !== true) {
      return null;
    }
    if (workspace.parentWorkspaceId != null) {
      return null;
    }
    if (isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)) {
      return null;
    }

    const workspaceId = this.getWorkspaceId(workspace);
    if (!workspaceId) {
      return null;
    }

    return this.getSanitizedTrackingIntervalMs(
      workspaceId,
      workspace.heartbeat.intervalMs,
      config,
      "config_resync"
    );
  }

  private getSanitizedTrackingIntervalMs(
    workspaceId: string,
    rawIntervalMs: number | undefined,
    config: ProjectsConfig,
    source: "config_resync" | "heartbeat_lookup" | "metadata_event"
  ): number | null {
    assert(
      workspaceId.trim().length > 0,
      "HeartbeatService.getSanitizedTrackingIntervalMs requires a workspaceId"
    );

    const intervalMs =
      rawIntervalMs ?? config.heartbeatDefaultIntervalMs ?? HEARTBEAT_DEFAULT_INTERVAL_MS;
    if (this.isValidTrackingIntervalMs(intervalMs)) {
      return intervalMs;
    }

    log.warn("HeartbeatService: ignoring invalid persisted heartbeat interval", {
      workspaceId,
      rawIntervalMs,
      intervalMs,
      source,
      minIntervalMs: HEARTBEAT_MIN_INTERVAL_MS,
      maxIntervalMs: HEARTBEAT_MAX_INTERVAL_MS,
    });
    return null;
  }

  private isValidTrackingIntervalMs(intervalMs: number): boolean {
    return (
      Number.isFinite(intervalMs) &&
      intervalMs >= HEARTBEAT_MIN_INTERVAL_MS &&
      intervalMs <= HEARTBEAT_MAX_INTERVAL_MS
    );
  }

  private findWorkspaceConfigEntry(workspaceId: string, config: ProjectsConfig): Workspace | null {
    assert(
      workspaceId.trim().length > 0,
      "HeartbeatService.findWorkspaceConfigEntry requires a workspaceId"
    );

    for (const [, projectConfig] of config.projects) {
      for (const workspace of projectConfig.workspaces) {
        if (this.getWorkspaceId(workspace) === workspaceId) {
          return workspace;
        }
      }
    }

    return null;
  }

  private getWorkspaceId(workspace: Pick<Workspace, "id" | "name">): string | null {
    const rawWorkspaceId = workspace.id ?? workspace.name;
    if (typeof rawWorkspaceId !== "string") {
      return null;
    }

    const workspaceId = rawWorkspaceId.trim();
    return workspaceId.length > 0 ? workspaceId : null;
  }

  private hasInteractiveToolInput(message: MuxMessage): boolean {
    if (!Array.isArray(message.parts)) {
      return false;
    }

    return message.parts.some((part: unknown) => {
      if (typeof part !== "object" || part === null || !("type" in part) || !("state" in part)) {
        return false;
      }

      const partType = (part as { type: unknown }).type;
      const partState = (part as { state: unknown }).state;
      return (
        (partType === "dynamic-tool" || partType === "tool-invocation") &&
        partState === "input-available"
      );
    });
  }
}
