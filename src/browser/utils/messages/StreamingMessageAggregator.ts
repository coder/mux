import type {
  MuxMessage,
  MuxMetadata,
  MuxImagePart,
  DisplayedMessage,
  CompactionRequestData,
} from "@/common/types/message";
import { createMuxMessage } from "@/common/types/message";
import type {
  StreamStartEvent,
  StreamDeltaEvent,
  UsageDeltaEvent,
  StreamEndEvent,
  StreamAbortEvent,
  ToolCallStartEvent,
  ToolCallDeltaEvent,
  ToolCallEndEvent,
  ReasoningDeltaEvent,
  ReasoningEndEvent,
} from "@/common/types/stream";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import type { TodoItem, StatusSetToolResult } from "@/common/types/tools";

import type { WorkspaceChatMessage, StreamErrorMessage, DeleteMessage } from "@/common/orpc/types";
import { isInitStart, isInitOutput, isInitEnd, isMuxMessage } from "@/common/orpc/types";
import type {
  DynamicToolPart,
  DynamicToolPartPending,
  DynamicToolPartAvailable,
} from "@/common/types/toolParts";
import { isDynamicToolPart } from "@/common/types/toolParts";
import { z } from "zod";
import { createDeltaStorage, type DeltaRecordStorage } from "./StreamingTPSCalculator";
import { computeRecencyTimestamp } from "./recency";
import { assert } from "@/common/utils/assert";
import { getStatusStateKey } from "@/common/constants/storage";

// Maximum number of messages to display in the DOM for performance
// Full history is still maintained internally for token counting and stats
const AgentStatusSchema = z.object({
  emoji: z.string(),
  message: z.string(),
  url: z.string().optional(),
});

type AgentStatus = z.infer<typeof AgentStatusSchema>;
const MAX_DISPLAYED_MESSAGES = 128;

interface StreamingContext {
  /** Backend timestamp when stream started (Date.now()) */
  serverStartTime: number;
  /**
   * Offset to translate backend timestamps into the renderer clock.
   * Computed as: `Date.now() - lastServerTimestamp`.
   */
  clockOffsetMs: number;
  /** Most recent backend timestamp observed for this stream */
  lastServerTimestamp: number;

  isComplete: boolean;
  isCompacting: boolean;
  model: string;

  /** Timestamp of first content token (text or reasoning delta) - backend Date.now() */
  serverFirstTokenTime: number | null;

  /** Accumulated tool execution time in ms */
  toolExecutionMs: number;
  /** Map of tool call start times for in-progress tool calls (backend timestamps) */
  pendingToolStarts: Map<string, number>;

  /** Mode (plan/exec) */
  mode?: "plan" | "exec";
}

/**
 * Check if a tool result indicates success (for tools that return { success: boolean })
 */
function hasSuccessResult(result: unknown): boolean {
  return (
    typeof result === "object" && result !== null && "success" in result && result.success === true
  );
}

/**
 * Check if a tool result indicates failure.
 * Handles both explicit failure ({ success: false }) and implicit failure ({ error: "..." })
 */
function hasFailureResult(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  // Explicit failure
  if ("success" in result && result.success === false) return true;
  // Implicit failure - error field present
  if ("error" in result && result.error) return true;
  return false;
}

/**
 * Merge adjacent text/reasoning parts using array accumulation + join().
 * Avoids O(n²) string allocations from repeated concatenation.
 * Tool parts are preserved as-is between merged text/reasoning runs.
 */
function mergeAdjacentParts(parts: MuxMessage["parts"]): MuxMessage["parts"] {
  if (parts.length <= 1) return parts;

  const merged: MuxMessage["parts"] = [];
  let pendingTexts: string[] = [];
  let pendingTextTimestamp: number | undefined;
  let pendingReasonings: string[] = [];
  let pendingReasoningTimestamp: number | undefined;

  const flushText = () => {
    if (pendingTexts.length > 0) {
      merged.push({
        type: "text",
        text: pendingTexts.join(""),
        timestamp: pendingTextTimestamp,
      });
      pendingTexts = [];
      pendingTextTimestamp = undefined;
    }
  };

  const flushReasoning = () => {
    if (pendingReasonings.length > 0) {
      merged.push({
        type: "reasoning",
        text: pendingReasonings.join(""),
        timestamp: pendingReasoningTimestamp,
      });
      pendingReasonings = [];
      pendingReasoningTimestamp = undefined;
    }
  };

  for (const part of parts) {
    if (part.type === "text") {
      flushReasoning();
      pendingTexts.push(part.text);
      pendingTextTimestamp ??= part.timestamp;
    } else if (part.type === "reasoning") {
      flushText();
      pendingReasonings.push(part.text);
      pendingReasoningTimestamp ??= part.timestamp;
    } else {
      // Tool part - flush and keep as-is
      flushText();
      flushReasoning();
      merged.push(part);
    }
  }
  flushText();
  flushReasoning();

  return merged;
}

export class StreamingMessageAggregator {
  private messages = new Map<string, MuxMessage>();
  private activeStreams = new Map<string, StreamingContext>();

  // Simple cache for derived values (invalidated on every mutation)
  private cachedAllMessages: MuxMessage[] | null = null;
  private cachedDisplayedMessages: DisplayedMessage[] | null = null;
  private recencyTimestamp: number | null = null;

  // Delta history for token counting and TPS calculation
  private deltaHistory = new Map<string, DeltaRecordStorage>();

  // Active stream usage tracking (updated on each usage-delta event)
  // Consolidates step-level (context window) and cumulative (cost) usage by messageId
  private activeStreamUsage = new Map<
    string,
    {
      // Step-level: this step only (for context window display)
      step: { usage: LanguageModelV2Usage; providerMetadata?: Record<string, unknown> };
      // Cumulative: sum across all steps (for live cost display)
      cumulative: { usage: LanguageModelV2Usage; providerMetadata?: Record<string, unknown> };
    }
  >();

  // Current TODO list (updated when todo_write succeeds, cleared on stream end)
  // Stream-scoped: automatically reset when stream completes
  // On reload: only reconstructed if reconnecting to active stream
  private currentTodos: TodoItem[] = [];

  // Current agent status (updated when status_set is called)
  // Unlike todos, this persists after stream completion to show last activity
  private agentStatus: AgentStatus | undefined = undefined;

  // Last URL set via status_set - kept in memory to reuse when later calls omit url
  private lastStatusUrl: string | undefined = undefined;

  // Workspace ID for localStorage persistence
  private readonly workspaceId: string | undefined;

  // Workspace init hook state (ephemeral, not persisted to history)
  private initState: {
    status: "running" | "success" | "error";
    hookPath: string;
    lines: string[];
    exitCode: number | null;
    timestamp: number;
  } | null = null;

