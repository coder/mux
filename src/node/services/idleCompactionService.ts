import assert from "@/common/utils/assert";
import type { Config } from "@/node/config";
import type { HistoryService } from "./historyService";
import type { ExtensionMetadataService } from "./ExtensionMetadataService";
import { computeRecencyFromMessages } from "@/common/utils/recency";
import { log } from "./log";

const INITIAL_CHECK_DELAY_MS = 60 * 1000; // 1 minute - let startup initialization settle
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const HOURS_TO_MS = 60 * 60 * 1000;

interface QueuedIdleCompaction {
  workspaceId: string;
  thresholdMs: number;
}

/**
 * IdleCompactionService monitors workspaces for idle time and executes
 * compaction directly through a backend callback.
 *
 * Compactions are globally serialized to avoid thundering herd behavior when
 * one check cycle finds many idle workspaces at once.
 */
export class IdleCompactionService {
  private readonly config: Config;
  private readonly historyService: HistoryService;
  private readonly extensionMetadata: ExtensionMetadataService;
  private readonly executeIdleCompaction: (workspaceId: string) => Promise<void>;
  private initialTimeout: ReturnType<typeof setTimeout> | null = null;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private readonly queue: QueuedIdleCompaction[] = [];
  private readonly queuedWorkspaceIds = new Set<string>();
  private readonly activeWorkspaceIds = new Set<string>();
  private isProcessingQueue = false;
  private stopped = false;

  constructor(
    config: Config,
    historyService: HistoryService,
    extensionMetadata: ExtensionMetadataService,
    executeIdleCompaction: (workspaceId: string) => Promise<void>
  ) {
    this.config = config;
    this.historyService = historyService;
    this.extensionMetadata = extensionMetadata;
    this.executeIdleCompaction = executeIdleCompaction;
  }

  /**
   * Start the idle compaction checker.
   * First check after 1 minute, then every hour.
   */
  start(): void {
    this.stopped = false;

    // First check after delay to let startup settle.
    this.initialTimeout = setTimeout(() => {
      void this.checkAllWorkspaces();
      // Then periodically.
      this.checkInterval = setInterval(() => {
        void this.checkAllWorkspaces();
      }, CHECK_INTERVAL_MS);
    }, INITIAL_CHECK_DELAY_MS);
    log.info("IdleCompactionService started", {
      initialDelayMs: INITIAL_CHECK_DELAY_MS,
      intervalMs: CHECK_INTERVAL_MS,
    });
  }

  /**
   * Stop the idle compaction checker.
   */
  stop(): void {
    this.stopped = true;

    if (this.initialTimeout) {
      clearTimeout(this.initialTimeout);
      this.initialTimeout = null;
    }
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    // Best-effort queue reset: do not start new compactions after stop().
    this.queue.length = 0;
    this.queuedWorkspaceIds.clear();

    log.info("IdleCompactionService stopped");
  }

  /**
   * Check all workspaces across all projects for idle compaction eligibility.
   */
  async checkAllWorkspaces(): Promise<void> {
    const projectsConfig = this.config.loadConfigOrDefault();
    const now = Date.now();

    for (const [projectPath, projectConfig] of projectsConfig.projects) {
      const idleHours = projectConfig.idleCompactionHours;
      if (idleHours == null || idleHours < 1) continue;

      const thresholdMs = idleHours * HOURS_TO_MS;

      for (const workspace of projectConfig.workspaces) {
        const workspaceId = workspace.id ?? workspace.name;
        if (!workspaceId) continue;

        try {
          await this.checkWorkspace(workspaceId, projectPath, thresholdMs, now);
        } catch (error) {
          log.error("Idle compaction check failed", { workspaceId, error });
        }
      }
    }
  }

  private async checkWorkspace(
    workspaceId: string,
    _projectPath: string,
    thresholdMs: number,
    now: number
  ): Promise<void> {
    // Check eligibility.
    const eligibility = await this.checkEligibility(workspaceId, thresholdMs, now);
    if (!eligibility.eligible) {
      log.debug("Workspace not eligible for idle compaction", {
        workspaceId,
        reason: eligibility.reason,
      });
      return;
    }

    this.enqueueCompaction(workspaceId, thresholdMs);
  }

