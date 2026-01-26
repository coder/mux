import type { EventEmitter } from "events";
import * as fsPromises from "fs/promises";
import assert from "@/common/utils/assert";
import * as path from "path";

import type { HistoryService } from "./historyService";
import type { PartialService } from "./partialService";

import type { StreamEndEvent } from "@/common/types/stream";
import type { WorkspaceChatMessage, DeleteMessage } from "@/common/orpc/types";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";

import { createMuxMessage, type MuxMessage } from "@/common/types/message";
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

interface CompactionHandlerOptions {
  workspaceId: string;
  historyService: HistoryService;
  partialService: PartialService;
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
 * - Replacing chat history with compacted summaries
 * - Preserving cumulative usage across compactions
 */
export class CompactionHandler {
  private readonly workspaceId: string;
  private readonly historyService: HistoryService;
  private readonly sessionDir: string;
  private readonly postCompactionStatePath: string;
  private persistedPendingStateLoaded = false;
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
    assert(options, "CompactionHandler requires options");
    assert(typeof options.sessionDir === "string", "sessionDir must be a string");
    const trimmedSessionDir = options.sessionDir.trim();
    assert(trimmedSessionDir.length > 0, "sessionDir must not be empty");

    this.workspaceId = options.workspaceId;
    this.historyService = options.historyService;
    this.sessionDir = trimmedSessionDir;
    this.postCompactionStatePath = path.join(trimmedSessionDir, POST_COMPACTION_STATE_FILENAME);
    this.partialService = options.partialService;
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
        error: error instanceof Error ? error.message : String(error),
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

    // Persist pending state BEFORE clearing history so pre-compaction diffs survive crashes/restarts.
    // Best-effort: compaction must not fail just because persistence fails.
    await this.persistPendingStateBestEffort(this.cachedFileDiffs);

    // Clear entire history and get deleted sequences
    const clearResult = await this.historyService.clearHistory(this.workspaceId);
    if (!clearResult.success) {
      // We persist post-compaction state before clearing history for crash safety.
      // If clearHistory fails, the pre-compaction messages are still intact, so keeping the
      // persisted snapshot would cause redundant injection on the next send.
      this.cachedFileDiffs = [];
      await this.deletePersistedPendingStateBestEffort();

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
      createCompactionSummaryMessageId(),
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
