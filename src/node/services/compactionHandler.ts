import type { EventEmitter } from "events";
import * as fsPromises from "fs/promises";
import assert from "@/common/utils/assert";
import * as path from "path";

import type { HistoryService } from "./historyService";

import type { StreamEndEvent } from "@/common/types/stream";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";

import {
  createMuxMessage,
  getCompactionFollowUpContent,
  type CompactionFollowUpRequest,
  type CompactionSummaryMetadata,
  type MuxMessage,
} from "@/common/types/message";
import { createCompactionSummaryMessageId } from "@/node/services/utils/messageIds";
import type { TelemetryService } from "@/node/services/telemetryService";
import { MAX_EDITED_FILES, MAX_FILE_CONTENT_SIZE } from "@/common/constants/attachments";
import { roundToBase2 } from "@/common/telemetry/utils";
import { log } from "@/node/services/log";
import { computeRecencyFromMessages } from "@/common/utils/recency";
import {
  extractEditedFileDiffs,
  type FileEditDiff,
} from "@/common/utils/messages/extractEditedFiles";
import { sliceMessagesFromLatestCompactionBoundary } from "@/common/utils/messages/compactionBoundary";
import { getErrorMessage } from "@/common/utils/errors";

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

const POST_COMPACTION_STATE_FILENAME = "post-compaction.json";

interface PersistedPostCompactionStateV1 {
  version: 1;
  createdAt: number;
  diffs: FileEditDiff[];
}

function coerceFileEditDiffs(value: unknown): FileEditDiff[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const diffs: FileEditDiff[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const filePath = (item as { path?: unknown }).path;
    const diff = (item as { diff?: unknown }).diff;
    const truncated = (item as { truncated?: unknown }).truncated;

    if (typeof filePath !== "string") continue;
    const trimmedPath = filePath.trim();
    if (trimmedPath.length === 0) continue;

    if (typeof diff !== "string") continue;
    if (typeof truncated !== "boolean") continue;

    const clampedDiff =
      diff.length > MAX_FILE_CONTENT_SIZE ? diff.slice(0, MAX_FILE_CONTENT_SIZE) : diff;

    diffs.push({
      path: trimmedPath,
      diff: clampedDiff,
      truncated: truncated || diff.length > MAX_FILE_CONTENT_SIZE,
    });

    if (diffs.length >= MAX_EDITED_FILES) {
      break;
    }
  }

  return diffs;
}

function coercePersistedPostCompactionState(value: unknown): PersistedPostCompactionStateV1 | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const version = (value as { version?: unknown }).version;
  if (version !== 1) {
    return null;
  }

  const createdAt = (value as { createdAt?: unknown }).createdAt;
  if (typeof createdAt !== "number") {
    return null;
  }

  const diffsRaw = (value as { diffs?: unknown }).diffs;
  const diffs = coerceFileEditDiffs(diffsRaw);

  return {
    version: 1,
    createdAt,
    diffs,
  };
}

function hasDurableCompactedMarker(value: unknown): value is true | "user" | "idle" {
  return value === true || value === "user" || value === "idle";
}

function isCompactedSummaryMessage(message: MuxMessage): boolean {
  return hasDurableCompactedMarker(message.metadata?.compacted);
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
  );
}

