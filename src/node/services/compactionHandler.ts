import type { EventEmitter } from "events";
import type { HistoryService } from "./historyService";
import type { PartialService } from "./partialService";
import type { StreamEndEvent } from "@/common/types/stream";
import type { WorkspaceChatMessage, DeleteMessage } from "@/common/orpc/types";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import { collectUsageHistory } from "@/common/utils/tokens/displayUsage";
import { sumUsageHistory } from "@/common/utils/tokens/usageAggregator";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { log } from "@/node/services/log";

interface CompactionHandlerOptions {
  workspaceId: string;
  historyService: HistoryService;
  partialService: PartialService;
  emitter: EventEmitter;
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
  private readonly emitter: EventEmitter;
  private readonly processedCompactionRequestIds: Set<string> = new Set<string>();

  constructor(options: CompactionHandlerOptions) {
    this.workspaceId = options.workspaceId;
    this.historyService = options.historyService;
    this.partialService = options.partialService;
    this.emitter = options.emitter;
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

    // Mark as processed before performing compaction
    this.processedCompactionRequestIds.add(lastUserMsg.id);

    const result = await this.performCompaction(summary, messages, event.metadata);
    if (!result.success) {
      log.error("Compaction failed:", result.error);
      return false;
    }

    // Emit stream-end to frontend so UI knows compaction is complete
    this.emitChatEvent(event);
    return true;
  }

  /**
   * Perform history compaction by replacing all messages with a summary
   *
   * Steps:
   * 1. Calculate cumulative usage from all messages (for historicalUsage field)
   * 2. Clear entire history and get deleted sequence numbers
   * 3. Append summary message with metadata
   * 4. Emit delete event for old messages
   * 5. Emit summary message to frontend
   */
  private async performCompaction(
    summary: string,
    messages: MuxMessage[],
    metadata: {
      model: string;
      usage?: LanguageModelV2Usage;
      duration?: number;
      providerMetadata?: Record<string, unknown>;
      systemMessageTokens?: number;
    }
  ): Promise<Result<void, string>> {
    const usageHistory = collectUsageHistory(messages, undefined);

    const historicalUsage = usageHistory.length > 0 ? sumUsageHistory(usageHistory) : undefined;

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

    // Clear entire history and get deleted sequences
    const clearResult = await this.historyService.clearHistory(this.workspaceId);
    if (!clearResult.success) {
      return Err(`Failed to clear history: ${clearResult.error}`);
    }
    const deletedSequences = clearResult.data;

    // Create summary message with metadata.
    // We omit providerMetadata because it contains cacheCreationInputTokens from the
    // pre-compaction context, which inflates context usage display. The historicalUsage
    // field preserves full cost accounting from pre-compaction messages.
    const summaryMessage = createMuxMessage(
      `summary-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
      "assistant",
      summary,
      {
        timestamp: Date.now(),
        compacted: true,
        model: metadata.model,
        usage: metadata.usage,
        historicalUsage,
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
