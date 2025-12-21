import type { EventEmitter } from "events";
import type { HistoryService } from "./historyService";
import type { PartialService } from "./partialService";

import type { StreamEndEvent } from "@/common/types/stream";
import type { WorkspaceChatMessage, DeleteMessage, ImagePart } from "@/common/orpc/types";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";

import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import type { TelemetryService } from "@/node/services/telemetryService";
import { roundToBase2 } from "@/common/telemetry/utils";
import { log } from "@/node/services/log";
import {
  extractEditedFileDiffs,
  type FileEditDiff,
} from "@/common/utils/messages/extractEditedFiles";
import { computeRecencyFromMessages } from "@/common/utils/recency";

/** Minimum word count for a valid compaction summary */
const MIN_SUMMARY_WORDS = 50;

/** Active compaction operation tracked via session state (control-plane) */
export interface ActiveCompactionOperation {
  operationId: string;
  /** Stream messageId for the compaction summary stream (set from stream-start) */
  streamMessageId: string | null;
  source: "user" | "force-compaction" | "idle-compaction";
  continueMessage?: {
    text: string;
    imageParts?: ImagePart[];
    model?: string;
    mode?: "exec" | "plan";
  };
}

interface CompactionHandlerOptions {
  workspaceId: string;
  historyService: HistoryService;
  partialService: PartialService;
  telemetryService?: TelemetryService;
  emitter: EventEmitter;
  /** Called when compaction completes successfully (e.g., to clear idle compaction pending state) */
  onCompactionComplete?: () => void;
  /** Get active compaction operation from session state (control-plane) */
  getActiveCompactionOperation: () => ActiveCompactionOperation | null;
  /** Clear active compaction operation after completion */
  clearActiveCompactionOperation: () => void;
}

/**
 * Handles history compaction for agent sessions
 *
 * Responsible for:
 * - Detecting compaction operations via session state
 * - Replacing chat history with compacted summaries (only on successful completion)
 * - Preserving cumulative usage across compactions
 *
 * IMPORTANT: History is only replaced when:
 * 1. An active compaction operation exists in session state
 * 2. The stream completed successfully (stream-end, not stream-abort/error)
 * 3. The summary text is valid (non-empty, meets minimum length)
 */
export class CompactionHandler {
  private readonly workspaceId: string;
  private readonly historyService: HistoryService;
  private readonly partialService: PartialService;
  private readonly telemetryService?: TelemetryService;
  private readonly emitter: EventEmitter;
  private readonly processedCompactionRequestIds: Set<string> = new Set<string>();
  private readonly onCompactionComplete?: () => void;
  private readonly getActiveCompactionOperation: () => ActiveCompactionOperation | null;
  private readonly clearActiveCompactionOperation: () => void;

  /** Flag indicating post-compaction attachments should be generated on next turn */
  private postCompactionAttachmentsPending = false;
  /** Cached file diffs extracted before history was cleared */
  private cachedFileDiffs: FileEditDiff[] = [];

  constructor(options: CompactionHandlerOptions) {
    this.workspaceId = options.workspaceId;
    this.historyService = options.historyService;
    this.partialService = options.partialService;
    this.telemetryService = options.telemetryService;
    this.emitter = options.emitter;
    this.onCompactionComplete = options.onCompactionComplete;
    this.getActiveCompactionOperation = options.getActiveCompactionOperation;
    this.clearActiveCompactionOperation = options.clearActiveCompactionOperation;
  }

  /**
   * Consume pending post-compaction diffs and clear them.
   * Returns null if no compaction occurred, otherwise returns the cached diffs.
   */
  consumePendingDiffs(): FileEditDiff[] | null {
    if (!this.postCompactionAttachmentsPending) {
      return null;
    }
    this.postCompactionAttachmentsPending = false;
    const diffs = this.cachedFileDiffs;
    this.cachedFileDiffs = [];
    return diffs;
  }

  /**
   * Peek at cached file paths without consuming them.
   * Returns paths of files that will be reinjected after compaction.
   * Returns null if no pending compaction attachments.
   */
  peekCachedFilePaths(): string[] | null {
    if (!this.postCompactionAttachmentsPending) {
      return null;
    }
    return this.cachedFileDiffs.map((diff) => diff.path);
  }