function getNextCompactionEpoch(messages: MuxMessage[]): number {
  let epochCursor = 0;

  for (const message of messages) {
    const metadata = message.metadata;
    if (!metadata) {
      continue;
    }

    const isCompactedSummary = isCompactedSummaryMessage(message);
    const hasBoundaryMarker = metadata.compactionBoundary === true;
    const epoch = metadata.compactionEpoch;

    if (hasBoundaryMarker && !isCompactedSummary) {
      // Self-healing read path: skip malformed persisted boundary markers.
      // Boundary markers are only valid on compacted summaries.
      log.warn("Skipping malformed compaction boundary while deriving next epoch", {
        messageId: message.id,
        reason: "compactionBoundary set on non-compacted message",
      });
      continue;
    }

    if (!isCompactedSummary) {
      continue;
    }

    if (hasBoundaryMarker) {
      if (!isPositiveInteger(epoch)) {
        // Self-healing read path: invalid boundary metadata should not brick compaction.
        log.warn("Skipping malformed compaction boundary while deriving next epoch", {
          messageId: message.id,
          reason: "compactionBoundary missing positive integer compactionEpoch",
        });
        continue;
      }
      epochCursor = Math.max(epochCursor, epoch);
      continue;
    }

    if (epoch === undefined) {
      // Legacy compacted summaries predate compactionEpoch metadata.
      epochCursor += 1;
      continue;
    }

    if (!isPositiveInteger(epoch)) {
      // Self-healing read path: malformed compactionEpoch should not crash compaction.
      log.warn("Skipping malformed compactionEpoch while deriving next epoch", {
        messageId: message.id,
        reason: "compactionEpoch must be a positive integer when present",
      });
      continue;
    }

    epochCursor = Math.max(epochCursor, epoch);
  }

  const nextEpoch = epochCursor + 1;
  assert(nextEpoch > 0, "next compaction epoch must be positive");
  return nextEpoch;
}

interface CompactionHandlerOptions {
  workspaceId: string;
  historyService: HistoryService;
  sessionDir: string;
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
 * - Appending compacted summaries as durable history boundaries
 * - Preserving cumulative usage across compactions
 */
export class CompactionHandler {
  private readonly workspaceId: string;
  private readonly historyService: HistoryService;
  private readonly sessionDir: string;
  private readonly postCompactionStatePath: string;
  private persistedPendingStateLoaded = false;
  private readonly telemetryService?: TelemetryService;
  private readonly emitter: EventEmitter;
  private readonly processedCompactionRequestIds: Set<string> = new Set<string>();

  private readonly onCompactionComplete?: () => void;

  /** Flag indicating post-compaction attachments should be generated on next turn */
  private postCompactionAttachmentsPending = false;
  /** Cached file diffs extracted from history before appending compaction summary */
  private cachedFileDiffs: FileEditDiff[] = [];

  constructor(options: CompactionHandlerOptions) {
    assert(options, "CompactionHandler requires options");
    assert(typeof options.sessionDir === "string", "sessionDir must be a string");
    const trimmedSessionDir = options.sessionDir.trim();
    assert(trimmedSessionDir.length > 0, "sessionDir must not be empty");

    this.workspaceId = options.workspaceId;
    this.historyService = options.historyService;
    this.sessionDir = trimmedSessionDir;
    this.postCompactionStatePath = path.join(trimmedSessionDir, POST_COMPACTION_STATE_FILENAME);
    this.telemetryService = options.telemetryService;
    this.emitter = options.emitter;
    this.onCompactionComplete = options.onCompactionComplete;
  }

  private async loadPersistedPendingStateIfNeeded(): Promise<void> {
    if (this.persistedPendingStateLoaded || this.postCompactionAttachmentsPending) {
      return;
    }

    this.persistedPendingStateLoaded = true;

    let raw: string;
    try {
      raw = await fsPromises.readFile(this.postCompactionStatePath, "utf-8");
    } catch {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log.warn("Invalid post-compaction state JSON; ignoring", { workspaceId: this.workspaceId });
      await this.deletePersistedPendingStateBestEffort();
      return;
    }

    const state = coercePersistedPostCompactionState(parsed);
    if (!state) {
      log.warn("Invalid post-compaction state schema; ignoring", { workspaceId: this.workspaceId });
      await this.deletePersistedPendingStateBestEffort();
      return;
    }

    // Note: We intentionally do not validate against chat history here.
    // The presence of this file is the source of truth that a compaction occurred (or at least started),
    // and pre-compaction diffs may have been deleted from history.

    this.cachedFileDiffs = state.diffs;
    this.postCompactionAttachmentsPending = true;
  }

  /**
   * Peek pending post-compaction diffs without consuming them.
   * Returns null if no compaction occurred, otherwise returns the cached diffs.
   */
  async peekPendingDiffs(): Promise<FileEditDiff[] | null> {
    if (!this.postCompactionAttachmentsPending) {
      await this.loadPersistedPendingStateIfNeeded();
    }

    if (!this.postCompactionAttachmentsPending) {
      return null;
    }

    return this.cachedFileDiffs;
  }