  // Track when we're waiting for stream-start after user message
  // Prevents retry barrier flash during normal send flow
  // Stores timestamp of when user message was sent (null = no pending stream)
  // IMPORTANT: We intentionally keep this timestamp until a stream actually starts
  // (or the user retries) so retry UI/backoff logic doesn't misfire on send failures.
  private pendingStreamStartTime: number | null = null;

  // Last completed stream timing stats (preserved after stream ends for display)
  // Unlike activeStreams, this persists until the next stream starts
  private lastCompletedStreamStats: {
    startTime: number;
    endTime: number;
    firstTokenTime: number | null;
    toolExecutionMs: number;
    model: string;
    outputTokens: number;
    reasoningTokens: number;
    streamingMs: number; // Time from first token to end (for accurate tok/s)
    mode?: "plan" | "exec"; // Mode in which this response occurred
  } | null = null;

  // Session-level timing stats: model -> stats (totals computed on-the-fly)
  private sessionTimingStats: Record<
    string,
    {
      totalDurationMs: number;
      totalToolExecutionMs: number;
      totalTtftMs: number;
      ttftCount: number;
      responseCount: number;
      totalOutputTokens: number;
      totalReasoningTokens: number;
      totalStreamingMs: number; // Cumulative streaming time (for accurate tok/s)
    }
  > = {};

  // Workspace creation timestamp (used for recency calculation)
  // REQUIRED: Backend guarantees every workspace has createdAt via config.ts
  private readonly createdAt: string;

  constructor(createdAt: string, workspaceId?: string) {
    this.createdAt = createdAt;
    this.workspaceId = workspaceId;
    // Load persisted state from localStorage
    if (workspaceId) {
      const persistedStatus = this.loadPersistedAgentStatus();
      if (persistedStatus) {
        this.agentStatus = persistedStatus;
        this.lastStatusUrl = persistedStatus.url;
      }
    }
    this.updateRecency();
  }

  /** Load persisted agent status from localStorage */
  private loadPersistedAgentStatus(): AgentStatus | undefined {
    if (!this.workspaceId) return undefined;
    try {
      const stored = localStorage.getItem(getStatusStateKey(this.workspaceId));
      if (!stored) return undefined;
      const parsed = AgentStatusSchema.safeParse(JSON.parse(stored));
      return parsed.success ? parsed.data : undefined;
    } catch {
      // Ignore localStorage errors or JSON parse failures
    }
    return undefined;
  }

  /** Persist agent status to localStorage */
  private savePersistedAgentStatus(status: AgentStatus): void {
    if (!this.workspaceId) return;
    const parsed = AgentStatusSchema.safeParse(status);
    if (!parsed.success) return;
    try {
      localStorage.setItem(getStatusStateKey(this.workspaceId), JSON.stringify(parsed.data));
    } catch {
      // Ignore localStorage errors
    }
  }

  /** Remove persisted agent status from localStorage */
  private clearPersistedAgentStatus(): void {
    if (!this.workspaceId) return;
    try {
      localStorage.removeItem(getStatusStateKey(this.workspaceId));
    } catch {
      // Ignore localStorage errors
    }
  }

  /** Clear all session timing stats (in-memory only). */
  clearSessionTimingStats(): void {
    this.sessionTimingStats = {};
    this.lastCompletedStreamStats = null;
  }

  private updateStreamClock(context: StreamingContext, serverTimestamp: number): void {
    assert(context, "updateStreamClock requires context");
    assert(typeof serverTimestamp === "number", "updateStreamClock requires serverTimestamp");

    // Only update if this timestamp is >= the most recent one we've seen.
    // During stream replay, older historical parts may be re-emitted out of order.
    //
    // NOTE: This is a display-oriented clock translation (not true synchronization).
    // We refresh the offset whenever we see a newer backend timestamp. If the renderer clock
    // drifts significantly during a very long stream, the translated times may be off by a
    // small amount, which is acceptable for UI stats.
    if (serverTimestamp < context.lastServerTimestamp) {
      return;
    }

    context.lastServerTimestamp = serverTimestamp;
    context.clockOffsetMs = Date.now() - serverTimestamp;
  }

  private translateServerTime(context: StreamingContext, serverTimestamp: number): number {
    assert(context, "translateServerTime requires context");
    assert(typeof serverTimestamp === "number", "translateServerTime requires serverTimestamp");

    return serverTimestamp + context.clockOffsetMs;
  }
  private invalidateCache(): void {
    this.cachedAllMessages = null;
    this.cachedDisplayedMessages = null;
    this.updateRecency();
  }

  /**
   * Recompute and cache recency from current messages.
   * Called automatically when messages change.
   */
  private updateRecency(): void {
    const messages = this.getAllMessages();
    this.recencyTimestamp = computeRecencyTimestamp(messages, this.createdAt);
  }

  /**
   * Get the current recency timestamp (O(1) accessor).
   * Used for workspace sorting by last user interaction.
   */
  getRecencyTimestamp(): number | null {
    return this.recencyTimestamp;
  }