  /**
   * Handle compaction stream completion.
   *
   * Only processes compaction if there's an active operation in session state.
   * This ensures compaction can only be triggered via the control-plane
   * (compactHistory endpoint), not by user messages with special metadata.
   *
   * @returns true if this was a compaction stream, false otherwise
   */
  async handleCompletion(event: StreamEndEvent): Promise<boolean> {
    const activeOperation = this.getActiveCompactionOperation();
    if (!activeOperation) {
      // No active compaction - this is a normal stream completion
      return false;
    }

    // Only treat this stream-end as compaction if it belongs to the compaction stream.
    // This prevents unrelated stream-end events (e.g., a previous stream finishing after a
    // graceful stop) from replacing history.
    if (activeOperation.streamMessageId !== event.messageId) {
      return false;
    }

    // Dedupe by operationId (prevents double-processing on reconnect)
    if (this.processedCompactionRequestIds.has(activeOperation.operationId)) {
      log.debug("Skipping already-processed compaction operation", {
        operationId: activeOperation.operationId,
      });
      return true;
    }

    // Extract summary text from stream parts
    const summary = event.parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");

    // Validate summary before replacing history
    const validationResult = this.validateSummary(summary);
    if (!validationResult.valid) {
      log.error("Compaction summary validation failed:", {
        operationId: activeOperation.operationId,
        reason: validationResult.reason,
        summaryLength: summary.length,
      });
      this.clearActiveCompactionOperation();
      // Emit stream-end so UI updates, but history remains unchanged
      this.emitChatEvent(event);
      return true;
    }

    // Get current history for compaction
    const historyResult = await this.historyService.getHistory(this.workspaceId);
    if (!historyResult.success) {
      log.error("Failed to get history for compaction:", historyResult.error);
      this.clearActiveCompactionOperation();
      this.emitChatEvent(event);
      return true;
    }

    // Mark as processed before performing compaction
    this.processedCompactionRequestIds.add(activeOperation.operationId);

    const isIdleCompaction = activeOperation.source === "idle-compaction";
    const result = await this.performCompaction(
      summary,
      event.metadata,
      historyResult.data,
      isIdleCompaction
    );

    if (!result.success) {
      log.error("Compaction failed:", {
        operationId: activeOperation.operationId,
        error: result.error,
      });
      this.clearActiveCompactionOperation();
      this.emitChatEvent(event);
      return true;
    }

    // Success - capture telemetry and notify
    this.captureCompactionTelemetry(event, isIdleCompaction ? "idle" : "manual");
    this.clearActiveCompactionOperation();
    this.onCompactionComplete?.();

    // Emit stream-end so UI knows compaction completed
    this.emitChatEvent(event);
    return true;
  }

  /**
   * Validate that a summary is suitable for replacing history.
   * Prevents data loss from empty or truncated summaries.
   */
  private validateSummary(summary: string): { valid: true } | { valid: false; reason: string } {
    if (!summary || summary.trim().length === 0) {
      return { valid: false, reason: "Summary is empty" };
    }

    const wordCount = summary.trim().split(/\s+/).length;
    if (wordCount < MIN_SUMMARY_WORDS) {
      return {
        valid: false,
        reason: `Summary too short: ${wordCount} words (minimum: ${MIN_SUMMARY_WORDS})`,
      };
    }

    return { valid: true };
  }

  /**
   * Capture telemetry for compaction completion
   */
  private captureCompactionTelemetry(event: StreamEndEvent, source: "idle" | "manual"): void {
    const durationSecs =
      typeof event.metadata.duration === "number" ? event.metadata.duration / 1000 : 0;
    const inputTokens =
      event.metadata.contextUsage?.inputTokens ?? event.metadata.usage?.inputTokens ?? 0;
    const outputTokens =
      event.metadata.contextUsage?.outputTokens ?? event.metadata.usage?.outputTokens ?? 0;

    this.telemetryService?.capture({
      event: "compaction_completed",
      properties: {
        model: event.metadata.model,
        duration_b2: roundToBase2(durationSecs),
        input_tokens_b2: roundToBase2(inputTokens ?? 0),
        output_tokens_b2: roundToBase2(outputTokens ?? 0),
        compaction_source: source,
      },
    });
  }