  /**
   * Acknowledge that pending post-compaction state has been consumed successfully.
   * Clears in-memory state and deletes the persisted snapshot from disk.
   */
  async ackPendingDiffsConsumed(): Promise<void> {
    // If we never loaded persisted state but it exists, clear it anyway.
    if (!this.postCompactionAttachmentsPending && !this.persistedPendingStateLoaded) {
      await this.loadPersistedPendingStateIfNeeded();
    }

    this.postCompactionAttachmentsPending = false;
    this.cachedFileDiffs = [];
    await this.deletePersistedPendingStateBestEffort();
  }

  /**
   * Drop pending post-compaction state (e.g., because it caused context_exceeded).
   */
  async discardPendingDiffs(reason: string): Promise<void> {
    await this.loadPersistedPendingStateIfNeeded();

    if (!this.postCompactionAttachmentsPending) {
      return;
    }

    log.warn("Discarding pending post-compaction state", {
      workspaceId: this.workspaceId,
      reason,
      trackedFiles: this.cachedFileDiffs.length,
    });

    await this.ackPendingDiffsConsumed();
  }

  private async deletePersistedPendingStateBestEffort(): Promise<void> {
    try {
      await fsPromises.unlink(this.postCompactionStatePath);
    } catch {
      // ignore
    }
  }

