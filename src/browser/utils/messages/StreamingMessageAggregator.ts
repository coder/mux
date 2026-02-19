import type {
  MuxMessage,
  MuxMetadata,
  MuxFilePart,
  DisplayedMessage,
  CompactionRequestData,
  MuxFrontendMetadata,
} from "@/common/types/message";
import { createMuxMessage, getCompactionFollowUpContent } from "@/common/types/message";

import type {
  StreamStartEvent,
  StreamDeltaEvent,
  UsageDeltaEvent,
  StreamEndEvent,
  StreamAbortEvent,
  StreamAbortReasonSnapshot,
  ToolCallStartEvent,
  ToolCallDeltaEvent,
  ToolCallEndEvent,
  ReasoningDeltaEvent,
  ReasoningEndEvent,
  RuntimeStatusEvent,
} from "@/common/types/stream";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import type { TodoItem, StatusSetToolResult, NotifyToolResult } from "@/common/types/tools";
import { getToolOutputUiOnly } from "@/common/utils/tools/toolOutputUiOnly";

import { computePriorHistoryFingerprint } from "@/common/orpc/onChatCursorFingerprint";
import type {
  WorkspaceChatMessage,
  StreamErrorMessage,
  DeleteMessage,
  OnChatCursor,
} from "@/common/orpc/types";
import { isInitStart, isInitOutput, isInitEnd, isMuxMessage } from "@/common/orpc/types";
import type {
  DynamicToolPart,
  DynamicToolPartPending,
  DynamicToolPartAvailable,
} from "@/common/types/toolParts";
import type { AgentSkillDescriptor, AgentSkillScope } from "@/common/types/agentSkill";
import { INIT_HOOK_MAX_LINES } from "@/common/constants/toolLimits";
import { isDynamicToolPart } from "@/common/types/toolParts";
import { z } from "zod";
import { createDeltaStorage, type DeltaRecordStorage } from "./StreamingTPSCalculator";
import { buildTranscriptTruncationPlan } from "./transcriptTruncationPlan";
import { computeRecencyTimestamp } from "./recency";
import { assert } from "@/common/utils/assert";
import { getStatusStateKey } from "@/common/constants/storage";
import { getFollowUpContentText } from "@/browser/utils/compaction/format";

// Maximum number of messages to display in the DOM for performance
// Full history is still maintained internally for token counting and stats
const AgentStatusSchema = z.object({
  emoji: z.string(),
  message: z.string(),
  url: z.string().optional(),
});

// Synthetic agent-skill snapshot messages include metadata.agentSkillSnapshot.
// We use this to keep the SkillIndicator in sync for /{skillName} invocations.
const AgentSkillSnapshotMetadataSchema = z.object({
  skillName: z.string().min(1),
  scope: z.enum(["project", "global", "built-in"]),
  sha256: z.string().optional(),
  frontmatterYaml: z.string().optional(),
});

/** Re-export for consumers that need the loaded skill type */
export type LoadedSkill = AgentSkillDescriptor;

/** A runtime skill load failure (agent_skill_read returned { success: false }) */
export interface SkillLoadError {
  /** Skill name that was requested */
  name: string;
  /** Error message from the backend */
  error: string;
}

type AgentStatus = z.infer<typeof AgentStatusSchema>;

/**
 * Maximum number of DisplayedMessages to render before truncation kicks in.
 * We keep all user prompts and structural markers, while allowing older assistant
 * content to collapse behind history-hidden markers for faster initial paint.
 */
const MAX_DISPLAYED_MESSAGES = 64;

/**
 * Message types that are always preserved even in truncated history.
 * Older assistant/tool/reasoning rows may be omitted until the user clicks “Load all”.
 */
const ALWAYS_KEEP_MESSAGE_TYPES = new Set<DisplayedMessage["type"]>([
  "user",
  "stream-error",
  "compaction-boundary",
  "plan-display",
  "workspace-init",
]);

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
  hasCompactionContinue: boolean;
  isReplay: boolean;
  model: string;
  routedThroughGateway?: boolean;

  /** Timestamp of first content token (text or reasoning delta) - backend Date.now() */
  serverFirstTokenTime: number | null;

  /** Accumulated tool execution time in ms */
  toolExecutionMs: number;
  /** Map of tool call start times for in-progress tool calls (backend timestamps) */
  pendingToolStarts: Map<string, number>;

  /** Mode (plan/exec) */
  mode?: string;

  /** Effective thinking level after model policy clamping */
  thinkingLevel?: string;
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

function extractAgentSkillSnapshotBody(snapshotText: string): string | null {
  assert(typeof snapshotText === "string", "extractAgentSkillSnapshotBody requires snapshotText");

  // Expected format (backend):
  // <agent-skill ...>\n{body}\n</agent-skill>
  if (!snapshotText.startsWith("<agent-skill")) {
    return null;
  }

  const openTagEnd = snapshotText.indexOf(">\n");
  if (openTagEnd === -1) {
    return null;
  }

  const closeTag = "\n</agent-skill>";
  const closeTagStart = snapshotText.lastIndexOf(closeTag);
  if (closeTagStart === -1) {
    return null;
  }

  const bodyStart = openTagEnd + ">\n".length;
  if (closeTagStart < bodyStart) {
    return null;
  }

  // Be strict about trailing content: if we can't confidently extract the body,
  // avoid showing a misleading preview.
  const trailing = snapshotText.slice(closeTagStart + closeTag.length);
  if (trailing.trim().length > 0) {
    return null;
  }

  return snapshotText.slice(bodyStart, closeTagStart);
}

export class StreamingMessageAggregator {
  private messages = new Map<string, MuxMessage>();
  private activeStreams = new Map<string, StreamingContext>();

  // Derived value cache - invalidated as a unit on every mutation.
  // Adding a new cached value? Add it here and it will auto-invalidate.
  private displayedMessageCache = new Map<
    string,
    { version: number; agentSkillSnapshotCacheKey?: string; messages: DisplayedMessage[] }
  >();
  private messageVersions = new Map<string, number>();
  private cache: {
    allMessages?: MuxMessage[];
    displayedMessages?: DisplayedMessage[];
    latestStreamingBashToolCallId?: string | null; // null = computed, none found
  } = {};
  private recencyTimestamp: number | null = null;
  private lastResponseCompletedAt: number | null = null;

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

  // Loaded skills (updated when agent_skill_read succeeds)
  // Persists after stream completion (like agentStatus) to show which skills were loaded
  // Keyed by skill name to avoid duplicates
  private loadedSkills = new Map<string, LoadedSkill>();
  // Cached array for getLoadedSkills() to preserve reference identity for memoization
  private loadedSkillsCache: LoadedSkill[] = [];

  // Runtime skill load errors (updated when agent_skill_read fails)
  // Keyed by skill name; cleared when the skill is later loaded successfully
  private skillLoadErrors = new Map<string, SkillLoadError>();
  private skillLoadErrorsCache: SkillLoadError[] = [];

  // Last URL set via status_set - kept in memory to reuse when later calls omit url
  private lastStatusUrl: string | undefined = undefined;

  // Whether to disable DOM message capping for this workspace.
  // Controlled via the HistoryHiddenMessage “Load all” button.
  private showAllMessages = false;
  // Workspace ID (used for status persistence)
  private readonly workspaceId: string | undefined;