  /**
   * Perform history compaction by replacing all messages with a summary
   *
   * Steps:
   * 1. Clear entire history and get deleted sequence numbers
   * 2. Append summary message with metadata
   * 3. Emit delete event for old messages
   * 4. Emit summary message to frontend
   */
  private async performCompaction(
    summary: string,
    metadata: {
      model: string;
      usage?: LanguageModelV2Usage;
      duration?: number;
      providerMetadata?: Record<string, unknown>;
      systemMessageTokens?: number;
    },
    messages: MuxMessage[],
    isIdleCompaction = false
  ): Promise<Result<void, string>> {
    // CRITICAL: Delete partial.json BEFORE clearing history
    // This prevents a race condition where:
    // 1. CompactionHandler clears history and appends summary
    // 2. sendQueuedMessages triggers commitToHistory
    // 3. commitToHistory finds stale partial.json and appends it to history
    // By deleting partial first, commitToHistory becomes a no-op
    const deletePartialResult = await this.partialService.deletePartial(this.workspaceId);
    if (!deletePartialResult.success) {
      log.warn(`Failed to delete partial before compaction: ${deletePartialResult.error}`);
      // Continue anyway - the partial may not exist, which is fine
    }

    // Extract diffs BEFORE clearing history (they'll be gone after clear)
    this.cachedFileDiffs = extractEditedFileDiffs(messages);

    // For idle compaction, preserve the original recency timestamp so the workspace
    // doesn't appear "recently used" in the sidebar. Use the shared recency utility
    // to ensure consistency with how the sidebar computes recency.
    let timestamp = Date.now();
    if (isIdleCompaction) {
      const recency = computeRecencyFromMessages(messages);
      if (recency !== null) {
        timestamp = recency;
      }
    }

    // Create summary message with metadata.
    // We omit providerMetadata because it contains cacheCreationInputTokens from the
    // pre-compaction context, which inflates context usage display.
    // Note: We no longer store historicalUsage here. Cumulative costs are tracked in
    // session-usage.json, which is updated on every stream-end. If that file is deleted
    // or corrupted, pre-compaction costs are lost - this is acceptable since manual
    // file deletion is out of scope for data recovery.
    const summaryMessage = createMuxMessage(
      `summary-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
      "assistant",
      summary,
      {
        // Ensures the UI can later delete/replace the summary message (e.g., on /clear).
        // replaceHistory() will normalize sequences starting at 0.
        historySequence: 0,
        timestamp,
        compacted: isIdleCompaction ? "idle" : "user",
        model: metadata.model,
        usage: metadata.usage,
        duration: metadata.duration,
        systemMessageTokens: metadata.systemMessageTokens,
        muxMetadata: { type: "normal" },
      }
    );

    // Emit delete events based on the history we used for compaction.
    //
    // Why not rely on HistoryService.replaceHistory()'s deleted sequences?
    // - The UI currently has these messages in memory (from streaming), so this is the
    //   authoritative list to clear from the transcript.
    // - It avoids edge cases where chat.jsonl parsing skips a malformed trailing line,
    //   resulting in an empty deletedSequences list and a non-updating UI.
    const deletedSequences = messages
      .map((msg) => msg.metadata?.historySequence ?? -1)
      .filter((s) => s >= 0);

    // Atomically replace history with the single summary message.
    // This avoids the "delete then crash" failure mode.
    const replaceResult = await this.historyService.replaceHistory(this.workspaceId, [
      summaryMessage,
    ]);
    if (!replaceResult.success) {
      return Err(`Failed to replace history: ${replaceResult.error}`);
    }

    // Set flag to trigger post-compaction attachment injection on next turn
    this.postCompactionAttachmentsPending = true;

    // Emit delete event for old messages
    if (deletedSequences.length > 0) {
      const deleteMessage: DeleteMessage = {
        type: "delete",
        historySequences: deletedSequences,
      };
      this.emitChatEvent(deleteMessage);
    }

    // Emit summary message to frontend (add type: "message" for discriminated union)
    this.emitChatEvent({ ...summaryMessage, type: "message" });

    return Ok(undefined);
  }

  /**
   * Emit chat event through the session's emitter
   */
  private emitChatEvent(message: WorkspaceChatMessage): void {
    this.emitter.emit("chat-event", {
      workspaceId: this.workspaceId,
      message,
    });
  }
}