  private async persistPendingStateBestEffort(diffs: FileEditDiff[]): Promise<void> {
    try {
      await fsPromises.mkdir(this.sessionDir, { recursive: true });

      const persisted: PersistedPostCompactionStateV1 = {
        version: 1,
        createdAt: Date.now(),
        diffs,
      };

      await fsPromises.writeFile(this.postCompactionStatePath, JSON.stringify(persisted));
    } catch (error) {
      log.warn("Failed to persist post-compaction state", {
        workspaceId: this.workspaceId,
        error: getErrorMessage(error),
      });
    }
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
   * and appends a durable compaction boundary message.
   */
  async handleCompletion(event: StreamEndEvent): Promise<boolean> {
    // Check if the last user message is a compaction-request.
    // Only need recent messages — the compaction-request is always near the tail.
    const historyResult = await this.historyService.getLastMessages(this.workspaceId, 10);
    if (!historyResult.success) {
      return false;
    }

    const messages = historyResult.data;
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    const muxMeta = lastUserMsg?.metadata?.muxMetadata;
    const isCompaction = muxMeta?.type === "compaction-request";

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
      // Log detailed part info to help debug why no text was produced
      const partsSummary = event.parts.map((p) => ({
        type: p.type,
        // Include preview for text-like parts to understand what the model produced
        preview: "text" in p && typeof p.text === "string" ? p.text.slice(0, 100) : undefined,
      }));
      log.warn("Compaction summary is empty - aborting compaction to prevent corrupted history", {
        workspaceId: this.workspaceId,
        model: event.metadata.model,
        partsCount: event.parts.length,
        parts: partsSummary,
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
    const isIdleCompaction =
      muxMeta?.type === "compaction-request" && muxMeta.source === "idle-compaction";

    // Extract follow-up content to attach to summary for crash-safe dispatch
    const pendingFollowUp = getCompactionFollowUpContent(muxMeta);

    // Mark as processed before performing compaction
    this.processedCompactionRequestIds.add(lastUserMsg.id);

    // Use boundary-aware read so getNextCompactionEpoch (called inside performCompaction)
    // sees the prior boundary's epoch even if it's beyond the last-10 messages window.
    const boundaryHistoryResult = await this.historyService.getHistoryFromLatestBoundary(
      this.workspaceId
    );
    const messagesForCompaction = boundaryHistoryResult.success
      ? boundaryHistoryResult.data
      : messages; // fallback to last-10 if boundary read fails

    const result = await this.performCompaction(
      summary,
      event.metadata,
      messagesForCompaction,
      event.messageId,
      isIdleCompaction,
      pendingFollowUp
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

    // Emit a sanitized stream-end so UI can close streaming state without
    // re-introducing stale provider metadata from the pre-compaction row.
    this.emitChatEvent(this.sanitizeCompactionStreamEndEvent(event));
    return true;
  }

  private sanitizeCompactionStreamEndEvent(event: StreamEndEvent): StreamEndEvent {
    // Destructure to truly omit fields — setting undefined would create own
    // properties that overwrite the compacted summary's metadata during the
    // frontend's { ...message.metadata, ...data.metadata } merge.
    const { providerMetadata, contextProviderMetadata, contextUsage, timestamp, ...cleanMetadata } =
      event.metadata;

    const sanitizedEvent: StreamEndEvent = {
      ...event,
      metadata: cleanMetadata,
    };

    assert(
      sanitizedEvent.metadata.providerMetadata === undefined &&
        sanitizedEvent.metadata.contextProviderMetadata === undefined &&
        sanitizedEvent.metadata.contextUsage === undefined,
      "Compaction stream-end event must not carry stale provider metadata or context usage"
    );

    return sanitizedEvent;
  }

  private findPersistedStreamSummaryMessage(
    messages: MuxMessage[],
    streamedSummaryMessageId: string
  ): MuxMessage | null {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const candidate = messages[i];
      if (candidate.id !== streamedSummaryMessageId) {
        continue;
      }

      if (candidate.role !== "assistant") {
        // Self-healing read path: persisted message IDs can be corrupted.
        log.warn("Cannot reuse streamed compaction summary with non-assistant role", {
          workspaceId: this.workspaceId,
          messageId: candidate.id,
          role: candidate.role,
        });
        return null;
      }

      const historySequence = candidate.metadata?.historySequence;
      if (!isNonNegativeInteger(historySequence)) {
        // Self-healing read path: invalid sequence means we cannot safely update in-place.
        log.warn("Cannot reuse streamed compaction summary without valid historySequence", {
          workspaceId: this.workspaceId,
          messageId: candidate.id,
          historySequence,
        });
        return null;
      }

      return candidate;
    }

    return null;
  }

  /**
   * Perform history compaction by persisting a durable summary boundary.
   *
   * Steps:
   * 1. Delete partial state to avoid stale partial replay
   * 2. Persist post-compaction attachment state
   * 3. Prefer updating the streamed summary in-place, otherwise append a fallback summary
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
    streamedSummaryMessageId: string,
    isIdleCompaction = false,
    pendingFollowUp?: CompactionFollowUpRequest
  ): Promise<Result<void, string>> {
    assert(summary.trim().length > 0, "performCompaction requires a non-empty summary");
    assert(metadata.model.trim().length > 0, "Compaction summary requires a model");
    assert(
      streamedSummaryMessageId.trim().length > 0,
      "performCompaction requires streamed summary message ID"
    );

    // CRITICAL: Delete partial.json BEFORE persisting compaction summary.
    // This prevents a race condition where:
    // 1. CompactionHandler persists summary
    // 2. sendQueuedMessages triggers commitPartial
    // 3. commitPartial finds stale partial.json and appends it to history
    // By deleting partial first, commitPartial becomes a no-op
    const deletePartialResult = await this.historyService.deletePartial(this.workspaceId);
    if (!deletePartialResult.success) {
      log.warn(`Failed to delete partial before compaction: ${deletePartialResult.error}`);
      // Continue anyway - the partial may not exist, which is fine
    }

    // Extract diffs from the latest compaction epoch only, so append-only history
    // does not re-inject stale pre-boundary edits after subsequent compactions.
    // If boundary markers are malformed, slicing self-heals by falling back to
    // full history instead of crashing or dropping all diffs.
    const latestCompactionEpochMessages = sliceMessagesFromLatestCompactionBoundary(messages);
    this.cachedFileDiffs = extractEditedFileDiffs(latestCompactionEpochMessages);

    // Persist pending state before append so pre-compaction diffs survive crashes/restarts.
    // Best-effort: compaction must not fail just because persistence fails.
    await this.persistPendingStateBestEffort(this.cachedFileDiffs);

    const nextCompactionEpoch = getNextCompactionEpoch(messages);
    assert(Number.isInteger(nextCompactionEpoch), "next compaction epoch must be an integer");

    const maxExistingHistorySequence = messages.reduce((maxSeq, message) => {
      const sequence = message.metadata?.historySequence;
      if (sequence === undefined) {
        return maxSeq;
      }

      if (!isNonNegativeInteger(sequence)) {
        // Self-healing read path: malformed persisted historySequence should not brick compaction.
        log.warn(
          "Ignoring malformed historySequence while deriving compaction monotonicity bound",
          {
            workspaceId: this.workspaceId,
            messageId: message.id,
            historySequence: sequence,
          }
        );
        return maxSeq;
      }

      return Math.max(maxSeq, sequence);
    }, -1);

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
    //
    // The summary's muxMetadata stores the pending follow-up (if any) for crash-safe dispatch.
    // After compaction, agentSession checks if the last message is a summary with pendingFollowUp
    // and dispatches it. The user message persisted by that dispatch serves as proof of completion.
    const summaryMuxMetadata: CompactionSummaryMetadata = {
      type: "compaction-summary",
      pendingFollowUp,
    };

    // StreamManager persists the final assistant message before stream-end.
    // Prefer updating that streamed summary in-place so append-only mode keeps
    // exactly one durable summary message per /compact cycle.
    const persistedStreamSummary = this.findPersistedStreamSummaryMessage(
      messages,
      streamedSummaryMessageId
    );
    const persistedSummaryHistorySequence = persistedStreamSummary?.metadata?.historySequence;

    const summaryMessage = createMuxMessage(
      persistedStreamSummary?.id ?? createCompactionSummaryMessageId(),
      "assistant",
      summary,
      {
        // Do not spread persisted streamed metadata here. Those rows can contain
        // pre-compaction usage/context provider fields that would inflate post-
        // compaction cache/context token displays.
        timestamp,
        compacted: isIdleCompaction ? "idle" : "user",
        compactionEpoch: nextCompactionEpoch,
        compactionBoundary: true,
        model: metadata.model,
        usage: metadata.usage,
        duration: metadata.duration,
        systemMessageTokens: metadata.systemMessageTokens,
        muxMetadata: summaryMuxMetadata,
      }
    );
    if (persistedSummaryHistorySequence !== undefined) {
      summaryMessage.metadata = {
        ...(summaryMessage.metadata ?? {}),
        historySequence: persistedSummaryHistorySequence,
      };
    }

    assert(
      summaryMessage.metadata?.compactionBoundary === true,
      "Compaction summary must be marked as a compaction boundary"
    );
    assert(
      summaryMessage.metadata?.compactionEpoch === nextCompactionEpoch,
      "Compaction summary must persist the computed compaction epoch"
    );
    assert(
      summaryMessage.metadata?.providerMetadata === undefined,
      "Compaction summary must not persist stale providerMetadata"
    );
    assert(
      summaryMessage.metadata?.contextProviderMetadata === undefined,
      "Compaction summary must not persist stale contextProviderMetadata"
    );

    const persistenceResult = persistedStreamSummary
      ? await this.historyService.updateHistory(this.workspaceId, summaryMessage)
      : await this.historyService.appendToHistory(this.workspaceId, summaryMessage);
    if (!persistenceResult.success) {
      this.cachedFileDiffs = [];
      await this.deletePersistedPendingStateBestEffort();
      const operation = persistedStreamSummary ? "update streamed summary" : "append summary";
      return Err(`Failed to ${operation}: ${persistenceResult.error}`);
    }

    const persistedSequence = summaryMessage.metadata?.historySequence;
    assert(
      isNonNegativeInteger(persistedSequence),
      "Compaction summary persistence must produce a non-negative historySequence"
    );
    if (persistedStreamSummary) {
      assert(
        persistedSummaryHistorySequence !== undefined &&
          persistedSequence === persistedSummaryHistorySequence,
        "Compaction summary update must preserve existing historySequence"
      );
    } else if (maxExistingHistorySequence >= 0) {
      assert(
        persistedSequence > maxExistingHistorySequence,
        "Compaction summary historySequence must remain monotonic"
      );
    }

    // Set flag to trigger post-compaction attachment injection on next turn
    this.postCompactionAttachmentsPending = true;

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
