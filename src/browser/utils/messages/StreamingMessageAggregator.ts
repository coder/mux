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
import { createDeltaStorage, type DeltaRecordStorage } from "./StreamingTPSCalculator";
import { computeRecencyTimestamp } from "./recency";
import { getStatusUrlKey } from "@/common/constants/storage";

// Maximum number of messages to display in the DOM for performance
// Full history is still maintained internally for token counting and stats
const MAX_DISPLAYED_MESSAGES = 128;

interface StreamingContext {
  startTime: number;
  isComplete: boolean;
  isCompacting: boolean;
  model: string;
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
  private agentStatus: { emoji: string; message: string; url?: string } | undefined = undefined;

  // Last URL set via status_set - persists even when agentStatus is cleared
  // This ensures URL stays available across stream boundaries and through compaction
  // Persisted to localStorage keyed by workspaceId
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

  // Workspace creation timestamp (used for recency calculation)
  // REQUIRED: Backend guarantees every workspace has createdAt via config.ts
  private readonly createdAt: string;

  constructor(createdAt: string, workspaceId?: string) {
    this.createdAt = createdAt;
    this.workspaceId = workspaceId;
    // Load persisted lastStatusUrl from localStorage
    if (workspaceId) {
      this.lastStatusUrl = this.loadLastStatusUrl();
    }
    this.updateRecency();
  }

  /** Load lastStatusUrl from localStorage */
  private loadLastStatusUrl(): string | undefined {
    if (!this.workspaceId) return undefined;
    try {
      const stored = localStorage.getItem(getStatusUrlKey(this.workspaceId));
      return stored ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Persist lastStatusUrl to localStorage.
   * Once set, the URL can only be replaced with a new URL, never deleted.
   */
  private saveLastStatusUrl(url: string): void {
    if (!this.workspaceId) return;
    try {
      localStorage.setItem(getStatusUrlKey(this.workspaceId), url);
    } catch {
      // Ignore localStorage errors
    }
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
  getAgentStatus(): { emoji: string; message: string; url?: string } | undefined {
    return this.agentStatus;
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
   *
   * Does NOT clear:
   * - agentStatus - persists after stream completion to show last activity
   */
  private cleanupStreamState(messageId: string): void {
    this.activeStreams.delete(messageId);
    // Clear todos when stream ends - they're stream-scoped state
    // On reload, todos will be reconstructed from completed tool_write calls in history
    this.currentTodos = [];
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

    // First pass: scan all messages to build up lastStatusUrl from tool calls
    // This ensures URL persistence works even if the URL was set in an earlier message
    // Also persists to localStorage for future loads (survives compaction)
    for (const message of chronologicalMessages) {
      if (message.role === "assistant") {
        for (const part of message.parts) {
          if (
            isDynamicToolPart(part) &&
            part.state === "output-available" &&
            part.toolName === "status_set" &&
            hasSuccessResult(part.output)
          ) {
            const result = part.output as Extract<StatusSetToolResult, { success: true }>;
            if (result.url) {
              this.lastStatusUrl = result.url;
              this.saveLastStatusUrl(result.url);
            }
          }
        }
      }
    }

    // Second pass: reconstruct derived state from the most recent assistant message only
    // (TODOs and agentStatus should reflect only the latest state)
    const lastAssistantMessage = chronologicalMessages.findLast((msg) => msg.role === "assistant");

    if (lastAssistantMessage) {
      // Process all tool results from the most recent assistant message
      // processToolResult will decide what to do based on tool type and context
      for (const part of lastAssistantMessage.parts) {
        if (isDynamicToolPart(part) && part.state === "output-available") {
          this.processToolResult(part.toolName, part.input, part.output, context);
        }
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

    const context: StreamingContext = {
      startTime: Date.now(),
      isComplete: false,
      isCompacting,
      model: data.model,
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
          duration: Date.now() - activeStream.startTime,
        };
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

      // Update lastStatusUrl if a new URL is provided, and persist to localStorage
      if (result.url) {
        this.lastStatusUrl = result.url;
        this.saveLastStatusUrl(result.url);
      }

      // Use the provided URL, or fall back to the last URL ever set
      this.agentStatus = {
        emoji: result.emoji,
        message: result.message,
        url: result.url ?? this.lastStatusUrl,
      };
    }
  }

  handleToolCallEnd(data: ToolCallEndEvent): void {
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
        // Clear derived state (todos, agentStatus) for new conversation turn
        // This ensures consistent behavior whether loading from history or processing live events
        // since stream-start/stream-end events are not persisted in chat.jsonl
        this.currentTodos = [];
        this.agentStatus = undefined;

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

          // Merge adjacent parts of same type (text with text, reasoning with reasoning)
          // This is where all merging happens - streaming just appends raw deltas
          const mergedParts: typeof message.parts = [];
          for (const part of message.parts) {
            const lastMerged = mergedParts[mergedParts.length - 1];

            // Try to merge with last part if same type
            if (lastMerged?.type === "text" && part.type === "text") {
              // Merge text parts, preserving the first timestamp
              mergedParts[mergedParts.length - 1] = {
                type: "text",
                text: lastMerged.text + part.text,
                timestamp: lastMerged.timestamp ?? part.timestamp,
              };
            } else if (lastMerged?.type === "reasoning" && part.type === "reasoning") {
              // Merge reasoning parts, preserving the first timestamp
              mergedParts[mergedParts.length - 1] = {
                type: "reasoning",
                text: lastMerged.text + part.text,
                timestamp: lastMerged.timestamp ?? part.timestamp,
              };
            } else {
              // Different type or tool part - add new part
              mergedParts.push(part);
            }
          }

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
                model: message.metadata?.model,
                timestamp: part.timestamp ?? baseTimestamp,
              });
            } else if (isDynamicToolPart(part)) {
              // Determine status based on part state and result
              let status: "pending" | "executing" | "completed" | "failed" | "interrupted";
              if (part.state === "output-available") {
                // Check if result indicates failure (for tools that return { success: boolean })
                status = hasFailureResult(part.output) ? "failed" : "completed";
              } else if (part.state === "input-available" && message.metadata?.partial) {
                status = "interrupted";
              } else if (part.state === "input-available") {
                status = "executing";
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