  /**
   * Check if two TODO lists are equal (deep comparison).
   * Prevents unnecessary re-renders when todo_write is called with identical content.
   */
  private todosEqual(a: TodoItem[], b: TodoItem[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((todoA, i) => {
      const todoB = b[i];
      return todoA.content === todoB.content && todoA.status === todoB.status;
    });
  }

  /**
   * Get the current TODO list.
   * Updated whenever todo_write succeeds.
   */
  getCurrentTodos(): TodoItem[] {
    return this.currentTodos;
  }

  /**
   * Get the current agent status.
   * Updated whenever status_set is called.
   * Persists after stream completion (unlike todos).
   */
  getAgentStatus(): AgentStatus | undefined {
    return this.agentStatus;
  }

  /**
   * Check if there's an executing ask_user_question tool awaiting user input.
   * Used to show "Awaiting your input" instead of "streaming..." in the UI.
   */
  hasAwaitingUserQuestion(): boolean {
    // Only treat the workspace as "awaiting input" when the *latest* displayed
    // message is an executing ask_user_question tool.
    //
    // This avoids false positives from stale historical partials if the user
    // continued the chat after skipping/canceling the questions.
    const displayed = this.getDisplayedMessages();
    const last = displayed[displayed.length - 1];

    if (last?.type !== "tool") {
      return false;
    }

    return last.toolName === "ask_user_question" && last.status === "executing";
  }

  /**
   * Extract compaction summary text from a completed assistant message.
   * Used when a compaction stream completes to get the summary for history replacement.
   * @param messageId The ID of the assistant message to extract text from
   * @returns The concatenated text from all text parts, or undefined if message not found
   */
  getCompactionSummary(messageId: string): string | undefined {
    const message = this.messages.get(messageId);
    if (!message) return undefined;

    // Concatenate all text parts (ignore tool calls and reasoning)
    return message.parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");
  }

  /**
   * Clean up stream-scoped state when stream ends (normally or abnormally).
   * Called by handleStreamEnd, handleStreamAbort, and handleStreamError.
   *
   * Clears:
   * - Active stream tracking (this.activeStreams)
   * - Current TODOs (this.currentTodos) - reconstructed from history on reload
   * - Transient agentStatus (from displayStatus) - restored to persisted value
   *
   * Preserves:
   * - lastCompletedStreamStats - timing stats from this stream for display after completion
   */
  private cleanupStreamState(messageId: string): void {
    // Capture timing stats before removing the stream context
    const context = this.activeStreams.get(messageId);
    if (context) {
      const endTime = Date.now();
      const message = this.messages.get(messageId);

      // Prefer backend-provided duration (computed in the same clock domain as tool/delta timestamps).
      // Fall back to renderer-based timing translated into the renderer clock.
      const durationMsFromMetadata = message?.metadata?.duration;
      const fallbackStartTime = this.translateServerTime(context, context.serverStartTime);
      const fallbackDurationMs = Math.max(0, endTime - fallbackStartTime);
      const durationMs =
        typeof durationMsFromMetadata === "number" && Number.isFinite(durationMsFromMetadata)
          ? durationMsFromMetadata
          : fallbackDurationMs;

      const ttftMs =
        context.serverFirstTokenTime !== null
          ? Math.max(0, context.serverFirstTokenTime - context.serverStartTime)
          : null;

      // Get output tokens from cumulative usage (if available)
      const cumulativeUsage = this.activeStreamUsage.get(messageId)?.cumulative.usage;
      const outputTokens = cumulativeUsage?.outputTokens ?? 0;
      const reasoningTokens = cumulativeUsage?.reasoningTokens ?? 0;

      // Account for in-progress tool calls (can happen on abort/error)
      let totalToolExecutionMs = context.toolExecutionMs;
      if (context.pendingToolStarts.size > 0) {
        const serverEndTime = context.serverStartTime + durationMs;
        for (const toolStartTime of context.pendingToolStarts.values()) {
          const toolMs = serverEndTime - toolStartTime;
          if (toolMs > 0) {
            totalToolExecutionMs += toolMs;
          }
        }
      }

      // Streaming duration excludes TTFT and tool execution - used for avg tok/s
      const streamingMs = Math.max(0, durationMs - (ttftMs ?? 0) - totalToolExecutionMs);

      const mode = (message?.metadata?.mode ?? context.mode) as "plan" | "exec" | undefined;

      // Store last completed stream stats (include durations anchored in the renderer clock)
      const startTime = endTime - durationMs;
      const firstTokenTime = ttftMs !== null ? startTime + ttftMs : null;
      this.lastCompletedStreamStats = {
        startTime,
        endTime,
        firstTokenTime,
        toolExecutionMs: totalToolExecutionMs,
        model: context.model,
        outputTokens,
        reasoningTokens,
        streamingMs,
        mode,
      };

      // Use composite key model:mode for per-model+mode stats
      // Old data (no mode) will just use model as key, maintaining backward compat
      const statsKey = mode ? `${context.model}:${mode}` : context.model;

      // Accumulate into per-model stats (totals computed on-the-fly in getSessionTimingStats)
      const modelStats = this.sessionTimingStats[statsKey] ?? {
        totalDurationMs: 0,
        totalToolExecutionMs: 0,
        totalTtftMs: 0,
        ttftCount: 0,
        responseCount: 0,
        totalOutputTokens: 0,
        totalReasoningTokens: 0,
        totalStreamingMs: 0,
      };
      modelStats.totalDurationMs += durationMs;
      modelStats.totalToolExecutionMs += totalToolExecutionMs;
      modelStats.responseCount += 1;
      modelStats.totalOutputTokens += outputTokens;
      modelStats.totalReasoningTokens += reasoningTokens;
      modelStats.totalStreamingMs += streamingMs;
      if (ttftMs !== null) {
        modelStats.totalTtftMs += ttftMs;
        modelStats.ttftCount += 1;
      }
      this.sessionTimingStats[statsKey] = modelStats;
    }

    this.activeStreams.delete(messageId);
    // Clear todos when stream ends - they're stream-scoped state
    // On reload, todos will be reconstructed from completed tool_write calls in history
    this.currentTodos = [];
    // Restore persisted status - clears transient displayStatus, preserves status_set values
    this.agentStatus = this.loadPersistedAgentStatus();
  }

  /**
   * Compact a message's parts array by merging adjacent text/reasoning parts.
   * Called when streaming ends to convert thousands of delta parts into single strings.
   * This reduces memory from O(deltas) small objects to O(content_types) merged objects.
   */
  private compactMessageParts(message: MuxMessage): void {
    message.parts = mergeAdjacentParts(message.parts);
  }

  addMessage(message: MuxMessage): void {
    const existing = this.messages.get(message.id);
    if (existing) {
      const existingParts = Array.isArray(existing.parts) ? existing.parts.length : 0;
      const incomingParts = Array.isArray(message.parts) ? message.parts.length : 0;

      // Prefer richer content when duplicates arrive (e.g., placeholder vs completed message)
      if (incomingParts < existingParts) {
        return;
      }
    }

    // Just store the message - backend assigns historySequence
    this.messages.set(message.id, message);
    this.invalidateCache();
  }

  /**
   * Remove a message from the aggregator.
   * Used for dismissing ephemeral messages like /plan output.
   */
  removeMessage(messageId: string): void {
    if (this.messages.delete(messageId)) {
      this.invalidateCache();
    }
  }

  /**
   * Load historical messages in batch, preserving their historySequence numbers.
   * This is more efficient than calling addMessage() repeatedly.
   *
   * @param messages - Historical messages to load
   * @param hasActiveStream - Whether there's an active stream in buffered events (for reconnection scenario)
   */
  loadHistoricalMessages(messages: MuxMessage[], hasActiveStream = false): void {
    // First, add all messages to the map
    for (const message of messages) {
      this.messages.set(message.id, message);
    }

    // Use "streaming" context if there's an active stream (reconnection), otherwise "historical"
    const context = hasActiveStream ? "streaming" : "historical";

    // Sort messages in chronological order for processing
    const chronologicalMessages = [...messages].sort(
      (a, b) => (a.metadata?.historySequence ?? 0) - (b.metadata?.historySequence ?? 0)
    );

    // Replay historical messages in order to reconstruct derived state
    for (const message of chronologicalMessages) {
      if (message.role === "user") {
        // Mirror live behavior: clear stream-scoped state on new user turn
        // but keep persisted status for fallback on reload.
        this.currentTodos = [];
        this.agentStatus = undefined;
        continue;
      }

      if (message.role === "assistant") {
        for (const part of message.parts) {
          if (isDynamicToolPart(part) && part.state === "output-available") {
            this.processToolResult(part.toolName, part.input, part.output, context);
          }
        }
      }
    }

    // If history was compacted away from the last status_set, fall back to persisted status
    if (!this.agentStatus) {
      const persistedStatus = this.loadPersistedAgentStatus();
      if (persistedStatus) {
        this.agentStatus = persistedStatus;
        this.lastStatusUrl = persistedStatus.url;
      }
    }

    this.invalidateCache();
  }

  getAllMessages(): MuxMessage[] {
    this.cachedAllMessages ??= Array.from(this.messages.values()).sort(
      (a, b) => (a.metadata?.historySequence ?? 0) - (b.metadata?.historySequence ?? 0)
    );
    return this.cachedAllMessages;
  }

  // Efficient methods to check message state without creating arrays
  getMessageCount(): number {
    return this.messages.size;
  }

  hasMessages(): boolean {
    return this.messages.size > 0;
  }

  getPendingStreamStartTime(): number | null {
    return this.pendingStreamStartTime;
  }

  private setPendingStreamStartTime(time: number | null): void {
    this.pendingStreamStartTime = time;
  }

  /**
   * Get timing statistics for the active stream (if any).
   * Returns null if no active stream exists.
   * Includes live token count and TPS for real-time display.
   */
  getActiveStreamTimingStats(): {
    startTime: number;
    firstTokenTime: number | null;
    toolExecutionMs: number;
    model: string;
    /** Live token count from streaming deltas */
    liveTokenCount: number;
    /** Live tokens-per-second (trailing window) */
    liveTPS: number;
    /** Mode (plan/exec) for this stream */
    mode?: "plan" | "exec";
  } | null {
    // Get the first (and typically only) active stream
    const entries = Array.from(this.activeStreams.entries());
    if (entries.length === 0) return null;
    const [messageId, context] = entries[0];

    const now = Date.now();

    const startTime = this.translateServerTime(context, context.serverStartTime);
    const firstTokenTime =
      context.serverFirstTokenTime !== null
        ? this.translateServerTime(context, context.serverFirstTokenTime)
        : null;

    // Include time from currently-executing tools (not just completed ones)
    let totalToolMs = context.toolExecutionMs;
    for (const toolStartServerTime of context.pendingToolStarts.values()) {
      const toolStartTime = this.translateServerTime(context, toolStartServerTime);
      totalToolMs += Math.max(0, now - toolStartTime);
    }

    return {
      startTime,
      firstTokenTime,
      toolExecutionMs: totalToolMs,
      model: context.model,
      liveTokenCount: this.getStreamingTokenCount(messageId),
      liveTPS: this.getStreamingTPS(messageId),
      mode: context.mode,
    };
  }

  /**
   * Get timing statistics from the last completed stream.
   * Returns null if no stream has completed yet in this session.
   * Unlike getActiveStreamTimingStats, this includes endTime and token counts.
   */
  getLastCompletedStreamStats(): {
    startTime: number;
    endTime: number;
    firstTokenTime: number | null;
    toolExecutionMs: number;
    model: string;
    outputTokens: number;
    reasoningTokens: number;
    streamingMs: number;
    mode?: "plan" | "exec";
  } | null {
    return this.lastCompletedStreamStats;
  }

  /**
   * Get aggregate timing statistics across all completed streams in this session.
   * Totals are computed on-the-fly from per-model data.
   * Returns null if no streams have completed yet.
   *
   * Session timing keys use format "model" or "model:mode" (e.g., "claude-opus-4:plan").
   * The byModelAndMode map preserves this structure for mode breakdown display.
   */
  getSessionTimingStats(): {
    totalDurationMs: number;
    totalToolExecutionMs: number;
    totalStreamingMs: number;
    averageTtftMs: number | null;
    responseCount: number;
    totalOutputTokens: number;
    totalReasoningTokens: number;
    /** Per-model timing breakdown (keys are composite: "model" or "model:mode") */
    byModel: Record<
      string,
      {
        totalDurationMs: number;
        totalToolExecutionMs: number;
        totalStreamingMs: number;
        averageTtftMs: number | null;
        responseCount: number;
        totalOutputTokens: number;
        totalReasoningTokens: number;
        /** Mode extracted from composite key, undefined for old data */
        mode?: "plan" | "exec";
      }
    >;
  } | null {
    const modelEntries = Object.entries(this.sessionTimingStats);
    if (modelEntries.length === 0) return null;

    // Aggregate totals from per-model stats
    let totalDurationMs = 0;
    let totalToolExecutionMs = 0;
    let totalStreamingMs = 0;
    let totalTtftMs = 0;
    let ttftCount = 0;
    let responseCount = 0;
    let totalOutputTokens = 0;
    let totalReasoningTokens = 0;

    const byModel: Record<
      string,
      {
        totalDurationMs: number;
        totalToolExecutionMs: number;
        totalStreamingMs: number;
        averageTtftMs: number | null;
        responseCount: number;
        totalOutputTokens: number;
        totalReasoningTokens: number;
        mode?: "plan" | "exec";
      }
    > = {};

    for (const [key, stats] of modelEntries) {
      // Parse composite key: "model" or "model:mode"
      // Model names can contain colons (e.g., "mux-gateway:provider/model")
      // so we look for ":plan" or ":exec" suffix specifically
      let mode: "plan" | "exec" | undefined;
      if (key.endsWith(":plan")) {
        mode = "plan";
      } else if (key.endsWith(":exec")) {
        mode = "exec";
      }

      // Accumulate totals
      totalDurationMs += stats.totalDurationMs;
      totalToolExecutionMs += stats.totalToolExecutionMs;
      totalStreamingMs += stats.totalStreamingMs ?? 0;
      totalTtftMs += stats.totalTtftMs;
      ttftCount += stats.ttftCount;
      responseCount += stats.responseCount;
      totalOutputTokens += stats.totalOutputTokens;
      totalReasoningTokens += stats.totalReasoningTokens;

      // Convert to display format (with computed average)
      // Keep composite key as-is - StatsTab will parse/aggregate as needed
      byModel[key] = {
        totalDurationMs: stats.totalDurationMs,
        totalToolExecutionMs: stats.totalToolExecutionMs,
        totalStreamingMs: stats.totalStreamingMs ?? 0,
        averageTtftMs: stats.ttftCount > 0 ? stats.totalTtftMs / stats.ttftCount : null,
        responseCount: stats.responseCount,
        totalOutputTokens: stats.totalOutputTokens,
        totalReasoningTokens: stats.totalReasoningTokens,
        mode,
      };
    }

    return {
      totalDurationMs,
      totalToolExecutionMs,
      totalStreamingMs,
      averageTtftMs: ttftCount > 0 ? totalTtftMs / ttftCount : null,
      responseCount,
      totalOutputTokens,
      totalReasoningTokens,
      byModel,
    };
  }

  getActiveStreams(): StreamingContext[] {
    return Array.from(this.activeStreams.values());
  }

  /**
   * Get the messageId of the first active stream (for token tracking)
   * Returns undefined if no streams are active
   */
  getActiveStreamMessageId(): string | undefined {
    return this.activeStreams.keys().next().value;
  }

  isCompacting(): boolean {
    for (const context of this.activeStreams.values()) {
      if (context.isCompacting) {
        return true;
      }
    }
    return false;
  }

  getCurrentModel(): string | undefined {
    // If there's an active stream, return its model
    for (const context of this.activeStreams.values()) {
      return context.model;
    }

    // Otherwise, return the model from the most recent assistant message
    const messages = this.getAllMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === "assistant" && message.metadata?.model) {
        return message.metadata.model;
      }
    }