  // Workspace init hook state (ephemeral, not persisted to history)
  private initState: {
    status: "running" | "success" | "error";
    hookPath: string;
    lines: Array<{ line: string; isError: boolean }>;
    exitCode: number | null;
    startTime: number;
    endTime: number | null;
    truncatedLines?: number; // Lines dropped from middle when output exceeded limit
  } | null = null;

  // Throttle init-output cache invalidation to avoid re-render per line during fast streaming
  private initOutputThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly INIT_OUTPUT_THROTTLE_MS = 100;

  // Track when we're waiting for stream-start after user message
  // Prevents retry barrier flash during normal send flow
  // Stores timestamp of when user message was sent (null = no pending stream)
  // IMPORTANT: We intentionally keep this timestamp until a stream actually starts
  // (or the user retries) so retry UI/backoff logic doesn't misfire on send failures.
  private pendingStreamStartTime: number | null = null;

  // Last observed stream-abort reason (used to gate auto-retry).
  private lastAbortReason: StreamAbortReasonSnapshot | null = null;

  // Current runtime status (set during ensureReady for Coder workspaces)
  // Used to show "Starting Coder workspace..." in StreamingBarrier
  private runtimeStatus: RuntimeStatusEvent | null = null;

  // Pending compaction request metadata for the next stream (set when user message arrives).
  // Used to infer compaction state before stream-start arrives.
  private pendingCompactionRequest: CompactionRequestData | null = null;

