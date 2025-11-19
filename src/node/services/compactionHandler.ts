import type { EventEmitter } from "events";
import type { HistoryService } from "./historyService";
import type { StreamEndEvent, StreamAbortEvent } from "@/common/types/stream";
import type { WorkspaceChatMessage, DeleteMessage } from "@/common/types/ipc";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import { cumUsageHistory } from "@/common/utils/tokens/displayUsage";
import { sumUsageHistory } from "@/common/utils/tokens/usageAggregator";
import { createMuxMessage } from "@/common/types/message";

interface CompactionHandlerOptions {
  workspaceId: string;
  historyService: HistoryService;
  emitter: EventEmitter;
}

/**
 * Handles history compaction for agent sessions
 *
 * Responsible for:
 * - Detecting compaction requests in stream events
 * - Handling Ctrl+C (cancel) and Ctrl+A (accept early) flows
 * - Replacing chat history with compacted summaries
 * - Preserving cumulative usage across compactions
 */
export class CompactionHandler {
  private readonly workspaceId: string;
  private readonly historyService: HistoryService;
  private readonly emitter: EventEmitter;
  private readonly processedIds: Set<string> = new Set<string>();

  constructor(options: CompactionHandlerOptions) {
    this.workspaceId = options.workspaceId;
    this.historyService = options.historyService;
    this.emitter = options.emitter;
  }

  /**
   * Handle compaction stream abort (Ctrl+C cancel or Ctrl+A accept early)
   *
   * Two flows:
   * - Ctrl+C: abandonPartial=true → skip compaction
   * - Ctrl+A: abandonPartial=false/undefined → perform compaction with [truncated]
   */
  async handleAbort(event: StreamAbortEvent): Promise<boolean> {
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

    // Ctrl+C flow: abandonPartial=true means user cancelled, skip compaction
    if (event.abandonPartial === true) {
      return false;
    }

    // Ctrl+A flow: Accept early with [truncated] sentinel
    // Get the truncated message from historyResult.data
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== "assistant") {
      console.warn("[CompactionHandler] Compaction aborted but last message is not assistant");
      return false;
    }

    const partialSummary = lastMessage.parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");

    // Append [truncated] sentinel
    const truncatedSummary = partialSummary.trim() + "\n\n[truncated]";

    // Perform compaction with truncated summary
    const result = await this.performCompaction(truncatedSummary, {
      model: lastMessage.metadata?.model ?? "unknown",
      usage: event.metadata?.usage,
      duration: event.metadata?.duration,
      providerMetadata: lastMessage.metadata?.providerMetadata,
      systemMessageTokens: lastMessage.metadata?.systemMessageTokens,
    });
    if (!result.success) {
      console.error("[CompactionHandler] Early compaction failed:", result.error);
      return false;
    }

    this.emitChatEvent(event);
    return true;
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
    if (this.processedIds.has(lastUserMsg.id)) {
      return true;
    }

    const summary = event.parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");

    // Mark as processed before performing compaction
    this.processedIds.add(lastUserMsg.id);

    const result = await this.performCompaction(summary, event.metadata);
    if (!result.success) {
      console.error("[CompactionHandler] Compaction failed:", result.error);
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
    metadata: {
      model: string;
      usage?: LanguageModelV2Usage;
      duration?: number;
      providerMetadata?: Record<string, unknown>;
      systemMessageTokens?: number;
    }
  ): Promise<Result<void, string>> {
    // Get all messages to calculate cumulative usage
    const historyResult = await this.historyService.getHistory(this.workspaceId);
    if (!historyResult.success) {
      return Err(`Failed to get history for usage calculation: ${historyResult.error}`);
    }

    const usageHistory = cumUsageHistory(historyResult.data, undefined);

    const historicalUsage = usageHistory.length > 0 ? sumUsageHistory(usageHistory) : undefined;

    // Clear entire history and get deleted sequences
    const clearResult = await this.historyService.clearHistory(this.workspaceId);
    if (!clearResult.success) {
      return Err(`Failed to clear history: ${clearResult.error}`);
    }
    const deletedSequences = clearResult.data;

    // Create summary message with metadata
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
        providerMetadata: metadata.providerMetadata,
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

    // Emit summary message to frontend
    this.emitChatEvent(summaryMessage);

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