    return undefined;
  }

  clearActiveStreams(): void {
    this.activeStreams.clear();
  }

  clear(): void {
    this.messages.clear();
    this.activeStreams.clear();
    this.invalidateCache();
  }

  /**
   * Remove messages with specific historySequence numbers
   * Used when backend truncates history
   */
  handleDeleteMessage(deleteMsg: DeleteMessage): void {
    const sequencesToDelete = new Set(deleteMsg.historySequences);

    // Remove messages that match the historySequence numbers
    for (const [messageId, message] of this.messages.entries()) {
      const historySeq = message.metadata?.historySequence;
      if (historySeq !== undefined && sequencesToDelete.has(historySeq)) {
        this.messages.delete(messageId);
      }
    }

    this.invalidateCache();
  }

  // Unified event handlers that encapsulate all complex logic
  handleStreamStart(data: StreamStartEvent): void {
    // Clear pending stream start timestamp - stream has started
    this.setPendingStreamStartTime(null);

    // NOTE: We do NOT clear agentStatus or currentTodos here.
    // They are cleared when a new user message arrives (see handleMessage),
    // ensuring consistent behavior whether loading from history or processing live events.

    // Detect if this stream is compacting by checking if last user message is a compaction-request
    const messages = this.getAllMessages();
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    const isCompacting = lastUserMsg?.metadata?.muxMetadata?.type === "compaction-request";

    const now = Date.now();
    const context: StreamingContext = {
      serverStartTime: data.startTime,
      clockOffsetMs: now - data.startTime,
      lastServerTimestamp: data.startTime,
      isComplete: false,
      isCompacting,
      model: data.model,
      serverFirstTokenTime: null,
      toolExecutionMs: 0,
      pendingToolStarts: new Map(),
      mode: data.mode,
    };

    // Use messageId as key - ensures only ONE stream per message
    // If called twice (e.g., during replay), second call safely overwrites first
    this.activeStreams.set(data.messageId, context);

    // Create initial streaming message with empty parts (deltas will append)
    const streamingMessage = createMuxMessage(data.messageId, "assistant", "", {
      historySequence: data.historySequence,
      timestamp: Date.now(),
      model: data.model,
    });

    this.messages.set(data.messageId, streamingMessage);
    this.invalidateCache();
  }

  handleStreamDelta(data: StreamDeltaEvent): void {
    const message = this.messages.get(data.messageId);
    if (!message) return;

    const context = this.activeStreams.get(data.messageId);
    if (context) {
      this.updateStreamClock(context, data.timestamp);

      // Track first token time (only for non-empty deltas)
      if (data.delta.length > 0 && context.serverFirstTokenTime === null) {
        context.serverFirstTokenTime = data.timestamp;
      }
    }

    // Append each delta as a new part (merging happens at display time)
    message.parts.push({
      type: "text",
      text: data.delta,
      timestamp: data.timestamp,
    });

    // Track delta for token counting and TPS calculation
    this.trackDelta(data.messageId, data.tokens, data.timestamp, "text");

    this.invalidateCache();
  }

  handleStreamEnd(data: StreamEndEvent): void {
    // Direct lookup by messageId - O(1) instead of O(n) find
    const activeStream = this.activeStreams.get(data.messageId);

    if (activeStream) {
      // Normal streaming case: we've been tracking this stream from the start
      const message = this.messages.get(data.messageId);
      if (message?.metadata) {
        // Transparent metadata merge - backend fields flow through automatically
        const updatedMetadata: MuxMetadata = {
          ...message.metadata,
          ...data.metadata,
        };

        const durationMs = data.metadata.duration;
        if (typeof durationMs === "number" && Number.isFinite(durationMs)) {
          this.updateStreamClock(activeStream, activeStream.serverStartTime + durationMs);
        }
        message.metadata = updatedMetadata;

        // Update tool parts with their results if provided
        if (data.parts) {
          // Sync up the tool results from the backend's parts array
          for (const backendPart of data.parts) {
            if (backendPart.type === "dynamic-tool" && backendPart.state === "output-available") {
              // Find and update existing tool part
              const toolPart = message.parts.find(
                (part): part is DynamicToolPart =>
                  part.type === "dynamic-tool" && part.toolCallId === backendPart.toolCallId
              );
              if (toolPart) {
                // Update with result from backend
                (toolPart as DynamicToolPartAvailable).output = backendPart.output;
                (toolPart as DynamicToolPartAvailable).state = "output-available";
              }
            }
          }
        }

        // Compact parts to merge adjacent text/reasoning deltas into single strings
        // This reduces memory from thousands of small delta objects to a few merged objects
        this.compactMessageParts(message);
      }

      // Clean up stream-scoped state (active stream tracking, TODOs)
      this.cleanupStreamState(data.messageId);
    } else {
      // Reconnection case: user reconnected after stream completed
      // We reconstruct the entire message from the stream-end event
      // The backend now sends us the parts array with proper temporal ordering
      // Backend MUST provide historySequence in metadata

      // Create the complete message
      const message: MuxMessage = {
        id: data.messageId,
        role: "assistant",
        metadata: {
          ...data.metadata,
          timestamp: data.metadata.timestamp ?? Date.now(),
        },
        parts: data.parts,
      };

      this.messages.set(data.messageId, message);

      // Clean up stream-scoped state (active stream tracking, TODOs)
      this.cleanupStreamState(data.messageId);
    }
    this.invalidateCache();
  }

  handleStreamAbort(data: StreamAbortEvent): void {
    // Direct lookup by messageId
    const activeStream = this.activeStreams.get(data.messageId);

    if (activeStream) {
      // Mark the message as interrupted and merge metadata (consistent with handleStreamEnd)
      const message = this.messages.get(data.messageId);
      if (message?.metadata) {
        message.metadata = {
          ...message.metadata,
          partial: true,
          ...data.metadata, // Spread abort metadata (usage, duration)
        };

        // Compact parts even on abort - still reduces memory for partial messages
        this.compactMessageParts(message);
      }

      // Clean up stream-scoped state (active stream tracking, TODOs)
      this.cleanupStreamState(data.messageId);
      this.invalidateCache();
    }
  }

  handleStreamError(data: StreamErrorMessage): void {
    // Direct lookup by messageId
    const activeStream = this.activeStreams.get(data.messageId);

    if (activeStream) {
      // Mark the message with error metadata
      const message = this.messages.get(data.messageId);
      if (message?.metadata) {
        message.metadata.partial = true;
        message.metadata.error = data.error;
        message.metadata.errorType = data.errorType;

        // Compact parts even on error - still reduces memory for partial messages
        this.compactMessageParts(message);
      }

      // Clean up stream-scoped state (active stream tracking, TODOs)
      this.cleanupStreamState(data.messageId);
      this.invalidateCache();
    } else {
      // Pre-stream error (e.g., API key not configured before streaming starts)
      // Create a synthetic error message since there's no active stream to attach to
      // Get the highest historySequence from existing messages so this appears at the end
      const maxSequence = Math.max(
        0,
        ...Array.from(this.messages.values()).map((m) => m.metadata?.historySequence ?? 0)
      );
      const errorMessage: MuxMessage = {
        id: data.messageId,
        role: "assistant",
        parts: [],
        metadata: {
          partial: true,
          error: data.error,
          errorType: data.errorType,
          timestamp: Date.now(),
          historySequence: maxSequence + 1,
        },
      };
      this.messages.set(data.messageId, errorMessage);
      this.invalidateCache();
    }
  }

  handleToolCallStart(data: ToolCallStartEvent): void {
    const message = this.messages.get(data.messageId);
    if (!message) return;

    // Check if this tool call already exists to prevent duplicates
    const existingToolPart = message.parts.find(
      (part): part is DynamicToolPart =>
        part.type === "dynamic-tool" && part.toolCallId === data.toolCallId
    );

    if (existingToolPart) {
      console.warn(`Tool call ${data.toolCallId} already exists, skipping duplicate`);
      return;
    }

    // Track tool start time for execution duration calculation
    const context = this.activeStreams.get(data.messageId);
    if (context) {
      this.updateStreamClock(context, data.timestamp);
      context.pendingToolStarts.set(data.toolCallId, data.timestamp);
    }

    // Add tool part to maintain temporal order
    const toolPart: DynamicToolPartPending = {
      type: "dynamic-tool",
      toolCallId: data.toolCallId,
      toolName: data.toolName,
      state: "input-available",
      input: data.args,
      timestamp: data.timestamp,
    };
    message.parts.push(toolPart as never);

    // Track tokens for tool input
    this.trackDelta(data.messageId, data.tokens, data.timestamp, "tool-args");

    this.invalidateCache();
  }

  handleToolCallDelta(data: ToolCallDeltaEvent): void {
    // Track delta for token counting and TPS calculation
    this.trackDelta(data.messageId, data.tokens, data.timestamp, "tool-args");
    // Tool deltas are for display - args are in dynamic-tool part
  }

  /**
   * Process a completed tool call's result to update derived state.
   * Called for both live tool-call-end events and historical tool parts.
   *
   * This is the single source of truth for updating state from tool results,
   * ensuring consistency whether processing live events or historical messages.
   *
   * @param toolName - Name of the tool that was called
   * @param input - Tool input arguments
   * @param output - Tool output result
   * @param context - Whether this is from live streaming or historical reload
   */
  private processToolResult(
    toolName: string,
    input: unknown,
    output: unknown,
    context: "streaming" | "historical"
  ): void {
    // Update TODO state if this was a successful todo_write
    // TODOs are stream-scoped: only update during live streaming, not on historical reload
    if (toolName === "todo_write" && hasSuccessResult(output) && context === "streaming") {
      const args = input as { todos: TodoItem[] };
      // Only update if todos actually changed (prevents flickering from reference changes)
      if (!this.todosEqual(this.currentTodos, args.todos)) {
        this.currentTodos = args.todos;
      }
    }

    // Update agent status if this was a successful status_set
    // agentStatus persists: update both during streaming and on historical reload
    // Use output instead of input to get the truncated message
    if (toolName === "status_set" && hasSuccessResult(output)) {
      const result = output as Extract<StatusSetToolResult, { success: true }>;

      // Use the provided URL, or fall back to the last URL ever set
      const url = result.url ?? this.lastStatusUrl;
      if (url) {
        this.lastStatusUrl = url;
      }

      this.agentStatus = {
        emoji: result.emoji,
        message: result.message,
        url,
      };
      this.savePersistedAgentStatus(this.agentStatus);
    }
  }

  handleToolCallEnd(data: ToolCallEndEvent): void {
    // Track tool execution duration
    const context = this.activeStreams.get(data.messageId);
    if (context) {
      this.updateStreamClock(context, data.timestamp);

      const startTime = context.pendingToolStarts.get(data.toolCallId);
      if (startTime !== undefined) {
        context.toolExecutionMs += data.timestamp - startTime;
        context.pendingToolStarts.delete(data.toolCallId);
      }
    }

    const message = this.messages.get(data.messageId);
    if (message) {
      // Find the specific tool part by its ID and update it with the result
      // We don't move it - it stays in its original temporal position
      const toolPart = message.parts.find(
        (part): part is DynamicToolPart =>
          part.type === "dynamic-tool" && part.toolCallId === data.toolCallId
      );
      if (toolPart) {
        // Type assertion needed because TypeScript can't narrow the discriminated union
        (toolPart as DynamicToolPartAvailable).state = "output-available";
        (toolPart as DynamicToolPartAvailable).output = data.result;

        // Process tool result to update derived state (todos, agentStatus, etc.)
        // This is from a live stream, so use "streaming" context
        this.processToolResult(data.toolName, toolPart.input, data.result, "streaming");
      }
      this.invalidateCache();
    }
  }

  handleReasoningDelta(data: ReasoningDeltaEvent): void {
    const message = this.messages.get(data.messageId);
    if (!message) return;

    const context = this.activeStreams.get(data.messageId);
    if (context) {
      this.updateStreamClock(context, data.timestamp);

      // Track first token time (reasoning also counts as first token)
      if (data.delta.length > 0 && context.serverFirstTokenTime === null) {
        context.serverFirstTokenTime = data.timestamp;
      }
    }

    // Append each delta as a new part (merging happens at display time)
    message.parts.push({
      type: "reasoning",
      text: data.delta,
      timestamp: data.timestamp,
    });

    // Track delta for token counting and TPS calculation
    this.trackDelta(data.messageId, data.tokens, data.timestamp, "reasoning");

    this.invalidateCache();
  }

  handleReasoningEnd(_data: ReasoningEndEvent): void {
    // Reasoning-end is just a signal - no state to update
    // Streaming status is inferred from activeStreams in getDisplayedMessages
    this.invalidateCache();
  }

  handleMessage(data: WorkspaceChatMessage): void {
    // Handle init hook events (ephemeral, not persisted to history)
    if (isInitStart(data)) {
      this.initState = {
        status: "running",
        hookPath: data.hookPath,
        lines: [],
        exitCode: null,
        timestamp: data.timestamp,
      };
      this.invalidateCache();
      return;
    }

    if (isInitOutput(data)) {
      if (!this.initState) {
        console.error("Received init-output without init-start", { data });
        return;
      }
      if (!data.line) {
        console.error("Received init-output with missing line field", { data });
        return;
      }
      const line = data.isError ? `ERROR: ${data.line}` : data.line;
      // Extra defensive check (should never hit due to check above, but prevents crash if data changes)
      if (typeof line !== "string") {
        console.error("Init-output line is not a string", { line, data });
        return;
      }
      this.initState.lines.push(line.trimEnd());
      this.invalidateCache();
      return;
    }

    if (isInitEnd(data)) {
      if (!this.initState) {
        console.error("Received init-end without init-start", { data });
        return;
      }
      this.initState.exitCode = data.exitCode;
      this.initState.status = data.exitCode === 0 ? "success" : "error";
      this.invalidateCache();
      return;
    }

    // Handle regular messages (user messages, historical messages)
    // Check if it's a MuxMessage (has role property but no type)
    if (isMuxMessage(data)) {
      const incomingMessage = data;

      // Smart replacement logic for edits:
      // If a message arrives with a historySequence that already exists,
      // it means history was truncated (edit operation). Remove the existing
      // message at that sequence and all subsequent messages, then add the new one.
      const incomingSequence = incomingMessage.metadata?.historySequence;
      if (incomingSequence !== undefined) {
        // Check if there's already a message with this sequence
        for (const [_id, msg] of this.messages.entries()) {
          const existingSequence = msg.metadata?.historySequence;
          if (existingSequence !== undefined && existingSequence >= incomingSequence) {
            // Found a conflict - remove this message and all after it
            const messagesToRemove: string[] = [];
            for (const [removeId, removeMsg] of this.messages.entries()) {
              const removeSeq = removeMsg.metadata?.historySequence;
              if (removeSeq !== undefined && removeSeq >= incomingSequence) {
                messagesToRemove.push(removeId);
              }
            }
            for (const removeId of messagesToRemove) {
              this.messages.delete(removeId);
            }
            break; // Found and handled the conflict
          }
        }
      }

      // Now add the new message
      this.addMessage(incomingMessage);

      // If this is a user message, clear derived state and record timestamp
      if (incomingMessage.role === "user") {
        const muxMeta = incomingMessage.metadata?.muxMetadata as
          | { displayStatus?: { emoji: string; message: string } }
          | undefined;

        // Always clear todos (stream-scoped state)
        this.currentTodos = [];

        if (muxMeta?.displayStatus) {
          // Background operation - show requested status (don't persist)
          this.agentStatus = muxMeta.displayStatus;
        } else {
          // Normal user turn - clear status
          this.agentStatus = undefined;
          this.clearPersistedAgentStatus();
        }

        this.setPendingStreamStartTime(Date.now());
      }
    }
  }

  /**
   * Transform MuxMessages into DisplayedMessages for UI consumption
   * This splits complex messages with multiple parts into separate UI blocks
   * while preserving temporal ordering through sequence numbers
   *
   * IMPORTANT: Result is cached to ensure stable references for React.
   * Cache is invalidated whenever messages change (via invalidateCache()).
   */
  getDisplayedMessages(): DisplayedMessage[] {
    if (!this.cachedDisplayedMessages) {
      const displayedMessages: DisplayedMessage[] = [];
      const allMessages = this.getAllMessages();

      for (const message of allMessages) {
        // Skip synthetic messages - they're for model context only, not UI display
        if (message.metadata?.synthetic) {
          continue;
        }

        const baseTimestamp = message.metadata?.timestamp;
        // Get historySequence from backend (required field)
        const historySequence = message.metadata?.historySequence ?? 0;

        // Check for plan-display messages (ephemeral /plan output)
        const muxMeta = message.metadata?.muxMetadata;
        if (muxMeta?.type === "plan-display") {
          const content = message.parts
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("");
          displayedMessages.push({
            type: "plan-display",
            id: message.id,
            historyId: message.id,
            content,
            path: muxMeta.path,
            historySequence,
          });
          continue;
        }

        if (message.role === "user") {
          // User messages: combine all text parts into single block, extract images
          const content = message.parts
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("");

          const imageParts = message.parts
            .filter((p): p is MuxImagePart => {
              // Accept both new "file" type and legacy "image" type (from before PR #308)
              // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
              return p.type === "file" || (p as any).type === "image";
            })
            .map((p) => ({
              url: typeof p.url === "string" ? p.url : "",
              mediaType: p.mediaType,
            }));

          // Check if this is a compaction request message
          const muxMeta = message.metadata?.muxMetadata;
          const compactionRequest =
            muxMeta?.type === "compaction-request"
              ? {
                  rawCommand: muxMeta.rawCommand,
                  parsed: {
                    model: muxMeta.parsed.model,
                    maxOutputTokens: muxMeta.parsed.maxOutputTokens,
                    continueMessage: muxMeta.parsed.continueMessage,
                  } satisfies CompactionRequestData,
                }
              : undefined;

          // Extract reviews from muxMetadata for rich UI display (orthogonal to message type)
          const reviews = muxMeta?.reviews;

          displayedMessages.push({
            type: "user",
            id: message.id,
            historyId: message.id,
            content: compactionRequest ? compactionRequest.rawCommand : content,
            imageParts: imageParts.length > 0 ? imageParts : undefined,
            historySequence,
            timestamp: baseTimestamp,
            compactionRequest,
            reviews,
          });
        } else if (message.role === "assistant") {
          // Assistant messages: each part becomes a separate DisplayedMessage
          // Use streamSequence to order parts within this message
          let streamSeq = 0;

          // Check if this message has an active stream (for inferring streaming status)
          // Direct Map.has() check - O(1) instead of O(n) iteration
          const hasActiveStream = this.activeStreams.has(message.id);

          // Merge adjacent text/reasoning parts for display
          const mergedParts = mergeAdjacentParts(message.parts);

          // Find the last part that will produce a DisplayedMessage
          // (reasoning, text parts with content, OR tool parts)
          let lastPartIndex = -1;
          for (let i = mergedParts.length - 1; i >= 0; i--) {
            const part = mergedParts[i];
            if (
              part.type === "reasoning" ||
              (part.type === "text" && part.text) ||
              isDynamicToolPart(part)
            ) {
              lastPartIndex = i;
              break;
            }
          }

          mergedParts.forEach((part, partIndex) => {
            const isLastPart = partIndex === lastPartIndex;
            // Part is streaming if: active stream exists AND this is the last part
            const isStreaming = hasActiveStream && isLastPart;

            if (part.type === "reasoning") {
              // Reasoning part - shows thinking/reasoning content
              displayedMessages.push({
                type: "reasoning",
                id: `${message.id}-${partIndex}`,
                historyId: message.id,
                content: part.text,
                historySequence,
                streamSequence: streamSeq++,
                isStreaming,
                isPartial: message.metadata?.partial ?? false,
                isLastPartOfMessage: isLastPart,
                timestamp: part.timestamp ?? baseTimestamp,
              });
            } else if (part.type === "text" && part.text) {
              // Skip empty text parts
              displayedMessages.push({
                type: "assistant",
                id: `${message.id}-${partIndex}`,
                historyId: message.id,
                content: part.text,
                historySequence,
                streamSequence: streamSeq++,
                isStreaming,
                isPartial: message.metadata?.partial ?? false,
                isLastPartOfMessage: isLastPart,
                isCompacted: message.metadata?.compacted ?? false,
                isIdleCompacted: message.metadata?.idleCompacted ?? false,
                model: message.metadata?.model,
                timestamp: part.timestamp ?? baseTimestamp,
              });
            } else if (isDynamicToolPart(part)) {
              // Determine status based on part state and result
              let status: "pending" | "executing" | "completed" | "failed" | "interrupted";
              if (part.state === "output-available") {
                // Check if result indicates failure (for tools that return { success: boolean })
                status = hasFailureResult(part.output) ? "failed" : "completed";
              } else if (part.state === "input-available") {
                // Most unfinished tool calls in partial messages represent an interruption.
                // ask_user_question is different: it's intentionally waiting on user input,
                // so after restart we should keep it answerable ("executing") instead of
                // showing retry/auto-resume UX.
                if (part.toolName === "ask_user_question") {
                  status = "executing";
                } else if (message.metadata?.partial) {
                  status = "interrupted";
                } else {
                  status = "executing";
                }
              } else {
                status = "pending";
              }

              displayedMessages.push({
                type: "tool",
                id: `${message.id}-${partIndex}`,
                historyId: message.id,
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                args: part.input,
                result: part.state === "output-available" ? part.output : undefined,
                status,
                isPartial: message.metadata?.partial ?? false,
                historySequence,
                streamSequence: streamSeq++,
                isLastPartOfMessage: isLastPart,
                timestamp: part.timestamp ?? baseTimestamp,
              });
            }
          });

          // Create stream-error DisplayedMessage if message has error metadata
          // This happens after all parts are displayed, so error appears at the end
          if (message.metadata?.error) {
            displayedMessages.push({
              type: "stream-error",
              id: `${message.id}-error`,
              historyId: message.id,
              error: message.metadata.error,
              errorType: message.metadata.errorType ?? "unknown",
              historySequence,
              model: message.metadata.model,
              timestamp: baseTimestamp,
            });
          }
        }
      }

      // Add init state if present (ephemeral, appears at top)
      if (this.initState) {
        const initMessage: DisplayedMessage = {
          type: "workspace-init",
          id: "workspace-init",
          historySequence: -1, // Appears before all history
          status: this.initState.status,
          hookPath: this.initState.hookPath,
          lines: [...this.initState.lines], // Shallow copy for React.memo change detection
          exitCode: this.initState.exitCode,
          timestamp: this.initState.timestamp,
        };
        displayedMessages.unshift(initMessage);
      }

      // Limit to last N messages for DOM performance
      // Full history is still maintained internally for token counting
      if (displayedMessages.length > MAX_DISPLAYED_MESSAGES) {
        const hiddenCount = displayedMessages.length - MAX_DISPLAYED_MESSAGES;
        const slicedMessages = displayedMessages.slice(-MAX_DISPLAYED_MESSAGES);

        // Add history-hidden indicator as the first message
        const historyHiddenMessage: DisplayedMessage = {
          type: "history-hidden",
          id: "history-hidden",
          hiddenCount,
          historySequence: -1, // Place it before all messages
        };

        return [historyHiddenMessage, ...slicedMessages];
      }

      // Return the full array
      this.cachedDisplayedMessages = displayedMessages;
    }
    return this.cachedDisplayedMessages;
  }

  /**
   * Track a delta for token counting and TPS calculation
   */
  private trackDelta(
    messageId: string,
    tokens: number,
    timestamp: number,
    type: "text" | "reasoning" | "tool-args"
  ): void {
    let storage = this.deltaHistory.get(messageId);
    if (!storage) {
      storage = createDeltaStorage();
      this.deltaHistory.set(messageId, storage);
    }
    storage.addDelta({ tokens, timestamp, type });
  }

  /**
   * Get streaming token count (sum of all deltas)
   */
  getStreamingTokenCount(messageId: string): number {
    const storage = this.deltaHistory.get(messageId);
    return storage ? storage.getTokenCount() : 0;
  }

  /**
   * Get tokens-per-second rate (10-second trailing window)
   */
  getStreamingTPS(messageId: string): number {
    const storage = this.deltaHistory.get(messageId);
    return storage ? storage.calculateTPS(Date.now()) : 0;
  }

  /**
   * Clear delta history for a message
   */
  clearTokenState(messageId: string): void {
    this.deltaHistory.delete(messageId);
    this.activeStreamUsage.delete(messageId);
  }

  /**
   * Handle usage-delta event: update usage tracking for active stream
   */
  handleUsageDelta(data: UsageDeltaEvent): void {
    this.activeStreamUsage.set(data.messageId, {
      step: { usage: data.usage, providerMetadata: data.providerMetadata },
      cumulative: {
        usage: data.cumulativeUsage,
        providerMetadata: data.cumulativeProviderMetadata,
      },
    });
  }

  /**
   * Get active stream usage for context window display (last step's inputTokens = context size)
   */
  getActiveStreamUsage(messageId: string): LanguageModelV2Usage | undefined {
    return this.activeStreamUsage.get(messageId)?.step.usage;
  }

  /**
   * Get step provider metadata for context window cache display
   */
  getActiveStreamStepProviderMetadata(messageId: string): Record<string, unknown> | undefined {
    return this.activeStreamUsage.get(messageId)?.step.providerMetadata;
  }

  /**
   * Get active stream cumulative usage for cost display (sum of all steps)
   */
  getActiveStreamCumulativeUsage(messageId: string): LanguageModelV2Usage | undefined {
    return this.activeStreamUsage.get(messageId)?.cumulative.usage;
  }

  /**
   * Get cumulative provider metadata for cost display (with accumulated cache creation tokens)
   */
  getActiveStreamCumulativeProviderMetadata(
    messageId: string
  ): Record<string, unknown> | undefined {
    return this.activeStreamUsage.get(messageId)?.cumulative.providerMetadata;
  }
}