  // Model used for the pending send (set on user message) so the "starting" UI
  // reflects one-shot/compaction overrides instead of stale localStorage values.
  private pendingStreamModel: string | null = null;

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
    mode?: string; // Mode in which this response occurred
  } | null = null;

  // Optimistic "interrupting" state: set before calling interruptStream
  // Shows "interrupting..." in StreamingBarrier until real stream-abort arrives
  private interruptingMessageId: string | null = null;

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
  // Workspace unarchived timestamp (used for recency calculation to bump restored workspaces)
  private unarchivedAt?: string;

  // Optional callback for navigating to a workspace (set by parent component)
  // Used for notification click handling in browser mode
  onNavigateToWorkspace?: (workspaceId: string) => void;

  // Optional callback when an assistant response completes (used for "notify on response" feature)
  // isFinal is true when no more active streams remain (assistant done with all work)
  // finalText is the text content after any tool calls (the final response to show in notification)
  // compaction is provided when this was a compaction stream (includes continue metadata)
  // completedAt: non-null for all final streams. Drives read-marking in App.tsx.
  // Only non-compaction completions also bump lastResponseCompletedAt (recency).
  onResponseComplete?: (
    workspaceId: string,
    messageId: string,
    isFinal: boolean,
    finalText: string,
    compaction?: { hasContinueMessage: boolean },
    completedAt?: number | null
  ) => void;

  constructor(createdAt: string, workspaceId?: string, unarchivedAt?: string) {
    this.createdAt = createdAt;
    this.workspaceId = workspaceId;
    this.unarchivedAt = unarchivedAt;
    // Load persisted agent status from localStorage
    if (workspaceId) {
      const persistedStatus = this.loadPersistedAgentStatus();
      if (persistedStatus) {
        this.agentStatus = persistedStatus;
        this.lastStatusUrl = persistedStatus.url;
      }
    }
    this.updateRecency();
  }

  /** Update unarchivedAt timestamp (called when workspace is restored from archive) */
  setUnarchivedAt(unarchivedAt: string | undefined): void {
    this.unarchivedAt = unarchivedAt;
    this.updateRecency();
  }

  /**
   * Disable the displayed message cap for this workspace.
   * Intended for user-triggered “Load all” UI.
   */
  setShowAllMessages(showAllMessages: boolean): void {
    assert(typeof showAllMessages === "boolean", "setShowAllMessages requires boolean");
    if (this.showAllMessages === showAllMessages) {
      return;
    }
    this.showAllMessages = showAllMessages;
    this.invalidateCache();
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

  /**
   * Detect the replay→live transition for reconnect streams.
   *
   * During reconnect, `replayStream()` emits all catch-up events with `replay: true`.
   * Once the catch-up phase is over, fresh live deltas arrive without the flag.
   * This helper flips `isReplay` to false on the first non-replay event so that
   * `streamPresentation.source` correctly transitions to "live" and smoothing
   * resumes instead of staying bypassed.
   *
   * IMPORTANT: Only call from content handlers (handleStreamDelta, handleReasoningDelta).
   * Tool events are not buffered by the reconnect relay and can arrive before replay
   * text finishes flushing — calling this from tool handlers would prematurely end
   * replay phase and reclassify catch-up content as live.
   */
  private syncReplayPhase(messageId: string, replay?: boolean): void {
    const context = this.activeStreams.get(messageId);
    if (context && context.isReplay && replay !== true) {
      context.isReplay = false;
    }
  }

  private translateServerTime(context: StreamingContext, serverTimestamp: number): number {
    assert(context, "translateServerTime requires context");
    assert(typeof serverTimestamp === "number", "translateServerTime requires serverTimestamp");

    return serverTimestamp + context.clockOffsetMs;
  }

  private bumpMessageVersion(messageId: string): void {
    const current = this.messageVersions.get(messageId) ?? 0;
    this.messageVersions.set(messageId, current + 1);
  }

  private markMessageDirty(messageId: string): void {
    this.bumpMessageVersion(messageId);
    this.invalidateCache();
  }

  private deleteMessage(messageId: string): boolean {
    const didDelete = this.messages.delete(messageId);
    if (didDelete) {
      this.displayedMessageCache.delete(messageId);
      this.messageVersions.delete(messageId);
      // Clean up token tracking state to prevent memory leaks
      this.deltaHistory.delete(messageId);
      this.activeStreamUsage.delete(messageId);
    }
    return didDelete;
  }
  private invalidateCache(): void {
    this.cache = {};
    this.updateRecency();
  }

  /**
   * Recompute and cache recency from current messages.
   * Called automatically when messages change.
   */
  private updateRecency(): void {
    const messages = this.getAllMessages();
    const messageRecency = computeRecencyTimestamp(messages, this.createdAt, this.unarchivedAt);
    const candidates = [messageRecency, this.lastResponseCompletedAt].filter(
      (t): t is number => t !== null
    );
    this.recencyTimestamp = candidates.length > 0 ? Math.max(...candidates) : null;
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
   * Get the list of loaded skills for this workspace.
   * Updated whenever agent_skill_read succeeds.
   * Persists after stream completion (like agentStatus).
   * Returns a stable array reference for memoization (only changes when skills change).
   */
  getLoadedSkills(): LoadedSkill[] {
    return this.loadedSkillsCache;
  }

  /**
   * Get runtime skill load errors (agent_skill_read failures).
   * Errors are cleared for a skill when it later loads successfully.
   * Returns a stable array reference for memoization.
   */
  getSkillLoadErrors(): SkillLoadError[] {
    return this.skillLoadErrorsCache;
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
    // Clear optimistic interrupt flag if this stream was being interrupted.
    // This handles cases where streams end normally or with errors (not just abort).
    if (this.interruptingMessageId === messageId) {
      this.interruptingMessageId = null;
    }

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

      // Get output tokens from cumulative usage (if available).
      // Fall back to message metadata for abort/error cases where clearTokenState was
      // called before cleanupStreamState (e.g., stream abort event handler ordering).
      const cumulativeUsage = this.activeStreamUsage.get(messageId)?.cumulative.usage;
      const metadataUsage = message?.metadata?.usage;
      const outputTokens = cumulativeUsage?.outputTokens ?? metadataUsage?.outputTokens ?? 0;
      const reasoningTokens =
        cumulativeUsage?.reasoningTokens ?? metadataUsage?.reasoningTokens ?? 0;

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

      const mode = message?.metadata?.mode ?? context.mode;

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

  /**
   * Extract the final response text from a message (text after the last tool call).
   * Used for notification body content.
   */
  private extractFinalResponseText(message: MuxMessage | undefined): string {
    if (!message) return "";
    const parts = message.parts;
    const lastToolIndex = parts.findLastIndex((part) => part.type === "dynamic-tool");
    const textPartsAfterTools = lastToolIndex >= 0 ? parts.slice(lastToolIndex + 1) : parts;
    return textPartsAfterTools
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim();
  }

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
    this.markMessageDirty(message.id);
  }

  /**
   * Remove a message from the aggregator.
   * Used for dismissing ephemeral messages like /plan output.
   * Rebuilds detected links to remove any that only existed in the removed message.
   */
  removeMessage(messageId: string): void {
    if (this.deleteMessage(messageId)) {
      this.invalidateCache();
    }
  }

  /**
   * Load historical messages in batch, preserving their historySequence numbers.
   * This is more efficient than calling addMessage() repeatedly.
   *
   * @param messages - Historical messages to load
   * @param hasActiveStream - Whether there's an active stream in buffered events (for reconnection scenario)
   * @param opts.mode - "replace" clears existing state first, "append" merges into existing state
   */
  loadHistoricalMessages(
    messages: MuxMessage[],
    hasActiveStream = false,
    opts?: { mode?: "replace" | "append" }
  ): void {
    const mode = opts?.mode ?? "replace";

    if (mode === "replace") {
      // Clear existing state to prevent stale messages from persisting.
      this.messages.clear();
      this.displayedMessageCache.clear();
      this.messageVersions.clear();
      this.deltaHistory.clear();
      this.activeStreamUsage.clear();
      this.loadedSkills.clear();
      this.loadedSkillsCache = [];
      this.skillLoadErrors.clear();
      this.skillLoadErrorsCache = [];
      this.lastResponseCompletedAt = null;
    }

    const overwrittenMessageIds: string[] = [];
    const appliedMessages: MuxMessage[] = [];

    // Add/overwrite messages in the map
    for (const message of messages) {
      const existing = mode === "append" ? this.messages.get(message.id) : undefined;

      if (existing) {
        const existingParts = Array.isArray(existing.parts) ? existing.parts.length : 0;
        const incomingParts = Array.isArray(message.parts) ? message.parts.length : 0;

        // Since-replay can include a stale boundary row for an active stream message while
        // richer in-memory parts already exist. Keep the richer message to avoid dropping
        // in-flight tool/text parts that filtered replay deltas may not resend.
        if (incomingParts < existingParts) {
          continue;
        }

        overwrittenMessageIds.push(message.id);
      }

      this.messages.set(message.id, message);
      appliedMessages.push(message);
    }

    if (mode === "append") {
      for (const messageId of overwrittenMessageIds) {
        // Append replay can overwrite an existing message ID (e.g., partial -> finalized).
        // Bump per-message version so displayed row caches are invalidated and rebuilt.
        this.bumpMessageVersion(messageId);
        this.displayedMessageCache.delete(messageId);
      }
    }

    // Use "streaming" context if there's an active stream (reconnection), otherwise "historical"
    const context = hasActiveStream ? "streaming" : "historical";

    // Sort applied messages in chronological order for processing
    const chronologicalMessages = [...appliedMessages].sort(
      (a, b) => (a.metadata?.historySequence ?? 0) - (b.metadata?.historySequence ?? 0)
    );

    // Replay historical messages in order to reconstruct derived state
    for (const message of chronologicalMessages) {
      this.maybeTrackLoadedSkillFromAgentSkillSnapshot(message.metadata?.agentSkillSnapshot);

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
    this.cache.allMessages ??= Array.from(this.messages.values()).sort(
      (a, b) => (a.metadata?.historySequence ?? 0) - (b.metadata?.historySequence ?? 0)
    );
    return this.cache.allMessages;
  }

  /**
   * Build a cursor for incremental onChat reconnection.
   * Returns undefined when we cannot safely represent the current state,
   * forcing a full replay.
   */
  getOnChatCursor(): OnChatCursor | undefined {
    let maxHistorySequence = -1;
    let maxHistoryMessageId: string | undefined;
    let minHistorySequence = Number.POSITIVE_INFINITY;

    for (const message of this.messages.values()) {
      const historySequence = message.metadata?.historySequence;
      if (historySequence === undefined) {
        continue;
      }

      if (historySequence > maxHistorySequence) {
        maxHistorySequence = historySequence;
        maxHistoryMessageId = message.id;
      }

      if (historySequence < minHistorySequence) {
        minHistorySequence = historySequence;
      }
    }

    if (!maxHistoryMessageId || !Number.isFinite(minHistorySequence)) {
      return undefined;
    }

    if (this.activeStreams.size > 1) {
      // Defensive fallback: multiple active streams is anomalous, so force a full replay.
      return undefined;
    }

    const priorHistoryFingerprint = computePriorHistoryFingerprint(
      this.getAllMessages(),
      maxHistorySequence
    );

    const cursor: OnChatCursor = {
      history: {
        messageId: maxHistoryMessageId,
        historySequence: maxHistorySequence,
        oldestHistorySequence: minHistorySequence,
        ...(priorHistoryFingerprint !== undefined ? { priorHistoryFingerprint } : {}),
      },
    };

    if (this.activeStreams.size === 1) {
      const activeStreamEntry = this.activeStreams.entries().next().value;
      assert(activeStreamEntry, "activeStreams size reported 1 but no entry found");
      const [messageId, context] = activeStreamEntry;
      cursor.stream = {
        messageId,
        lastTimestamp: context.lastServerTimestamp,
      };
    }

    return cursor;
  }
  // Efficient methods to check message state without creating arrays
  getMessageCount(): number {
    return this.messages.size;
  }

  hasMessages(): boolean {
    return this.messages.size > 0;
  }

  clearLastAbortReason(): void {
    this.lastAbortReason = null;
  }
  getLastAbortReason(): StreamAbortReasonSnapshot | null {
    return this.lastAbortReason;
  }

  getPendingStreamStartTime(): number | null {
    return this.pendingStreamStartTime;
  }

  /**
   * Get the current runtime status (for Coder workspace starting UX).
   * Returns null if no runtime status is active.
   */
  getRuntimeStatus(): RuntimeStatusEvent | null {
    return this.runtimeStatus;
  }

  /**
   * Handle runtime-status event (emitted during ensureReady for Coder workspaces).
   * Used to show "Starting Coder workspace..." in StreamingBarrier.
   */
  handleRuntimeStatus(status: RuntimeStatusEvent): void {
    // Clear status when ready/error or set new status
    if (status.phase === "ready" || status.phase === "error") {
      this.runtimeStatus = null;
    } else {
      this.runtimeStatus = status;
    }
  }

  getPendingStreamModel(): string | null {
    if (this.pendingStreamStartTime === null) return null;
    return this.pendingStreamModel;
  }

  private getLatestCompactionRequest(): CompactionRequestData | null {
    if (this.pendingCompactionRequest) {
      return this.pendingCompactionRequest;
    }

    const messages = this.getAllMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role !== "user") continue;
      const muxMetadata = message.metadata?.muxMetadata;
      if (muxMetadata?.type === "compaction-request") {
        return muxMetadata.parsed;
      }
      return null;
    }

    return null;
  }

  private setPendingStreamStartTime(time: number | null): void {
    this.pendingStreamStartTime = time;
    if (time === null) {
      this.pendingCompactionRequest = null;
      this.pendingStreamModel = null;
    }
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
    mode?: string;
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
    mode?: string;
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
        mode?: string;
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
        mode?: string;
      }
    > = {};

    for (const [key, stats] of modelEntries) {
      // Parse composite key: "model" or "model:mode"
      // Model names can contain colons (e.g., "mux-gateway:provider/model")
      // so we look for ":plan" or ":exec" suffix specifically
      let mode: string | undefined;
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

  /**
   * Mark the current active stream as "interrupting" (transient state).
   * Called before interruptStream so UI shows "interrupting..." immediately.
   * Cleared when real stream-abort arrives, at which point "interrupted" shows.
   */
  setInterrupting(): void {
    const activeMessageId = this.getActiveStreamMessageId();
    if (activeMessageId) {
      this.interruptingMessageId = activeMessageId;
      this.invalidateCache();
    }
  }

  /**
   * Check if a message is in the "interrupting" transient state.
   */
  isInterrupting(messageId: string): boolean {
    return this.interruptingMessageId === messageId;
  }

  /**
   * Check if any stream is currently being interrupted.
   */
  hasInterruptingStream(): boolean {
    return this.interruptingMessageId !== null;
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

  /**
   * Returns the effective thinking level for the current or most recent stream.
   * This reflects the actual level used after model policy clamping, not the
   * user-configured level.
   */
  getCurrentThinkingLevel(): string | undefined {
    // If there's an active stream, return its thinking level
    for (const context of this.activeStreams.values()) {
      return context.thinkingLevel;
    }

    // Only check the most recent assistant message to avoid returning
    // stale values from older turns where settings may have differed.
    // If it lacks thinkingLevel (e.g. error/abort), return undefined so
    // callers fall back to localStorage.
    const messages = this.getAllMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === "assistant") {
        return message.metadata?.thinkingLevel;
      }
    }

    return undefined;
  }

  clearActiveStreams(): void {
    const activeMessageIds = Array.from(this.activeStreams.keys());
    this.activeStreams.clear();

    // Clear optimistic interrupt flag since all streams are cleared
    this.interruptingMessageId = null;

    if (activeMessageIds.length > 0) {
      for (const messageId of activeMessageIds) {
        this.bumpMessageVersion(messageId);
      }
      this.invalidateCache();
    }
  }

  clear(): void {
    this.messages.clear();
    this.activeStreams.clear();
    this.displayedMessageCache.clear();
    this.messageVersions.clear();
    this.interruptingMessageId = null;
    this.lastAbortReason = null;
    this.lastResponseCompletedAt = null;
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
        this.deleteMessage(messageId);
      }
    }

    this.invalidateCache();
  }

  // Unified event handlers that encapsulate all complex logic
  handleStreamStart(data: StreamStartEvent): void {
    // Detect compaction via stream mode (most authoritative).
    // For backwards compat (older stream-start events without mode), fall back to the
    // triggering compaction request metadata (pending or last user message).
    const compactionRequest = this.getLatestCompactionRequest();
    const isCompacting = data.mode === "compact" || compactionRequest !== null;

    // Capture compaction-continue metadata before clearing pending request state.
    const hasCompactionContinue = Boolean(compactionRequest?.followUpContent);

    // Clear pending stream start timestamp - stream has started
    this.setPendingStreamStartTime(null);
    this.lastAbortReason = null;

    // Clear runtime status - runtime is ready now that stream has started
    this.runtimeStatus = null;

    // NOTE: We do NOT clear agentStatus or currentTodos here.
    // They are cleared when a new user message arrives (see handleMessage),
    // ensuring consistent behavior whether loading from history or processing live events.

    const now = Date.now();
    const context: StreamingContext = {
      serverStartTime: data.startTime,
      clockOffsetMs: now - data.startTime,
      lastServerTimestamp: data.startTime,
      isComplete: false,
      isCompacting,
      hasCompactionContinue,
      isReplay: data.replay === true,
      model: data.model,
      routedThroughGateway: data.routedThroughGateway,
      serverFirstTokenTime: null,
      toolExecutionMs: 0,
      pendingToolStarts: new Map(),
      mode: data.mode,
      thinkingLevel: data.thinkingLevel,
    };

    // For incremental replay: stream-start may be re-emitted to re-establish context.
    // If we already have this message with accumulated parts, don't wipe its content.
    const existingMessage = this.messages.get(data.messageId);
    const existingContext = this.activeStreams.get(data.messageId);
    if (data.replay && existingMessage && existingMessage.parts.length > 0) {
      if (existingContext) {
        // Preserve the highest observed server timestamp across reconnect boundaries.
        // If replay emits only stream-start (no newer parts), regressing this value
        // would cause the next since cursor to request already-seen stream events.
        context.lastServerTimestamp = Math.max(
          context.lastServerTimestamp,
          existingContext.lastServerTimestamp
        );
        context.clockOffsetMs = Date.now() - context.lastServerTimestamp;

        // Preserve in-flight timing context so reconnect doesn't reset active tool timing stats.
        context.serverFirstTokenTime = existingContext.serverFirstTokenTime;
        context.toolExecutionMs = existingContext.toolExecutionMs;
        context.pendingToolStarts = new Map(existingContext.pendingToolStarts);
      }

      this.activeStreams.set(data.messageId, context);
      if (existingMessage.metadata) {
        existingMessage.metadata.model = data.model;
        existingMessage.metadata.routedThroughGateway = data.routedThroughGateway;
        existingMessage.metadata.mode = data.mode;
        existingMessage.metadata.thinkingLevel = data.thinkingLevel;
      }
      this.markMessageDirty(data.messageId);
      return;
    }

    // Use messageId as key - ensures only ONE stream per message
    // If called twice, second call safely overwrites first
    this.activeStreams.set(data.messageId, context);

    // Create initial streaming message with empty parts (deltas will append)
    const streamingMessage = createMuxMessage(data.messageId, "assistant", "", {
      historySequence: data.historySequence,
      timestamp: Date.now(),
      model: data.model,
      routedThroughGateway: data.routedThroughGateway,
      mode: data.mode,
      thinkingLevel: data.thinkingLevel,
    });

    this.messages.set(data.messageId, streamingMessage);
    this.markMessageDirty(data.messageId);
  }

  handleStreamDelta(data: StreamDeltaEvent): void {
    const message = this.messages.get(data.messageId);
    if (!message) return;

    this.syncReplayPhase(data.messageId, data.replay);

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

    this.markMessageDirty(data.messageId);
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

      // Capture compaction info before cleanup (cleanup removes the stream context)
      const compaction = activeStream.isCompacting
        ? { hasContinueMessage: activeStream.hasCompactionContinue }
        : undefined;

      // Clean up stream-scoped state (active stream tracking, TODOs)
      this.cleanupStreamState(data.messageId);

      const isFinal = this.activeStreams.size === 0;

      // Completion timestamp for ALL final streams — the "stream ended" fact.
      // Read-marking uses this to keep the active workspace current.
      const completedAt = isFinal ? Date.now() : null;

      // Recency policy: only non-compaction finals inflate lastResponseCompletedAt.
      // Compaction recency comes from the compacted summary's own timestamp.
      if (completedAt !== null && !activeStream.isCompacting) {
        this.lastResponseCompletedAt = completedAt;
      }

      // Notify on normal stream completion (skip replay-only reconstruction)
      // isFinal = true when this was the last active stream (assistant done with all work)
      if (this.workspaceId && this.onResponseComplete) {
        const finalText = this.extractFinalResponseText(message);
        this.onResponseComplete(
          this.workspaceId,
          data.messageId,
          isFinal,
          finalText,
          compaction,
          completedAt
        );
      }
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
    // Assistant message is now stable (completed or reconnected) - invalidate all caches.
    this.markMessageDirty(data.messageId);
  }

  handleStreamAbort(data: StreamAbortEvent): void {
    // Clear pending stream start timestamp - abort can arrive before stream-start.
    // This ensures StreamingBarrier exits the "starting..." phase immediately.
    this.setPendingStreamStartTime(null);
    this.lastAbortReason = {
      reason: data.abortReason ?? "system",
      at: Date.now(),
    };

    // Clear "interrupting" state - stream is now fully "interrupted"
    if (this.interruptingMessageId === data.messageId) {
      this.interruptingMessageId = null;
    }

    // Direct lookup by messageId

    // Clear runtime status (ensureReady is no longer relevant once stream aborts)
    this.runtimeStatus = null;
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
      // Assistant message is now stable (aborted) - invalidate all caches.
      this.markMessageDirty(data.messageId);
    }
  }

  handleStreamError(data: StreamErrorMessage): void {
    // Clear pending stream start timestamp - error arrived before/instead of stream-start.
    // This ensures StreamingBarrier exits the "starting..." phase immediately.
    this.setPendingStreamStartTime(null);

    // Direct lookup by messageId

    // Clear runtime status - runtime start/ensureReady failed
    this.runtimeStatus = null;
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
      // Assistant message is now stable (errored) - invalidate all caches.
      this.markMessageDirty(data.messageId);
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
      this.markMessageDirty(data.messageId);
    }
  }

  handleToolCallStart(data: ToolCallStartEvent): void {
    const message = this.messages.get(data.messageId);
    if (!message) return;

    // If this is a nested call (from PTC code_execution), add to parent's nestedCalls
    if (data.parentToolCallId) {
      const parentPart = message.parts.find(
        (part): part is DynamicToolPart =>
          part.type === "dynamic-tool" && part.toolCallId === data.parentToolCallId
      );
      if (parentPart) {
        // Initialize nestedCalls array if needed
        parentPart.nestedCalls ??= [];
        parentPart.nestedCalls.push({
          toolCallId: data.toolCallId,
          toolName: data.toolName,
          state: "input-available",
          input: data.args,
          timestamp: data.timestamp,
        });
        this.markMessageDirty(data.messageId);
        return;
      }
    }

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

    this.markMessageDirty(data.messageId);
  }

  handleToolCallDelta(data: ToolCallDeltaEvent): void {
    // Track delta for token counting and TPS calculation
    this.trackDelta(data.messageId, data.tokens, data.timestamp, "tool-args");
    // Tool deltas are for display - args are in dynamic-tool part
  }

  private trackLoadedSkill(skill: LoadedSkill): void {
    const existing = this.loadedSkills.get(skill.name);
    if (
      existing?.name === skill.name &&
      existing.description === skill.description &&
      existing.scope === skill.scope
    ) {
      return;
    }

    this.loadedSkills.set(skill.name, skill);
    // Preserve a stable array reference for getLoadedSkills(): only replace when it changes.
    this.loadedSkillsCache = Array.from(this.loadedSkills.values());

    // A successful load supersedes any previous error for this skill
    if (this.skillLoadErrors.delete(skill.name)) {
      this.skillLoadErrorsCache = Array.from(this.skillLoadErrors.values());
    }
  }

  private trackSkillLoadError(name: string, error: string): void {
    const existing = this.skillLoadErrors.get(name);
    if (existing?.error === error) return;

    this.skillLoadErrors.set(name, { name, error });
    this.skillLoadErrorsCache = Array.from(this.skillLoadErrors.values());

    // A failed load supersedes any earlier success (skill may have been
    // edited/deleted since the previous successful read)
    if (this.loadedSkills.delete(name)) {
      this.loadedSkillsCache = Array.from(this.loadedSkills.values());
    }
  }

  private maybeTrackLoadedSkillFromAgentSkillSnapshot(snapshot: unknown): void {
    const parsed = AgentSkillSnapshotMetadataSchema.safeParse(snapshot);
    if (!parsed.success) {
      return;
    }

    const { skillName, scope } = parsed.data;

    // Don't override an existing entry (e.g. from agent_skill_read) with a placeholder description.
    if (this.loadedSkills.has(skillName)) {
      return;
    }

    this.trackLoadedSkill({
      name: skillName,
      description: `(loaded via /${skillName})`,
      scope,
    });
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

    // Handle browser notifications when Electron wasn't available
    if (toolName === "notify" && hasSuccessResult(output)) {
      const result = output as Extract<NotifyToolResult, { success: true }>;
      const uiOnlyNotify = getToolOutputUiOnly(output)?.notify;
      const legacyNotify = output as { notifiedVia?: string; workspaceId?: string };
      const notifiedVia = uiOnlyNotify?.notifiedVia ?? legacyNotify.notifiedVia;
      const workspaceId = uiOnlyNotify?.workspaceId ?? legacyNotify.workspaceId;

      if (notifiedVia === "browser") {
        this.sendBrowserNotification(result.title, result.message, workspaceId);
      }
    }

    // Track loaded skills when agent_skill_read succeeds
    // Skills persist: update both during streaming and on historical reload
    if (toolName === "agent_skill_read" && hasSuccessResult(output)) {
      const result = output as {
        success: true;
        skill: {
          scope: AgentSkillScope;
          directoryName: string;
          frontmatter: { name: string; description: string };
        };
      };
      const skill = result.skill;
      this.trackLoadedSkill({
        name: skill.frontmatter.name,
        description: skill.frontmatter.description,
        scope: skill.scope,
      });
    }

    // Track runtime skill load errors when agent_skill_read fails
    if (toolName === "agent_skill_read" && hasFailureResult(output)) {
      const args = input as { name?: string } | undefined;
      const errorResult = output as { error?: string };
      if (args?.name) {
        this.trackSkillLoadError(args.name, errorResult.error ?? "Unknown error");
      }
    }

    // Link extraction is derived from message history (see computeLinksFromMessages()).
    // When a tool output becomes available, handleToolCallEnd invalidates the link cache.
  }

  /**
   * Send a browser notification using the Web Notifications API
   * Only called when Electron notifications are unavailable.
   * Clicking the notification navigates to the workspace.
   */
  private sendBrowserNotification(title: string, body?: string, workspaceId?: string): void {
    if (!("Notification" in window)) return;

    const showNotification = () => {
      const notification = new Notification(title, { body });
      if (workspaceId) {
        notification.onclick = () => {
          // Focus the window and navigate to the workspace
          window.focus();
          this.onNavigateToWorkspace?.(workspaceId);
        };
      }
    };

    if (Notification.permission === "granted") {
      showNotification();
    } else if (Notification.permission !== "denied") {
      void Notification.requestPermission().then((perm) => {
        if (perm === "granted") {
          showNotification();
        }
      });
    }
  }

  handleToolCallEnd(data: ToolCallEndEvent): void {
    // Track tool execution duration
    const context = this.activeStreams.get(data.messageId);
    if (context) {
      this.updateStreamClock(context, data.timestamp);

      const startTime = context.pendingToolStarts.get(data.toolCallId);
      if (startTime !== undefined) {
        // Clamp to non-negative to handle out-of-order timestamps during replay
        context.toolExecutionMs += Math.max(0, data.timestamp - startTime);
        context.pendingToolStarts.delete(data.toolCallId);
      }
    }

    const message = this.messages.get(data.messageId);
    if (message) {
      // If nested, update in parent's nestedCalls array
      if (data.parentToolCallId) {
        const parentIndex = message.parts.findIndex(
          (part): part is DynamicToolPart =>
            part.type === "dynamic-tool" && part.toolCallId === data.parentToolCallId
        );
        const parentPart = message.parts[parentIndex] as DynamicToolPart | undefined;
        if (parentPart?.nestedCalls) {
          const nestedIndex = parentPart.nestedCalls.findIndex(
            (nc) => nc.toolCallId === data.toolCallId
          );
          if (nestedIndex !== -1) {
            // Create new objects to trigger React re-render (immutable update pattern)
            const updatedNestedCalls = parentPart.nestedCalls.map((nc, i) =>
              i === nestedIndex
                ? { ...nc, state: "output-available" as const, output: data.result }
                : nc
            );
            message.parts[parentIndex] = { ...parentPart, nestedCalls: updatedNestedCalls };
            this.markMessageDirty(data.messageId);
            return;
          }
        }
      }

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

        // Tool output is now stable - invalidate all caches.
        this.markMessageDirty(data.messageId);
      } else {
        // Tool part not found (shouldn't happen normally) - still invalidate display cache.
        this.markMessageDirty(data.messageId);
      }
    }
  }

  handleReasoningDelta(data: ReasoningDeltaEvent): void {
    const message = this.messages.get(data.messageId);
    if (!message) return;

    this.syncReplayPhase(data.messageId, data.replay);

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

    this.markMessageDirty(data.messageId);
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
        startTime: data.timestamp,
        endTime: null,
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
      const line = data.line.trimEnd();
      const isError = data.isError === true;

      // Truncation: keep only the most recent MAX_LINES (matches backend)
      if (this.initState.lines.length >= INIT_HOOK_MAX_LINES) {
        this.initState.lines.shift(); // Drop oldest line
        this.initState.truncatedLines = (this.initState.truncatedLines ?? 0) + 1;
      }
      this.initState.lines.push({ line, isError });

      // Throttle cache invalidation during fast streaming to avoid re-render per line
      this.initOutputThrottleTimer ??= setTimeout(() => {
        this.initOutputThrottleTimer = null;
        this.invalidateCache();
      }, StreamingMessageAggregator.INIT_OUTPUT_THROTTLE_MS);
      return;
    }

    if (isInitEnd(data)) {
      if (!this.initState) {
        console.error("Received init-end without init-start", { data });
        return;
      }
      this.initState.exitCode = data.exitCode;
      this.initState.status = data.exitCode === 0 ? "success" : "error";
      this.initState.endTime = data.timestamp;
      // Use backend truncation count if larger (covers replay of old data)
      if (data.truncatedLines && data.truncatedLines > (this.initState.truncatedLines ?? 0)) {
        this.initState.truncatedLines = data.truncatedLines;
      }
      // Cancel any pending throttled update and flush immediately
      if (this.initOutputThrottleTimer) {
        clearTimeout(this.initOutputThrottleTimer);
        this.initOutputThrottleTimer = null;
      }
      // Reset pending stream start time so the grace period starts fresh after init completes.
      // This prevents false retry barriers for slow init (e.g., Coder workspace provisioning).
      if (this.pendingStreamStartTime !== null) {
        this.setPendingStreamStartTime(Date.now());
      }
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
              this.deleteMessage(removeId);
            }
            break; // Found and handled the conflict
          }
        }
      }

      // When a compaction boundary arrives during a live session, prune messages
      // older than the penultimate boundary so the UI matches what a fresh load
      // would show (emitHistoricalEvents reads from skip=1, the penultimate boundary).
      // The user sees the previous epoch + current epoch; older epochs are pruned.
      // Without this, all pre-boundary messages persist until the next page refresh.
      // TODO: support paginated history loading so users can view older epochs on demand.
      if (this.isCompactionBoundarySummaryMessage(incomingMessage)) {
        this.pruneBeforePenultimateBoundary(incomingMessage);
      }

      // Now add the new message
      this.addMessage(incomingMessage);

      this.maybeTrackLoadedSkillFromAgentSkillSnapshot(
        incomingMessage.metadata?.agentSkillSnapshot
      );

      // If this is a user message, clear derived state and record timestamp
      if (incomingMessage.role === "user") {
        const muxMeta = incomingMessage.metadata?.muxMetadata as
          | { displayStatus?: { emoji: string; message: string } }
          | undefined;

        // Always clear todos (stream-scoped state)
        this.currentTodos = [];

        // Capture pending compaction metadata for pre-stream UI ("starting" phase).
        const muxMetadata = incomingMessage.metadata?.muxMetadata as
          | MuxFrontendMetadata
          | undefined;
        this.pendingCompactionRequest =
          muxMetadata?.type === "compaction-request" ? muxMetadata.parsed : null;

        this.pendingStreamModel = muxMetadata?.requestedModel ?? null;

        if (muxMeta?.displayStatus) {
          // Background operation - show requested status (don't persist)
          this.agentStatus = muxMeta.displayStatus;
        } else {
          // Normal user turn - clear status
          this.agentStatus = undefined;
          this.clearPersistedAgentStatus();
        }

        this.lastAbortReason = null;
        this.setPendingStreamStartTime(Date.now());
      }
    }
  }

  private isCompactionBoundarySummaryMessage(message: MuxMessage): boolean {
    const muxMeta = message.metadata?.muxMetadata;
    return (
      message.role === "assistant" &&
      (message.metadata?.compactionBoundary === true || muxMeta?.type === "compaction-summary")
    );
  }

  /**
   * Keep the previous epoch visible: when the new (Nth) boundary arrives,
   * find the penultimate (N-1) boundary among existing messages and prune
   * everything before it. This matches the backend's getHistoryFromLatestBoundary
   * which reads from the n-1 boundary.
   *
   * If only one boundary exists (the incoming one), nothing is pruned — the
   * user sees their full first-epoch history.
   */
  private pruneBeforePenultimateBoundary(_incomingBoundary: MuxMessage): void {
    // Find the penultimate boundary among the *existing* messages (before adding
    // the incoming one). With the incoming boundary about to become the latest,
    // the existing latest boundary becomes the penultimate one.
    let penultimateBoundarySeq: number | undefined;
    for (const [, msg] of this.messages.entries()) {
      if (!this.isCompactionBoundarySummaryMessage(msg)) continue;
      const seq = msg.metadata?.historySequence;
      if (seq === undefined) continue;
      // The highest-sequence boundary in existing messages is the one that
      // will become the penultimate once the incoming boundary is added.
      if (penultimateBoundarySeq === undefined || seq > penultimateBoundarySeq) {
        penultimateBoundarySeq = seq;
      }
    }

    // No existing boundary → this is the first compaction, nothing to prune
    if (penultimateBoundarySeq === undefined) return;

    const toRemove: string[] = [];
    for (const [id, msg] of this.messages.entries()) {
      const seq = msg.metadata?.historySequence;
      if (seq !== undefined && seq < penultimateBoundarySeq) {
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      this.deleteMessage(id);
    }

    if (toRemove.length > 0) {
      this.invalidateCache();
    }
  }

  private createCompactionBoundaryRow(
    message: MuxMessage,
    historySequence: number
  ): Extract<DisplayedMessage, { type: "compaction-boundary" }> {
    assert(
      message.role === "assistant",
      "compaction boundaries must belong to assistant summaries"
    );

    const rawCompactionEpoch = message.metadata?.compactionEpoch;
    const compactionEpoch =
      typeof rawCompactionEpoch === "number" &&
      Number.isInteger(rawCompactionEpoch) &&
      rawCompactionEpoch > 0
        ? rawCompactionEpoch
        : undefined;

    // Self-healing read path: malformed persisted compactionEpoch should not crash transcript rendering.
    return {
      type: "compaction-boundary",
      id: `${message.id}-compaction-boundary`,
      historySequence,
      position: "start",
      compactionEpoch,
    };
  }

  private buildDisplayedMessagesForMessage(
    message: MuxMessage,
    agentSkillSnapshot?: { frontmatterYaml?: string; body?: string }
  ): DisplayedMessage[] {
    const displayedMessages: DisplayedMessage[] = [];
    const baseTimestamp = message.metadata?.timestamp;
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
      return displayedMessages;
    }

    if (message.role === "user") {
      // User messages: combine all text parts into single block, extract attachments
      const partsContent = message.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");

      const fileParts = message.parts
        .filter((p): p is MuxFilePart => p.type === "file")
        .map((p) => ({
          url: typeof p.url === "string" ? p.url : "",
          mediaType: p.mediaType,
          filename: p.filename,
        }));

      // Extract slash command from muxMetadata (present for /compact, /skill, etc.)
      let rawCommand = muxMeta && "rawCommand" in muxMeta ? muxMeta.rawCommand : undefined;

      const agentSkill =
        muxMeta?.type === "agent-skill"
          ? {
              skillName: muxMeta.skillName,
              scope: muxMeta.scope,
              snapshot: agentSkillSnapshot,
            }
          : undefined;

      const compactionFollowUp = getCompactionFollowUpContent(muxMeta);

      const compactionRequest =
        muxMeta?.type === "compaction-request"
          ? {
              parsed: {
                model: muxMeta.parsed.model,
                maxOutputTokens: muxMeta.parsed.maxOutputTokens,
                followUpContent: compactionFollowUp,
              } satisfies CompactionRequestData,
            }
          : undefined;

      // Reconstruct full rawCommand if follow-up text isn't already included
      if (rawCommand && compactionRequest?.parsed.followUpContent && !rawCommand.includes("\n")) {
        const followUpText = getFollowUpContentText(compactionRequest.parsed.followUpContent);
        if (followUpText) {
          rawCommand = `${rawCommand}\n${followUpText}`;
        }
      }

      // Content is rawCommand (what user typed) or parts (normal message)
      const content = rawCommand ?? partsContent;

      // commandPrefix comes directly from metadata - no reconstruction needed
      const commandPrefix = muxMeta?.commandPrefix;

      // Extract reviews from muxMetadata for rich UI display (orthogonal to message type)
      const reviews = muxMeta?.reviews;

      displayedMessages.push({
        type: "user",
        id: message.id,
        historyId: message.id,
        content,
        commandPrefix,
        fileParts: fileParts.length > 0 ? fileParts : undefined,
        historySequence,
        isSynthetic: message.metadata?.synthetic === true ? true : undefined,
        timestamp: baseTimestamp,
        agentSkill,
        compactionRequest,
        reviews,
      });
      return displayedMessages;
    }

    if (message.role === "assistant") {
      // Assistant messages: each part becomes a separate DisplayedMessage
      // Use streamSequence to order parts within this message
      let streamSeq = 0;

      // Check if this message has an active stream (for inferring streaming status)
      // Direct Map.has() check - O(1) instead of O(n) iteration
      const hasActiveStream = this.activeStreams.has(message.id);
      const streamContext = hasActiveStream ? this.activeStreams.get(message.id) : undefined;

      // isPartial from metadata (set by stream-abort event)
      const isPartial = message.metadata?.partial === true;

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

      const isCompactionBoundarySummary = this.isCompactionBoundarySummaryMessage(message);
      if (isCompactionBoundarySummary) {
        displayedMessages.push(this.createCompactionBoundaryRow(message, historySequence));
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
            isPartial,
            isLastPartOfMessage: isLastPart,
            timestamp: part.timestamp ?? baseTimestamp,
            streamPresentation: isStreaming
              ? { source: streamContext?.isReplay ? "replay" : "live" }
              : undefined,
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
            isPartial,
            isLastPartOfMessage: isLastPart,
            // Support both new enum ("user"|"idle") and legacy boolean (true)
            isCompacted: !!message.metadata?.compacted,
            isIdleCompacted: message.metadata?.compacted === "idle",
            model: message.metadata?.model,
            routedThroughGateway: message.metadata?.routedThroughGateway,
            mode: message.metadata?.mode,
            agentId: message.metadata?.agentId ?? message.metadata?.mode,
            timestamp: part.timestamp ?? baseTimestamp,
            streamPresentation: isStreaming
              ? { source: streamContext?.isReplay ? "replay" : "live" }
              : undefined,
          });
        } else if (isDynamicToolPart(part)) {
          // Determine status based on part state and result
          let status: "pending" | "executing" | "completed" | "failed" | "interrupted" | "redacted";
          if (part.state === "output-available") {
            // Check if result indicates failure (for tools that return { success: boolean })
            status = hasFailureResult(part.output) ? "failed" : "completed";
          } else if (part.state === "output-redacted") {
            status = part.failed ? "failed" : "redacted";
          } else if (part.state === "input-available") {
            // Most unfinished tool calls in partial messages represent an interruption.
            // ask_user_question is different: it's intentionally waiting on user input,
            // so after restart we should keep it answerable ("executing") instead of
            // showing retry/auto-resume UX.
            if (part.toolName === "ask_user_question") {
              status = "executing";
            } else if (isPartial) {
              status = "interrupted";
            } else {
              status = "executing";
            }
          } else {
            status = "pending";
          }

          // For code_execution, use streaming nestedCalls if present, or reconstruct from result
          let nestedCalls = part.nestedCalls;
          if (
            !nestedCalls &&
            part.toolName === "code_execution" &&
            part.state === "output-available"
          ) {
            // Reconstruct nestedCalls from result.toolCalls (for historical replay)
            const result = part.output as
              | {
                  toolCalls?: Array<{
                    toolName: string;
                    args: unknown;
                    result?: unknown;
                    error?: string;
                    duration_ms: number;
                  }>;
                }
              | undefined;
            if (result?.toolCalls) {
              nestedCalls = result.toolCalls.map((tc, idx) => ({
                toolCallId: `${part.toolCallId}-nested-${idx}`,
                toolName: tc.toolName,
                input: tc.args,
                output: tc.result ?? (tc.error ? { error: tc.error } : undefined),
                state: "output-available" as const,
                timestamp: part.timestamp,
              }));
            }
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
            isPartial,
            historySequence,
            streamSequence: streamSeq++,
            isLastPartOfMessage: isLastPart,
            timestamp: part.timestamp ?? baseTimestamp,
            nestedCalls,
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
          routedThroughGateway: message.metadata?.routedThroughGateway,
          timestamp: baseTimestamp,
        });
      }
    }

    return displayedMessages;
  }

  /**
   * After filtering older tool/reasoning parts, recompute which part is the
   * last visible block for each assistant message. This keeps meta rows and
   * interrupted barriers accurate after truncation.
   */
  private normalizeLastPartFlags(messages: DisplayedMessage[]): DisplayedMessage[] {
    const seenHistoryIds = new Set<string>();
    let didChange = false;
    const normalized = messages.slice();

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!("isLastPartOfMessage" in msg) || typeof msg.historyId !== "string") {
        continue;
      }

      const shouldBeLast = !seenHistoryIds.has(msg.historyId);
      seenHistoryIds.add(msg.historyId);

      if (msg.isLastPartOfMessage !== shouldBeLast) {
        normalized[i] = { ...msg, isLastPartOfMessage: shouldBeLast };
        didChange = true;
      }
    }

    return didChange ? normalized : messages;
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
    if (!this.cache.displayedMessages) {
      const displayedMessages: DisplayedMessage[] = [];
      const allMessages = this.getAllMessages();
      const showSyntheticMessages =
        typeof window !== "undefined" && window.api?.debugLlmRequest === true;

      // Synthetic agent-skill snapshot messages are hidden from the transcript unless
      // debugLlmRequest is enabled. We still want to surface their content in the UI by
      // attaching the resolved snapshot (frontmatterYaml + body) to the *subsequent*
      // /{skillName} invocation message.
      const latestAgentSkillSnapshotByKey = new Map<
        string,
        { sha256?: string; frontmatterYaml?: string; body: string }
      >();

      for (const message of allMessages) {
        const snapshotMeta = message.metadata?.agentSkillSnapshot;
        if (snapshotMeta) {
          const parsed = AgentSkillSnapshotMetadataSchema.safeParse(snapshotMeta);
          if (parsed.success) {
            const snapshotText = message.parts
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("");
            const body = extractAgentSkillSnapshotBody(snapshotText);
            if (body !== null) {
              const key = `${parsed.data.scope}:${parsed.data.skillName}`;
              latestAgentSkillSnapshotByKey.set(key, {
                sha256: parsed.data.sha256,
                frontmatterYaml: parsed.data.frontmatterYaml,
                body,
              });
            }
          }
        }

        const isSynthetic = message.metadata?.synthetic === true;
        const isUiVisibleSynthetic = message.metadata?.uiVisible === true;

        // Synthetic messages are typically for model context only.
        // Show them only in debug mode, or when explicitly marked as UI-visible.
        if (isSynthetic && !showSyntheticMessages && !isUiVisibleSynthetic) {
          continue;
        }

        const muxMeta = message.metadata?.muxMetadata;
        const agentSkillSnapshotKey =
          message.role === "user" && muxMeta?.type === "agent-skill"
            ? `${muxMeta.scope}:${muxMeta.skillName}`
            : undefined;

        const agentSkillSnapshot = agentSkillSnapshotKey
          ? latestAgentSkillSnapshotByKey.get(agentSkillSnapshotKey)
          : undefined;

        const agentSkillSnapshotForDisplay = agentSkillSnapshot
          ? { frontmatterYaml: agentSkillSnapshot.frontmatterYaml, body: agentSkillSnapshot.body }
          : undefined;

        const agentSkillSnapshotCacheKey = agentSkillSnapshot
          ? `${agentSkillSnapshot.sha256 ?? ""}\n${agentSkillSnapshot.frontmatterYaml ?? ""}`
          : undefined;

        const version = this.messageVersions.get(message.id) ?? 0;
        const cached = this.displayedMessageCache.get(message.id);
        const canReuse =
          cached?.version === version &&
          cached.agentSkillSnapshotCacheKey === agentSkillSnapshotCacheKey;

        const messageDisplay = canReuse
          ? cached.messages
          : this.buildDisplayedMessagesForMessage(message, agentSkillSnapshotForDisplay);

        if (!canReuse) {
          this.displayedMessageCache.set(message.id, {
            version,
            agentSkillSnapshotCacheKey,
            messages: messageDisplay,
          });
        }

        if (messageDisplay.length > 0) {
          displayedMessages.push(...messageDisplay);
        }
      }

      let resultMessages = displayedMessages;

      // Limit messages for DOM performance (unless explicitly disabled).
      // Strategy: keep recent rows intact, preserve structural rows in older history,
      // and materialize omission runs as explicit history-hidden marker rows.
      // Full history is still maintained internally for token counting.
      if (!this.showAllMessages && displayedMessages.length > MAX_DISPLAYED_MESSAGES) {
        const truncationPlan = buildTranscriptTruncationPlan({
          displayedMessages,
          maxDisplayedMessages: MAX_DISPLAYED_MESSAGES,
          alwaysKeepMessageTypes: ALWAYS_KEEP_MESSAGE_TYPES,
        });

        resultMessages =
          truncationPlan.hiddenCount > 0
            ? this.normalizeLastPartFlags(truncationPlan.rows)
            : truncationPlan.rows;
      }

      // Add init state if present (ephemeral, appears at top)
      if (this.initState) {
        const durationMs =
          this.initState.endTime !== null
            ? this.initState.endTime - this.initState.startTime
            : null;
        const initMessage: DisplayedMessage = {
          type: "workspace-init",
          id: "workspace-init",
          historySequence: -1, // Appears before all history
          status: this.initState.status,
          hookPath: this.initState.hookPath,
          lines: [...this.initState.lines], // Shallow copy for React.memo change detection
          exitCode: this.initState.exitCode,
          timestamp: this.initState.startTime,
          durationMs,
          truncatedLines: this.initState.truncatedLines,
        };
        resultMessages = [initMessage, ...resultMessages];
      }

      // Return the full array
      this.cache.displayedMessages = resultMessages;
    }
    return this.cache.displayedMessages;
  }

  /**
   * Get the toolCallId of the latest foreground bash that is currently executing.
   * Used by BashToolCall for auto-expand/collapse behavior.
   * Result is cached until the next mutation.
   */
  getLatestStreamingBashToolCallId(): string | null {
    if (this.cache.latestStreamingBashToolCallId === undefined) {
      const messages = this.getDisplayedMessages();
      let result: string | null = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.type === "tool" && msg.toolName === "bash" && msg.status === "executing") {
          const args = msg.args as { run_in_background?: boolean } | undefined;
          if (!args?.run_in_background) {
            result = msg.toolCallId;
            break;
          }
        }
      }
      this.cache.latestStreamingBashToolCallId = result;
    }
    return this.cache.latestStreamingBashToolCallId;
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
