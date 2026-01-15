import type { EventEmitter } from "events";
import type { HistoryService } from "./historyService";
import type { PartialService } from "./partialService";

import type { StreamEndEvent } from "@/common/types/stream";
import type { WorkspaceChatMessage, DeleteMessage } from "@/common/orpc/types";
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

/**
 * Check if a string is just a raw JSON object, which suggests the model
 * tried to output a tool call as text (happens when tools are disabled).
 *
 * A valid compaction summary should be prose text describing the conversation,
 * not a JSON blob. This general check catches any tool that might leak through.
 */
function looksLikeRawJsonObject(text: string): boolean {
  const trimmed = text.trim();

  // Must be a JSON object (not array, not primitive)
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return false;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    // Must parse as a non-null, non-array object
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

import { computeRecencyFromMessages } from "@/common/utils/recency";

interface CompactionHandlerOptions {
  workspaceId: string;
  historyService: HistoryService;
  partialService: PartialService;
  telemetryService?: TelemetryService;
  emitter: EventEmitter;
  /** Called when compaction completes successfully (e.g., to clear idle compaction pending state) */
  onCompactionComplete?: () => void;
}

/**
 * Handles history compaction for agent sessions
 *
 * Responsible for:
 * - Detecting compaction requests in stream events
 * - Replacing chat history with compacted summaries
 * - Preserving cumulative usage across compactions
 */
export class CompactionHandler {
  private readonly workspaceId: string;
  private readonly historyService: HistoryService;
  private readonly partialService: PartialService;
  private readonly telemetryService?: TelemetryService;
  private readonly emitter: EventEmitter;
  private readonly processedCompactionRequestIds: Set<string> = new Set<string>();
  private readonly onCompactionComplete?: () => void;

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
   * Handle compaction stream completion
   *
   * Detects when a compaction stream finishes, extracts the summary,
   * and performs history replacement atomically.
   */
  async handleCompletion(event: StreamEndEvent): Promise<boolean> {
    // Check if the last user message is a compaction-request
    const historyResult = await this.historyService.getHistory(this.workspaceId);
    if (!historyResult.success) {
      return false;
    }

    const messages = historyResult.data;
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    const isCompaction = lastUserMsg?.metadata?.muxMetadata?.type === "compaction-request";

    if (!isCompaction || !lastUserMsg) {
      return false;
    }

    // Dedupe: If we've already processed this compaction-request, skip
    if (this.processedCompactionRequestIds.has(lastUserMsg.id)) {
      return true;
    }

    const summary = event.parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");

    // Self-healing: Reject empty summaries (stream crashed before producing content)
    if (!summary.trim()) {
      log.warn("Compaction summary is empty - aborting compaction to prevent corrupted history", {
        workspaceId: this.workspaceId,
        partsCount: event.parts.length,
      });
      // Don't mark as processed so user can retry
      return false;
    }

    // Self-healing: Reject compaction if summary is just a raw JSON object.
    // This happens when tools are disabled but the model still tries to output a tool call.
    // A valid summary should be prose text, not a JSON blob.
    if (looksLikeRawJsonObject(summary)) {
      log.warn(
        "Compaction summary is a raw JSON object - aborting compaction to prevent corrupted history",
        {
          workspaceId: this.workspaceId,
          summaryPreview: summary.slice(0, 200),
        }
      );
      // Don't mark as processed so user can retry
      return false;
    }

    // Check if this was an idle-compaction (auto-triggered due to inactivity)
    const muxMeta = lastUserMsg.metadata?.muxMetadata;
    const isIdleCompaction =
      muxMeta?.type === "compaction-request" && muxMeta.source === "idle-compaction";

    // Mark as processed before performing compaction
    this.processedCompactionRequestIds.add(lastUserMsg.id);

    const result = await this.performCompaction(
      summary,
      event.metadata,
      messages,
      isIdleCompaction
    );
    if (!result.success) {
      log.error("Compaction failed:", result.error);
      return false;
    }

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
        compaction_source: isIdleCompaction ? "idle" : "manual",
      },
    });

    // Notify that compaction completed (clears idle compaction pending state)
    this.onCompactionComplete?.();

    // Emit stream-end to frontend so UI knows compaction is complete
    this.emitChatEvent(event);
    return true;
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

    // Clear entire history and get deleted sequences
    const clearResult = await this.historyService.clearHistory(this.workspaceId);
    if (!clearResult.success) {
      return Err(`Failed to clear history: ${clearResult.error}`);
    }
    const deletedSequences = clearResult.data;

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
        timestamp,
        compacted: isIdleCompaction ? "idle" : "user",
        model: metadata.model,
        usage: metadata.usage,
        duration: metadata.duration,
        systemMessageTokens: metadata.systemMessageTokens,
        muxMetadata: { type: "normal" },
      }
    );

    // Append summary to history
    const appendResult = await this.historyService.appendToHistory(
      this.workspaceId,
      summaryMessage
    );
    if (!appendResult.success) {
      return Err(`Failed to append summary: ${appendResult.error}`);
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
