import type { Config } from "@/node/config";
import type { HistoryService } from "./historyService";
import type { ExtensionMetadataService } from "./ExtensionMetadataService";
import { computeRecencyFromMessages } from "@/common/utils/recency";
import { log } from "./log";

const INITIAL_CHECK_DELAY_MS = 60 * 1000; // 1 minute - let frontend fully initialize
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const HOURS_TO_MS = 60 * 60 * 1000;

/**
 * IdleCompactionService monitors workspaces for idle time and notifies
 * when they've been idle long enough to warrant compaction.
 *
 * The actual compaction is triggered by the frontend - this service just
 * checks eligibility and emits notifications via workspaceService.emitIdleCompactionNeeded().
 *
 * No pending state is tracked here. Double-triggering is prevented by:
 * - `currently_streaming` check blocks during active compaction
 * - `already_compacted` check blocks after compaction completes
 * - Frontend's triggeredWorkspacesRef deduplicates within a check cycle
 */
export class IdleCompactionService {
  private readonly config: Config;
  private readonly historyService: HistoryService;
  private readonly extensionMetadata: ExtensionMetadataService;
  private readonly emitIdleCompactionNeeded: (workspaceId: string) => void;
  private initialTimeout: ReturnType<typeof setTimeout> | null = null;
  private checkInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    config: Config,
    historyService: HistoryService,
    extensionMetadata: ExtensionMetadataService,
    emitIdleCompactionNeeded: (workspaceId: string) => void
  ) {
    this.config = config;
    this.historyService = historyService;
    this.extensionMetadata = extensionMetadata;
    this.emitIdleCompactionNeeded = emitIdleCompactionNeeded;
  }

  /**
   * Start the idle compaction checker.
   * First check after 1 minute (let frontend fully initialize), then every hour.
   */
  start(): void {
    // First check after delay to let frontend initialize and subscribe
    this.initialTimeout = setTimeout(() => {
      void this.checkAllWorkspaces();
      // Then periodically
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
    if (this.initialTimeout) {
      clearTimeout(this.initialTimeout);
      this.initialTimeout = null;
    }
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
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
    projectPath: string,
    thresholdMs: number,
    now: number
  ): Promise<void> {
    // Check eligibility
    const eligibility = await this.checkEligibility(workspaceId, thresholdMs, now);
    if (!eligibility.eligible) {
      log.debug("Workspace not eligible for idle compaction", {
        workspaceId,
        reason: eligibility.reason,
      });
      return;
    }

    // Notify frontend to trigger compaction
    log.info("Workspace eligible for idle compaction", {
      workspaceId,
      idleHours: thresholdMs / HOURS_TO_MS,
    });
    this.notifyNeedsCompaction(workspaceId);
  }

  /**
   * Check if a workspace is eligible for idle compaction.
   */
  async checkEligibility(
    workspaceId: string,
    thresholdMs: number,
    now: number
  ): Promise<{ eligible: boolean; reason?: string }> {
    // 1. Has messages?
    const historyResult = await this.historyService.getHistory(workspaceId);
    if (!historyResult.success || historyResult.data.length === 0) {
      return { eligible: false, reason: "no_messages" };
    }
    const messages = historyResult.data;

    // 2. Check recency from messages (single source of truth)
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
    if (lastMessage?.metadata?.compacted === true) {
      return { eligible: false, reason: "already_compacted" };
    }

    // 5. Last message is user message with no response? (incomplete conversation)
    if (lastMessage?.role === "user") {
      return { eligible: false, reason: "awaiting_response" };
    }

    return { eligible: true };
  }

  /**
   * Notify that a workspace needs idle compaction.
   */
  private notifyNeedsCompaction(workspaceId: string): void {
    this.emitIdleCompactionNeeded(workspaceId);
  }
}