  private enqueueCompaction(workspaceId: string, thresholdMs: number): void {
    assert(workspaceId.trim().length > 0, "Idle compaction queue requires a workspaceId");
    assert(thresholdMs > 0, "Idle compaction queue requires a positive threshold");

    if (this.queuedWorkspaceIds.has(workspaceId) || this.activeWorkspaceIds.has(workspaceId)) {
      log.debug("Skipping duplicate idle compaction queue entry", {
        workspaceId,
      });
      return;
    }

    this.queue.push({ workspaceId, thresholdMs });
    this.queuedWorkspaceIds.add(workspaceId);

    log.info("Queued idle compaction", {
      workspaceId,
      queueLength: this.queue.length,
      idleHours: thresholdMs / HOURS_TO_MS,
    });

    // Fire and forget: processing is serialized internally.
    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.stopped) {
      return;
    }

    this.isProcessingQueue = true;

    try {
      while (this.queue.length > 0) {
        if (this.stopped) {
          return;
        }

        const next = this.queue.shift();
        if (!next) {
          continue;
        }

        const { workspaceId, thresholdMs } = next;
        this.queuedWorkspaceIds.delete(workspaceId);
        this.activeWorkspaceIds.add(workspaceId);

        try {
          // Re-check eligibility right before execution to avoid stale queue decisions.
          const eligibility = await this.checkEligibility(workspaceId, thresholdMs, Date.now());
          if (!eligibility.eligible) {
            log.info("Skipped queued idle compaction because workspace became ineligible", {
              workspaceId,
              reason: eligibility.reason,
            });
            continue;
          }

          log.info("Executing idle compaction", {
            workspaceId,
            idleHours: thresholdMs / HOURS_TO_MS,
            remainingQueued: this.queue.length,
          });

          await this.executeIdleCompaction(workspaceId);
        } catch (error) {
          log.error("Idle compaction execution failed", { workspaceId, error });
        } finally {
          this.activeWorkspaceIds.delete(workspaceId);
        }
      }
    } finally {
      this.isProcessingQueue = false;

      // If work arrived after we exited the loop and service is still running,
      // kick processing again.
      if (!this.stopped && this.queue.length > 0) {
        void this.processQueue();
      }
    }
  }

  /**
   * Check if a workspace is eligible for idle compaction.
   */
  async checkEligibility(
    workspaceId: string,
    thresholdMs: number,
    now: number
  ): Promise<{ eligible: boolean; reason?: string }> {
    // 1. Has messages? Only need tail messages — recency + last-message checks don't need full history.
    const historyResult = await this.historyService.getLastMessages(workspaceId, 50);
    if (!historyResult.success || historyResult.data.length === 0) {
      return { eligible: false, reason: "no_messages" };
    }
    const messages = historyResult.data;

    // 2. Check recency from messages (single source of truth).
    const recency = computeRecencyFromMessages(messages);
    if (recency === null) {
      return { eligible: false, reason: "no_recency_data" };
    }
    const idleMs = now - recency;
    if (idleMs < thresholdMs) {
      return { eligible: false, reason: "not_idle_enough" };
    }

    // 3. Currently streaming?
    const activity = await this.extensionMetadata.getMetadata(workspaceId);
    if (activity?.streaming) {
      return { eligible: false, reason: "currently_streaming" };
    }

    // 4. Already compacted? (last message is compacted summary)
    const lastMessage = messages[messages.length - 1];
    // Support both new enum ("user"|"idle") and legacy boolean (true)
    if (lastMessage?.metadata?.compacted) {
      return { eligible: false, reason: "already_compacted" };
    }

    // 5. Last message is user message with no response? (incomplete conversation)
    if (lastMessage?.role === "user") {
      return { eligible: false, reason: "awaiting_response" };
    }

    return { eligible: true };
  }
}
