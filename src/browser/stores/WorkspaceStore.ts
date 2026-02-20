import assert from "@/common/utils/assert";
import type { MuxMessage, DisplayedMessage, QueuedMessage } from "@/common/types/message";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type {
  WorkspaceActivitySnapshot,
  WorkspaceChatMessage,
  WorkspaceStatsSnapshot,
  OnChatMode,
} from "@/common/orpc/types";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import type { TodoItem } from "@/common/types/tools";
import { applyWorkspaceChatEventToAggregator } from "@/browser/utils/messages/applyWorkspaceChatEventToAggregator";
import {
  StreamingMessageAggregator,
  type LoadedSkill,
  type SkillLoadError,
} from "@/browser/utils/messages/StreamingMessageAggregator";
import { isAbortError } from "@/browser/utils/isAbortError";
import { BASH_TRUNCATE_MAX_TOTAL_BYTES } from "@/common/constants/toolLimits";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { useCallback, useSyncExternalStore } from "react";
import {
  isCaughtUpMessage,
  isStreamError,
  isDeleteMessage,
  isBashOutputEvent,
  isTaskCreatedEvent,
  isMuxMessage,
  isQueuedMessageChanged,
  isRestoreToInput,
} from "@/common/orpc/types";
import type {
  StreamAbortEvent,
  StreamAbortReasonSnapshot,
  StreamEndEvent,
  RuntimeStatusEvent,
} from "@/common/types/stream";
import { MapStore } from "./MapStore";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import { isDurableCompactionBoundaryMarker } from "@/common/utils/messages/compactionBoundary";
import { WorkspaceConsumerManager } from "./WorkspaceConsumerManager";
import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import { sumUsageHistory } from "@/common/utils/tokens/usageAggregator";
import type { TokenConsumer } from "@/common/types/chatStats";
import { normalizeGatewayModel } from "@/common/utils/ai/models";
import type { z } from "zod";
import type { SessionUsageFileSchema } from "@/common/orpc/schemas/chatStats";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import {
  appendLiveBashOutputChunk,
  type LiveBashOutputInternal,
  type LiveBashOutputView,
} from "@/browser/utils/messages/liveBashOutputBuffer";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getAutoCompactionThresholdKey, getAutoRetryKey } from "@/common/constants/storage";
import { DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT } from "@/common/constants/ui";
import { trackStreamCompleted } from "@/common/telemetry";

export type AutoRetryStatus = Extract<
  WorkspaceChatMessage,
  | { type: "auto-retry-scheduled" }
  | { type: "auto-retry-starting" }
  | { type: "auto-retry-abandoned" }
>;

export interface WorkspaceState {
  name: string; // User-facing workspace name (e.g., "feature-branch")
  messages: DisplayedMessage[];
  queuedMessage: QueuedMessage | null;
  canInterrupt: boolean;
  isCompacting: boolean;
  isStreamStarting: boolean;
  awaitingUserQuestion: boolean;
  loading: boolean;
  hasOlderHistory: boolean;
  loadingOlderHistory: boolean;
  muxMessages: MuxMessage[];
  currentModel: string | null;
  currentThinkingLevel: string | null;
  recencyTimestamp: number | null;
  todos: TodoItem[];
  loadedSkills: LoadedSkill[];
  skillLoadErrors: SkillLoadError[];
  agentStatus: { emoji: string; message: string; url?: string } | undefined;
  lastAbortReason: StreamAbortReasonSnapshot | null;
  pendingStreamStartTime: number | null;
  // Model used for the pending send (used during "starting" phase)
  pendingStreamModel: string | null;
  // Runtime status from ensureReady (for Coder workspace starting UX)
  runtimeStatus: RuntimeStatusEvent | null;
  autoRetryStatus: AutoRetryStatus | null;
  // Live streaming stats (updated on each stream-delta)
  streamingTokenCount: number | undefined;
  streamingTPS: number | undefined;
}

/**
 * Timing statistics for streaming sessions (active or completed).
 * When isActive=true, endTime is null and elapsed time should be computed live.
 * When isActive=false, endTime contains the completion timestamp.
 */
export interface StreamTimingStats {
  /** When the stream started (Date.now()) */
  startTime: number;
  /** When the stream ended, null if still active */
  endTime: number | null;
  /** When first content token arrived, null if still waiting */
  firstTokenTime: number | null;
  /** Accumulated tool execution time in ms */
  toolExecutionMs: number;
  /** Whether this is an active stream (true) or completed (false) */
  isActive: boolean;
  /** Model used for this stream */
  model: string;
  /** Output tokens (excludes reasoning/thinking tokens) - only available for completed streams */
  outputTokens?: number;
  /** Reasoning/thinking tokens - only available for completed streams */
  reasoningTokens?: number;
  /** Streaming duration in ms (first token to end) - only available for completed streams */
  streamingMs?: number;
  /** Live token count during streaming - only available for active streams */
  liveTokenCount?: number;
  /** Live tokens-per-second during streaming - only available for active streams */
  liveTPS?: number;
  /** Mode (plan/exec) in which this stream occurred */
  mode?: string;
}

/** Per-model timing statistics */
export interface ModelTimingStats {
  /** Total time spent in responses for this model */
  totalDurationMs: number;
  /** Total time spent executing tools for this model */
  totalToolExecutionMs: number;
  /** Total time spent streaming tokens (excludes TTFT) - for accurate tokens/sec */
  totalStreamingMs: number;
  /** Average time to first token for this model */
  averageTtftMs: number | null;
  /** Number of completed responses for this model */
  responseCount: number;
  /** Total output tokens generated by this model (excludes reasoning/thinking tokens) */
  totalOutputTokens: number;
  /** Total reasoning/thinking tokens generated by this model */
  totalReasoningTokens: number;
  /** Mode extracted from composite key (undefined for old data without mode) */
  mode?: string;
}

/**
 * Aggregate timing statistics across all completed streams in a session.
 */
export interface SessionTimingStats {
  /** Total time spent in all responses */
  totalDurationMs: number;
  /** Total time spent executing tools */
  totalToolExecutionMs: number;
  /** Total time spent streaming tokens (excludes TTFT) - for accurate tokens/sec */
  totalStreamingMs: number;
  /** Average time to first token (null if no responses had TTFT) */
  averageTtftMs: number | null;
  /** Number of completed responses */
  responseCount: number;
  /** Total output tokens generated across all models (excludes reasoning/thinking tokens) */
  totalOutputTokens: number;
  /** Total reasoning/thinking tokens generated across all models */
  totalReasoningTokens: number;
  /** Per-model timing breakdown */

  byModel: Record<string, ModelTimingStats>;
}

/**
 * Subset of WorkspaceState needed for sidebar display.
 * Subscribing to only these fields prevents re-renders when messages update.
 *
 * Note: timingStats/sessionStats are intentionally excluded - they update on every
 * streaming token. Components needing timing should use useWorkspaceStatsSnapshot().
 */
export interface WorkspaceSidebarState {
  canInterrupt: boolean;
  isStarting: boolean;
  awaitingUserQuestion: boolean;
  currentModel: string | null;
  recencyTimestamp: number | null;
  loadedSkills: LoadedSkill[];
  skillLoadErrors: SkillLoadError[];
  agentStatus: { emoji: string; message: string; url?: string } | undefined;
}

/**
 * Derived state values stored in the derived MapStore.
 * Currently only recency timestamps for workspace sorting.
 */
type DerivedState = Record<string, number>;

/**
 * Usage metadata extracted from API responses (no tokenization).
 * Updates instantly when usage metadata arrives.
 *
 * For multi-step tool calls, cost and context usage differ:
 * - sessionTotal: Pre-computed sum of all models from session-usage.json
 * - lastRequest: Last completed request (persisted for app restart)
 * - lastContextUsage: Last step's usage for context window display (inputTokens = actual context size)
 */
export interface WorkspaceUsageState {
  /** Pre-computed session total (sum of all models) */
  sessionTotal?: ChatUsageDisplay;
  /** Last completed request (persisted) */
  lastRequest?: {
    model: string;
    usage: ChatUsageDisplay;
    timestamp: number;
  };
  /** Last message's context usage (last step only, for context window display) */
  lastContextUsage?: ChatUsageDisplay;
  totalTokens: number;
  /** Live context usage during streaming (last step's inputTokens = current context window) */
  liveUsage?: ChatUsageDisplay;
  /** Live cost usage during streaming (cumulative across all steps) */
  liveCostUsage?: ChatUsageDisplay;
}

/**
 * Consumer breakdown requiring tokenization (lazy calculation).
 * Updates after async Web Worker calculation completes.
 */
export interface WorkspaceConsumersState {
  consumers: TokenConsumer[];
  tokenizerName: string;
  totalTokens: number; // Total from tokenization (may differ from usage totalTokens)
  isCalculating: boolean;
  topFilePaths?: Array<{ path: string; tokens: number }>; // Top 10 files aggregated across all file tools
}

interface WorkspaceChatTransientState {
  caughtUp: boolean;
  historicalMessages: MuxMessage[];
  pendingStreamEvents: WorkspaceChatMessage[];
  replayingHistory: boolean;
  queuedMessage: QueuedMessage | null;
  liveBashOutput: Map<string, LiveBashOutputInternal>;
  liveTaskIds: Map<string, string>;
  autoRetryStatus: AutoRetryStatus | null;
}

interface HistoryPaginationCursor {
  beforeHistorySequence: number;
  beforeMessageId?: string | null;
}

interface WorkspaceHistoryPaginationState {
  nextCursor: HistoryPaginationCursor | null;
  hasOlder: boolean;
  loading: boolean;
}

function areHistoryPaginationCursorsEqual(
  a: HistoryPaginationCursor | null,
  b: HistoryPaginationCursor | null
): boolean {
  if (a === b) {
    return true;
  }

  if (!a || !b) {
    return false;
  }

  return (
    a.beforeHistorySequence === b.beforeHistorySequence &&
    (a.beforeMessageId ?? null) === (b.beforeMessageId ?? null)
  );
}

function createInitialHistoryPaginationState(): WorkspaceHistoryPaginationState {
  return {
    nextCursor: null,
    hasOlder: false,
    loading: false,
  };
}

function createInitialChatTransientState(): WorkspaceChatTransientState {
  return {
    caughtUp: false,
    historicalMessages: [],
    pendingStreamEvents: [],
    replayingHistory: false,
    queuedMessage: null,
    liveBashOutput: new Map(),
    liveTaskIds: new Map(),
    autoRetryStatus: null,
  };
}

const ON_CHAT_RETRY_BASE_MS = 250;
const ON_CHAT_RETRY_MAX_MS = 5000;

// Stall detection: server sends heartbeats every 5s, so if we don't receive any events
// (including heartbeats) for 10s, the connection is likely dead. This handles half-open
// WebSocket paths (e.g., some WSL localhost forwarding setups).
const ON_CHAT_STALL_TIMEOUT_MS = 10_000;
const ON_CHAT_STALL_CHECK_INTERVAL_MS = 2_000;

interface ValidationIssue {
  path?: Array<string | number>;
  message?: string;
}

type IteratorValidationFailedError = Error & {
  code: "EVENT_ITERATOR_VALIDATION_FAILED";
  cause?: {
    issues?: ValidationIssue[];
    data?: unknown;
  };
};

function isIteratorValidationFailed(error: unknown): error is IteratorValidationFailedError {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === "EVENT_ITERATOR_VALIDATION_FAILED"
  );
}

/**
 * Extract a human-readable summary from an iterator validation error.
 * ORPC wraps Zod issues in error.cause with { issues: [...], data: ... }
 */
function formatValidationError(error: IteratorValidationFailedError): string {
  const cause = error.cause;
  if (!cause) {
    return "Unknown validation error (no cause)";
  }

  const issues = cause.issues ?? [];
  if (issues.length === 0) {
    return `Unknown validation error (no issues). Data: ${JSON.stringify(cause.data)}`;
  }

  // Format issues like: "type: Invalid discriminator value" or "metadata.usage.inputTokens: Expected number"
  const issuesSummary = issues
    .slice(0, 3) // Limit to first 3 issues
    .map((issue) => {
      const path = issue.path?.join(".") ?? "(root)";
      const message = issue.message ?? "Unknown issue";
      return `${path}: ${message}`;
    })
    .join("; ");

  const moreCount = issues.length > 3 ? ` (+${issues.length - 3} more)` : "";

  // Include the event type if available
  const data = cause.data as { type?: string } | undefined;
  const eventType = data?.type ? ` [event: ${data.type}]` : "";

  return `${issuesSummary}${moreCount}${eventType}`;
}

function calculateOnChatBackoffMs(attempt: number): number {
  return Math.min(ON_CHAT_RETRY_BASE_MS * 2 ** attempt, ON_CHAT_RETRY_MAX_MS);
}

function getMaxHistorySequence(messages: MuxMessage[]): number | undefined {
  let max: number | undefined;
  for (const message of messages) {
    const seq = message.metadata?.historySequence;
    if (typeof seq !== "number") {
      continue;
    }
    if (max === undefined || seq > max) {
      max = seq;
    }
  }
  return max;
}

/**
 * External store for workspace aggregators and streaming state.
 *
 * This store lives outside React's lifecycle and manages all workspace
 * message aggregation and IPC subscriptions. Components subscribe to
 * specific workspaces via useSyncExternalStore, ensuring only relevant
 * components re-render when workspace state changes.
 */
export class WorkspaceStore {
  // Per-workspace state (lazy computed on get)
  private states = new MapStore<string, WorkspaceState>();

  // Derived aggregate state (computed from multiple workspaces)
  private derived = new MapStore<string, DerivedState>();

  // Usage and consumer stores (two-store approach for CostsTab optimization)
  private usageStore = new MapStore<string, WorkspaceUsageState>();
  private client: RouterClient<AppRouter> | null = null;
  private clientChangeController = new AbortController();
  // Workspaces that need a clean history replay once a new iterator is established.
  // We keep the existing UI visible until the replay can actually start.
  private pendingReplayReset = new Set<string>();
  private consumersStore = new MapStore<string, WorkspaceConsumersState>();

  // Manager for consumer calculations (debouncing, caching, lazy loading)
  // Architecture: WorkspaceStore orchestrates (decides when), manager executes (performs calculations)
  // Dual-cache: consumersStore (MapStore) handles subscriptions, manager owns data cache
  private readonly consumerManager: WorkspaceConsumerManager;

  // Supporting data structures
  private aggregators = new Map<string, StreamingMessageAggregator>();
  // Active onChat subscription cleanup handlers (must stay size <= 1).
  private ipcUnsubscribers = new Map<string, () => void>();

  // Workspace selected in the UI (set from WorkspaceContext routing state).
  private activeWorkspaceId: string | null = null;

  // Workspace currently owning the live onChat subscription.
  private activeOnChatWorkspaceId: string | null = null;

  // Lightweight activity snapshots from workspace.activity.list/subscribe.
  private workspaceActivity = new Map<string, WorkspaceActivitySnapshot>();
  // Recency timestamp observed when a workspace transitions into streaming=true.
  // Used to distinguish true stream completion (recency bumps on stream-end) from
  // abort/error transitions (streaming=false without recency advance).
  private activityStreamingStartRecency = new Map<string, number>();
  private activityAbortController: AbortController | null = null;

  // Per-workspace ephemeral chat state (buffering, queued message, live bash output, etc.)
  private chatTransientState = new Map<string, WorkspaceChatTransientState>();

  // Per-workspace transcript pagination state for loading prior compaction epochs.
  private historyPagination = new Map<string, WorkspaceHistoryPaginationState>();

  private workspaceMetadata = new Map<string, FrontendWorkspaceMetadata>(); // Store metadata for name lookup

  // Workspace timing stats snapshots (from workspace.stats.subscribe)
  private statsEnabled = false;
  private workspaceStats = new Map<string, WorkspaceStatsSnapshot>();
  private statsStore = new MapStore<string, WorkspaceStatsSnapshot | null>();
  private statsUnsubscribers = new Map<string, () => void>();
  // Per-workspace listener refcount for useWorkspaceStatsSnapshot().
  // Used to only subscribe to backend stats when something in the UI is actually reading them.
  private statsListenerCounts = new Map<string, number>();
  // Cumulative session usage (from session-usage.json)

  private sessionUsage = new Map<string, z.infer<typeof SessionUsageFileSchema>>();

  // Idle compaction notification callbacks (called when backend signals idle compaction started)
  private idleCompactionCallbacks = new Set<(workspaceId: string) => void>();

  // Global callback for navigating to a workspace (set by App, used for notification clicks)
  private navigateToWorkspaceCallback: ((workspaceId: string) => void) | null = null;

  // Global callback when a response completes (for "notify on response" feature)
  // isFinal is true when no more active streams remain (assistant done with all work)
  // finalText is the text content after any tool calls (for notification body)
  // compaction is provided when this was a compaction stream (includes continue metadata)
  private responseCompleteCallback:
    | ((
        workspaceId: string,
        messageId: string,
        isFinal: boolean,
        finalText: string,
        compaction?: { hasContinueMessage: boolean },
        completedAt?: number | null
      ) => void)
    | null = null;

  // Tracks when a file-modifying tool (file_edit_*, bash) last completed per workspace.
  // ReviewPanel subscribes to trigger diff refresh. Two structures:
  // - timestamps: actual Date.now() values for cache invalidation checks
  // - subscriptions: MapStore for per-workspace subscription support
  private fileModifyingToolMs = new Map<string, number>();
  private fileModifyingToolSubs = new MapStore<string, void>();

  // Idle callback handles for high-frequency delta events to reduce re-renders during streaming.
  // Data is always updated immediately in the aggregator; only UI notification is scheduled.
  // Using requestIdleCallback adapts to actual CPU availability rather than a fixed timer.
  private deltaIdleHandles = new Map<string, number>();

  /**
   * Map of event types to their handlers. This is the single source of truth for:
   * 1. Which events should be buffered during replay (the keys)
   * 2. How to process those events (the values)
   *
   * By keeping check and processing in one place, we make it structurally impossible
   * to buffer an event type without having a handler for it.
   */
  private readonly bufferedEventHandlers: Record<
    string,
    (
      workspaceId: string,
      aggregator: StreamingMessageAggregator,
      data: WorkspaceChatMessage
    ) => void
  > = {
    "stream-start": (workspaceId, aggregator, data) => {
      applyWorkspaceChatEventToAggregator(aggregator, data);
      if (this.onModelUsed) {
        this.onModelUsed((data as { model: string }).model);
      }

      // A new stream supersedes any prior retry banner state.
      const transient = this.assertChatTransientState(workspaceId);
      transient.autoRetryStatus = null;

      this.states.bump(workspaceId);
      // Bump usage store so liveUsage is recomputed with new activeStreamId
      this.usageStore.bump(workspaceId);
    },
    "stream-delta": (workspaceId, aggregator, data) => {
      applyWorkspaceChatEventToAggregator(aggregator, data);
      this.scheduleIdleStateBump(workspaceId);
    },
    "stream-end": (workspaceId, aggregator, data) => {
      const streamEndData = data as StreamEndEvent;
      applyWorkspaceChatEventToAggregator(aggregator, streamEndData);

      // Track stream completion telemetry
      this.trackStreamCompletedTelemetry(streamEndData, false);

      const transient = this.assertChatTransientState(workspaceId);
      transient.autoRetryStatus = null;

      // Update local session usage (mirrors backend's addUsage)
      const model = streamEndData.metadata?.model;
      const rawUsage = streamEndData.metadata?.usage;
      const providerMetadata = streamEndData.metadata?.providerMetadata;
      if (model && rawUsage) {
        const usage = createDisplayUsage(rawUsage, model, providerMetadata);
        if (usage) {
          const normalizedModel = normalizeGatewayModel(model);
          const current = this.sessionUsage.get(workspaceId) ?? {
            byModel: {},
            version: 1 as const,
          };
          const existing = current.byModel[normalizedModel];
          // CRITICAL: Accumulate, don't overwrite (same logic as backend)
          current.byModel[normalizedModel] = existing ? sumUsageHistory([existing, usage])! : usage;
          current.lastRequest = { model: normalizedModel, usage, timestamp: Date.now() };
          this.sessionUsage.set(workspaceId, current);
        }
      }

      // Flush any pending debounced bump before final bump to avoid double-bump
      this.cancelPendingIdleBump(workspaceId);
      this.states.bump(workspaceId);
      this.checkAndBumpRecencyIfChanged();
      this.finalizeUsageStats(workspaceId, streamEndData.metadata);
    },
    "stream-abort": (workspaceId, aggregator, data) => {
      const streamAbortData = data as StreamAbortEvent;
      applyWorkspaceChatEventToAggregator(aggregator, streamAbortData);

      // Track stream interruption telemetry (get model from aggregator)
      const model = aggregator.getCurrentModel();
      if (model) {
        this.trackStreamCompletedTelemetry(
          {
            metadata: {
              model,
              usage: streamAbortData.metadata?.usage,
              duration: streamAbortData.metadata?.duration,
            },
          },
          true
        );
      }

      // Flush any pending debounced bump before final bump to avoid double-bump
      this.cancelPendingIdleBump(workspaceId);
      this.states.bump(workspaceId);
      this.finalizeUsageStats(workspaceId, streamAbortData.metadata);
    },
    "tool-call-start": (workspaceId, aggregator, data) => {
      applyWorkspaceChatEventToAggregator(aggregator, data);
      this.states.bump(workspaceId);
    },
    "tool-call-delta": (workspaceId, aggregator, data) => {
      applyWorkspaceChatEventToAggregator(aggregator, data);
      this.scheduleIdleStateBump(workspaceId);
    },
    "tool-call-end": (workspaceId, aggregator, data) => {
      const toolCallEnd = data as Extract<WorkspaceChatMessage, { type: "tool-call-end" }>;

      // Cleanup live bash output once the real tool result contains output.
      // If output is missing (e.g. tmpfile overflow), keep the tail buffer so the UI still shows something.
      if (toolCallEnd.toolName === "bash") {
        const transient = this.chatTransientState.get(workspaceId);
        if (transient) {
          const output = (toolCallEnd.result as { output?: unknown } | undefined)?.output;
          if (typeof output === "string") {
            transient.liveBashOutput.delete(toolCallEnd.toolCallId);
          } else {
            // If we keep the tail buffer, ensure we don't get stuck in "filtering" UI state.
            const prev = transient.liveBashOutput.get(toolCallEnd.toolCallId);
            if (prev?.phase === "filtering") {
              const next = appendLiveBashOutputChunk(
                prev,
                { text: "", isError: false, phase: "output" },
                BASH_TRUNCATE_MAX_TOTAL_BYTES
              );
              if (next !== prev) {
                transient.liveBashOutput.set(toolCallEnd.toolCallId, next);
              }
            }
          }
        }
      }

      // Cleanup ephemeral taskId storage once the actual tool result is available.
      if (toolCallEnd.toolName === "task") {
        const transient = this.chatTransientState.get(workspaceId);
        transient?.liveTaskIds.delete(toolCallEnd.toolCallId);
      }
      applyWorkspaceChatEventToAggregator(aggregator, data);

      this.states.bump(workspaceId);
      this.consumerManager.scheduleCalculation(workspaceId, aggregator);

      // Track file-modifying tools for ReviewPanel diff refresh.
      const shouldTriggerReviewPanelRefresh =
        toolCallEnd.toolName.startsWith("file_edit_") || toolCallEnd.toolName === "bash";

      if (shouldTriggerReviewPanelRefresh) {
        this.fileModifyingToolMs.set(workspaceId, Date.now());
        this.fileModifyingToolSubs.bump(workspaceId);
      }
    },
    "reasoning-delta": (workspaceId, aggregator, data) => {
      applyWorkspaceChatEventToAggregator(aggregator, data);
      this.scheduleIdleStateBump(workspaceId);
    },
    "reasoning-end": (workspaceId, aggregator, data) => {
      applyWorkspaceChatEventToAggregator(aggregator, data);
      this.states.bump(workspaceId);
    },
    "runtime-status": (workspaceId, aggregator, data) => {
      applyWorkspaceChatEventToAggregator(aggregator, data);
      this.states.bump(workspaceId);
    },
    "auto-compaction-triggered": (workspaceId) => {
      // Informational event from backend auto-compaction monitor.
      // We bump workspace state so warning/banner components can react immediately.
      this.states.bump(workspaceId);
    },
    "auto-compaction-completed": (workspaceId) => {
      // Compaction resets context usage; force both stores to recompute from compacted history.
      this.usageStore.bump(workspaceId);
      this.states.bump(workspaceId);
    },
    "auto-retry-scheduled": (workspaceId, _aggregator, data) => {
      const transient = this.assertChatTransientState(workspaceId);
      transient.autoRetryStatus = data as Extract<
        WorkspaceChatMessage,
        { type: "auto-retry-scheduled" }
      >;
      this.states.bump(workspaceId);
    },
    "auto-retry-starting": (workspaceId, _aggregator, data) => {
      const transient = this.assertChatTransientState(workspaceId);
      transient.autoRetryStatus = data as Extract<
        WorkspaceChatMessage,
        { type: "auto-retry-starting" }
      >;
      this.states.bump(workspaceId);
    },
    "auto-retry-abandoned": (workspaceId, _aggregator, data) => {
      const transient = this.assertChatTransientState(workspaceId);
      transient.autoRetryStatus = data as Extract<
        WorkspaceChatMessage,
        { type: "auto-retry-abandoned" }
      >;
      this.states.bump(workspaceId);
    },
    "session-usage-delta": (workspaceId, _aggregator, data) => {
      const usageDelta = data as Extract<WorkspaceChatMessage, { type: "session-usage-delta" }>;

      const current = this.sessionUsage.get(workspaceId) ?? {
        byModel: {},
        version: 1 as const,
      };

      for (const [model, usage] of Object.entries(usageDelta.byModelDelta)) {
        const existing = current.byModel[model];
        current.byModel[model] = existing ? sumUsageHistory([existing, usage])! : usage;
      }

      this.sessionUsage.set(workspaceId, current);
      this.usageStore.bump(workspaceId);
    },
    "usage-delta": (workspaceId, aggregator, data) => {
      applyWorkspaceChatEventToAggregator(aggregator, data);
      this.usageStore.bump(workspaceId);
    },
    "init-start": (workspaceId, aggregator, data) => {
      applyWorkspaceChatEventToAggregator(aggregator, data);
      this.states.bump(workspaceId);
    },
    "init-output": (workspaceId, aggregator, data) => {
      applyWorkspaceChatEventToAggregator(aggregator, data);
      // Init output can be very high-frequency (e.g. installs, rsync). Like stream/tool deltas,
      // we update aggregator state immediately but coalesce UI bumps to keep the renderer responsive.
      this.scheduleIdleStateBump(workspaceId);
    },
    "init-end": (workspaceId, aggregator, data) => {
      applyWorkspaceChatEventToAggregator(aggregator, data);
      // Avoid a double-bump if an init-output idle bump is pending.
      this.cancelPendingIdleBump(workspaceId);
      this.states.bump(workspaceId);
    },
    "queued-message-changed": (workspaceId, _aggregator, data) => {
      if (!isQueuedMessageChanged(data)) return;

      // Create QueuedMessage once here instead of on every render
      // Use displayText which handles slash commands (shows /compact instead of expanded prompt)
      // Show queued message if there's text OR attachments OR reviews (support review-only queued messages)
      const hasContent =
        data.queuedMessages.length > 0 ||
        (data.fileParts?.length ?? 0) > 0 ||
        (data.reviews?.length ?? 0) > 0;
      const queuedMessage: QueuedMessage | null = hasContent
        ? {
            id: `queued-${workspaceId}`,
            content: data.displayText,
            fileParts: data.fileParts,
            reviews: data.reviews,
            hasCompactionRequest: data.hasCompactionRequest,
          }
        : null;

      this.assertChatTransientState(workspaceId).queuedMessage = queuedMessage;
      this.states.bump(workspaceId);
    },
    "restore-to-input": (_workspaceId, _aggregator, data) => {
      if (!isRestoreToInput(data)) return;

      // Use UPDATE_CHAT_INPUT event with mode="replace"
      window.dispatchEvent(
        createCustomEvent(CUSTOM_EVENTS.UPDATE_CHAT_INPUT, {
          text: data.text,
          mode: "replace",
          fileParts: data.fileParts,
          reviews: data.reviews,
        })
      );
    },
  };

  // Cache of last known recency per workspace (for change detection)
  private recencyCache = new Map<string, number | null>();

  // Store workspace metadata for aggregator creation (ensures createdAt never lost)
  private workspaceCreatedAt = new Map<string, string>();

  // Track previous sidebar state per workspace (to prevent unnecessary bumps)
  private previousSidebarValues = new Map<string, WorkspaceSidebarState>();

  // Track model usage (optional integration point for model bookkeeping)
  private readonly onModelUsed?: (model: string) => void;

  constructor(onModelUsed?: (model: string) => void) {
    this.onModelUsed = onModelUsed;

    // Initialize consumer calculation manager
    this.consumerManager = new WorkspaceConsumerManager((workspaceId) => {
      this.consumersStore.bump(workspaceId);
    });

    // Note: We DON'T auto-check recency on every state bump.
    // Instead, checkAndBumpRecencyIfChanged() is called explicitly after
    // message completion events (not on deltas) to prevent App.tsx re-renders.
  }

  setStatsEnabled(enabled: boolean): void {
    if (this.statsEnabled === enabled) {
      return;
    }

    this.statsEnabled = enabled;

    if (!enabled) {
      for (const unsubscribe of this.statsUnsubscribers.values()) {
        unsubscribe();
      }
      this.statsUnsubscribers.clear();
      this.workspaceStats.clear();
      this.statsStore.clear();

      // Clear is a global notification only. Bump any subscribed workspace IDs so
      // useSyncExternalStore subscribers re-render and drop stale snapshots.
      for (const workspaceId of this.statsListenerCounts.keys()) {
        this.statsStore.bump(workspaceId);
      }
      return;
    }

    // Enable subscriptions for any workspaces that already have UI consumers.
    for (const workspaceId of this.statsListenerCounts.keys()) {
      this.subscribeToStats(workspaceId);
    }
  }
  setClient(client: RouterClient<AppRouter> | null): void {
    if (this.client === client) {
      return;
    }

    // Drop stats subscriptions before swapping clients so reconnects resubscribe cleanly.
    for (const unsubscribe of this.statsUnsubscribers.values()) {
      unsubscribe();
    }
    this.statsUnsubscribers.clear();

    this.client = client;
    this.clientChangeController.abort();
    this.clientChangeController = new AbortController();

    for (const workspaceId of this.workspaceMetadata.keys()) {
      this.pendingReplayReset.add(workspaceId);
    }

    if (client) {
      this.ensureActivitySubscription();
    }

    if (!client) {
      return;
    }

    // If timing stats are enabled, re-subscribe any workspaces that already have UI consumers.
    if (this.statsEnabled) {
      for (const workspaceId of this.statsListenerCounts.keys()) {
        this.subscribeToStats(workspaceId);
      }
    }

    this.ensureActiveOnChatSubscription();
  }

  setActiveWorkspaceId(workspaceId: string | null): void {
    assert(
      workspaceId === null || (typeof workspaceId === "string" && workspaceId.length > 0),
      "setActiveWorkspaceId requires a non-empty workspaceId or null"
    );

    if (this.activeWorkspaceId === workspaceId) {
      return;
    }

    const previousActiveId = this.activeWorkspaceId;
    this.activeWorkspaceId = workspaceId;
    this.ensureActiveOnChatSubscription();

    // Invalidate cached workspace state for both the old and new active
    // workspaces. getWorkspaceState() uses activeOnChatWorkspaceId to decide
    // whether to trust aggregator data or activity snapshots, so a switch
    // requires recomputation even if no new events arrived.
    if (previousActiveId) {
      this.states.bump(previousActiveId);
    }
    if (workspaceId) {
      this.states.bump(workspaceId);
    }
  }

  isOnChatSubscriptionActive(workspaceId: string): boolean {
    assert(
      typeof workspaceId === "string" && workspaceId.length > 0,
      "isOnChatSubscriptionActive requires a non-empty workspaceId"
    );

    return this.activeOnChatWorkspaceId === workspaceId;
  }

  private ensureActivitySubscription(): void {
    if (this.activityAbortController) {
      return;
    }

    const controller = new AbortController();
    this.activityAbortController = controller;
    void this.runActivitySubscription(controller.signal);
  }

  private assertSingleActiveOnChatSubscription(): void {
    assert(
      this.ipcUnsubscribers.size <= 1,
      `[WorkspaceStore] Expected at most one active onChat subscription, found ${this.ipcUnsubscribers.size}`
    );

    if (this.activeOnChatWorkspaceId === null) {
      assert(
        this.ipcUnsubscribers.size === 0,
        "[WorkspaceStore] onChat unsubscribe map must be empty when no active workspace is subscribed"
      );
      return;
    }

    assert(
      this.ipcUnsubscribers.has(this.activeOnChatWorkspaceId),
      `[WorkspaceStore] Missing onChat unsubscribe handler for ${this.activeOnChatWorkspaceId}`
    );
  }

  private clearReplayBuffers(workspaceId: string): void {
    const transient = this.chatTransientState.get(workspaceId);
    if (!transient) {
      return;
    }

    // Replay buffers are only valid for the in-flight subscription attempt that
    // populated them. Clear eagerly when deactivating/retrying so stale buffered
    // events cannot leak into a later caught-up cycle.
    transient.caughtUp = false;
    transient.replayingHistory = false;
    transient.historicalMessages.length = 0;
    transient.pendingStreamEvents.length = 0;
  }

  private ensureActiveOnChatSubscription(): void {
    const targetWorkspaceId =
      this.activeWorkspaceId && this.isWorkspaceRegistered(this.activeWorkspaceId)
        ? this.activeWorkspaceId
        : null;

    if (this.activeOnChatWorkspaceId === targetWorkspaceId) {
      this.assertSingleActiveOnChatSubscription();
      return;
    }

    if (this.activeOnChatWorkspaceId) {
      const previousActiveWorkspaceId = this.activeOnChatWorkspaceId;
      // Clear replay buffers before aborting so a fast workspace switch/reopen
      // cannot replay stale buffered rows from the previous subscription attempt.
      this.clearReplayBuffers(previousActiveWorkspaceId);

      const unsubscribe = this.ipcUnsubscribers.get(previousActiveWorkspaceId);
      if (unsubscribe) {
        unsubscribe();
      }
      this.ipcUnsubscribers.delete(previousActiveWorkspaceId);
      this.activeOnChatWorkspaceId = null;
    }

    if (targetWorkspaceId) {
      const controller = new AbortController();
      this.ipcUnsubscribers.set(targetWorkspaceId, () => controller.abort());
      this.activeOnChatWorkspaceId = targetWorkspaceId;
      void this.runOnChatSubscription(targetWorkspaceId, controller.signal);
    }

    this.assertSingleActiveOnChatSubscription();
  }

  /**
   * Set the callback for navigating to a workspace (used for notification clicks)
   */
  setNavigateToWorkspace(callback: (workspaceId: string) => void): void {
    this.navigateToWorkspaceCallback = callback;
    // Update existing aggregators with the callback
    for (const aggregator of this.aggregators.values()) {
      aggregator.onNavigateToWorkspace = callback;
    }
  }

  navigateToWorkspace(workspaceId: string): void {
    this.navigateToWorkspaceCallback?.(workspaceId);
  }

  /**
   * Set the callback for when a response completes (used for "notify on response" feature).
   * isFinal is true when no more active streams remain (assistant done with all work).
   * finalText is the text content after any tool calls (for notification body).
   * compaction is provided when this was a compaction stream (includes continue metadata).
   */
  setOnResponseComplete(
    callback: (
      workspaceId: string,
      messageId: string,
      isFinal: boolean,
      finalText: string,
      compaction?: { hasContinueMessage: boolean },
      completedAt?: number | null
    ) => void
  ): void {
    this.responseCompleteCallback = callback;
    // Update existing aggregators with the callback
    for (const aggregator of this.aggregators.values()) {
      aggregator.onResponseComplete = callback;
    }
  }

  /**
   * Schedule a state bump during browser idle time.
   * Instead of updating UI on every delta, wait until the browser has spare capacity.
   * This adapts to actual CPU availability - fast machines update more frequently,
   * slow machines naturally throttle without dropping data.
   *
   * Data is always updated immediately in the aggregator - only UI notification is deferred.
   *
   * NOTE: This is the "ingestion clock" half of the two-clock streaming model.
   * The "presentation clock" (useSmoothStreamingText) handles visual cadence
   * independently — do not collapse them into a single mechanism.
   */
  private scheduleIdleStateBump(workspaceId: string): void {
    // Skip if already scheduled
    if (this.deltaIdleHandles.has(workspaceId)) {
      return;
    }

    // requestIdleCallback is not available in some environments (e.g. Node-based unit tests).
    // Fall back to a regular timeout so we still throttle bumps.
    if (typeof requestIdleCallback !== "function") {
      const handle = setTimeout(() => {
        this.deltaIdleHandles.delete(workspaceId);
        this.states.bump(workspaceId);
      }, 0);

      this.deltaIdleHandles.set(workspaceId, handle as unknown as number);
      return;
    }

    const handle = requestIdleCallback(
      () => {
        this.deltaIdleHandles.delete(workspaceId);
        this.states.bump(workspaceId);
      },
      { timeout: 100 } // Force update within 100ms even if browser stays busy
    );

    this.deltaIdleHandles.set(workspaceId, handle);
  }

  /**
   * Defer the caught-up usage bump until idle time so first transcript paint is not blocked
   * by a second full ChatPane pass that only refreshes usage-derived UI.
   */
  private scheduleCaughtUpUsageBump(workspaceId: string): void {
    const bumpUsage = () => {
      const transient = this.chatTransientState.get(workspaceId);
      if (!transient?.caughtUp || !this.aggregators.has(workspaceId)) {
        return;
      }
      this.usageStore.bump(workspaceId);
    };

    if (typeof requestIdleCallback !== "function") {
      setTimeout(bumpUsage, 0);
      return;
    }

    requestIdleCallback(bumpUsage, { timeout: 100 });
  }

  /**
   * Subscribe to backend timing stats snapshots for a workspace.
   */

  private subscribeToStats(workspaceId: string): void {
    if (!this.client || !this.statsEnabled) {
      return;
    }

    // Only subscribe for registered workspaces when we have at least one UI consumer.
    if (!this.isWorkspaceRegistered(workspaceId)) {
      return;
    }
    if ((this.statsListenerCounts.get(workspaceId) ?? 0) <= 0) {
      return;
    }

    // Skip if already subscribed
    if (this.statsUnsubscribers.has(workspaceId)) {
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;
    let iterator: AsyncIterator<WorkspaceStatsSnapshot> | null = null;

    (async () => {
      try {
        const subscribedIterator = await this.client!.workspace.stats.subscribe(
          { workspaceId },
          { signal }
        );
        iterator = subscribedIterator;

        for await (const snapshot of subscribedIterator) {
          if (signal.aborted) break;
          queueMicrotask(() => {
            if (signal.aborted) {
              return;
            }
            this.workspaceStats.set(workspaceId, snapshot);
            this.statsStore.bump(workspaceId);
          });
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        console.warn(`[WorkspaceStore] Error in stats subscription for ${workspaceId}:`, error);
      }
    })();

    this.statsUnsubscribers.set(workspaceId, () => {
      controller.abort();
      void iterator?.return?.();
    });
  }

  /**
   * Cancel any pending idle state bump for a workspace.
   * Used when immediate state visibility is needed (e.g., stream-end).
   * Just cancels the callback - the caller will bump() immediately after.
   */
  private cancelPendingIdleBump(workspaceId: string): void {
    const handle = this.deltaIdleHandles.get(workspaceId);
    if (handle) {
      if (typeof cancelIdleCallback === "function") {
        cancelIdleCallback(handle);
      } else {
        clearTimeout(handle as unknown as number);
      }
      this.deltaIdleHandles.delete(workspaceId);
    }
  }

  /**
   * Track stream completion telemetry
   */
  private trackStreamCompletedTelemetry(
    data: {
      metadata: {
        model: string;
        usage?: { outputTokens?: number };
        duration?: number;
      };
    },
    wasInterrupted: boolean
  ): void {
    const { metadata } = data;
    const durationSecs = metadata.duration ? metadata.duration / 1000 : 0;
    const outputTokens = metadata.usage?.outputTokens ?? 0;

    // trackStreamCompleted handles rounding internally
    trackStreamCompleted(metadata.model, wasInterrupted, durationSecs, outputTokens);
  }

  /**
   * Check if any workspace's recency changed and bump global recency if so.
   * Uses cached recency values from aggregators for O(1) comparison per workspace.
   */
  private checkAndBumpRecencyIfChanged(): void {
    let recencyChanged = false;

    for (const workspaceId of this.aggregators.keys()) {
      const aggregator = this.aggregators.get(workspaceId)!;
      const currentRecency = aggregator.getRecencyTimestamp();
      const cachedRecency = this.recencyCache.get(workspaceId);

      if (currentRecency !== cachedRecency) {
        this.recencyCache.set(workspaceId, currentRecency);
        recencyChanged = true;
      }
    }

    if (recencyChanged) {
      this.derived.bump("recency");
    }
  }

  private cleanupStaleLiveBashOutput(
    workspaceId: string,
    aggregator: StreamingMessageAggregator
  ): void {
    const perWorkspace = this.chatTransientState.get(workspaceId)?.liveBashOutput;
    if (!perWorkspace || perWorkspace.size === 0) return;

    const activeToolCallIds = new Set<string>();
    for (const msg of aggregator.getDisplayedMessages()) {
      if (msg.type === "tool" && msg.toolName === "bash") {
        activeToolCallIds.add(msg.toolCallId);
      }
    }

    for (const toolCallId of Array.from(perWorkspace.keys())) {
      if (!activeToolCallIds.has(toolCallId)) {
        perWorkspace.delete(toolCallId);
      }
    }
  }

  /**
   * Subscribe to store changes (any workspace).
   * Delegates to MapStore's subscribeAny.
   */
  subscribe = this.states.subscribeAny;

  /**
   * Subscribe to derived state changes (recency, etc.).
   * Use for hooks that depend on derived.bump() rather than states.bump().
   */
  subscribeDerived = this.derived.subscribeAny;

  /**
   * Subscribe to changes for a specific workspace.
   * Only notified when this workspace's state changes.
   */
  subscribeKey = (workspaceId: string, listener: () => void) => {
    return this.states.subscribeKey(workspaceId, listener);
  };

  getBashToolLiveOutput(workspaceId: string, toolCallId: string): LiveBashOutputView | null {
    const state = this.chatTransientState.get(workspaceId)?.liveBashOutput.get(toolCallId);

    // Important: return the stored object reference so useSyncExternalStore sees a stable snapshot.
    // (Returning a fresh object every call can trigger an infinite re-render loop.)
    return state ?? null;
  }

  getTaskToolLiveTaskId(workspaceId: string, toolCallId: string): string | null {
    const taskId = this.chatTransientState.get(workspaceId)?.liveTaskIds.get(toolCallId);
    return taskId ?? null;
  }

  /**
   * Assert that workspace exists and return its aggregator.
   * Centralized assertion for all workspace access methods.
   */
  private assertGet(workspaceId: string): StreamingMessageAggregator {
    const aggregator = this.aggregators.get(workspaceId);
    assert(aggregator, `Workspace ${workspaceId} not found - must call addWorkspace() first`);
    return aggregator;
  }

  private assertChatTransientState(workspaceId: string): WorkspaceChatTransientState {
    const state = this.chatTransientState.get(workspaceId);
    assert(state, `Workspace ${workspaceId} not found - must call addWorkspace() first`);
    return state;
  }

  private deriveHistoryPaginationState(
    aggregator: StreamingMessageAggregator,
    hasOlderOverride?: boolean
  ): WorkspaceHistoryPaginationState {
    for (const message of aggregator.getAllMessages()) {
      const historySequence = message.metadata?.historySequence;
      if (
        typeof historySequence !== "number" ||
        !Number.isInteger(historySequence) ||
        historySequence < 0
      ) {
        continue;
      }

      // The server's caught-up payload is authoritative for full replays because
      // display-only messages can skip early historySequence rows. When legacy
      // payloads omit hasOlderHistory, only infer older pages when the oldest
      // loaded message is a durable compaction boundary marker (a concrete signal
      // that this replay started mid-history), not merely historySequence > 0.
      const hasOlder =
        hasOlderOverride ?? (historySequence > 0 && isDurableCompactionBoundaryMarker(message));
      return {
        nextCursor: hasOlder
          ? {
              beforeHistorySequence: historySequence,
              beforeMessageId: message.id,
            }
          : null,
        hasOlder,
        loading: false,
      };
    }

    if (hasOlderOverride !== undefined) {
      return {
        nextCursor: null,
        hasOlder: hasOlderOverride,
        loading: false,
      };
    }

    return createInitialHistoryPaginationState();
  }

  /**
   * Get state for a specific workspace.
   * Lazy computation - only runs when version changes.
   *
   * REQUIRES: Workspace must have been added via addWorkspace() first.
   */
  getWorkspaceState(workspaceId: string): WorkspaceState {
    return this.states.get(workspaceId, () => {
      const aggregator = this.assertGet(workspaceId);

      const hasMessages = aggregator.hasMessages();
      const transient = this.assertChatTransientState(workspaceId);
      const historyPagination =
        this.historyPagination.get(workspaceId) ?? createInitialHistoryPaginationState();
      const activeStreams = aggregator.getActiveStreams();
      const activity = this.workspaceActivity.get(workspaceId);
      const isActiveWorkspace = this.activeOnChatWorkspaceId === workspaceId;
      const messages = aggregator.getAllMessages();
      const metadata = this.workspaceMetadata.get(workspaceId);
      const pendingStreamStartTime = aggregator.getPendingStreamStartTime();
      // Trust the live aggregator only when it is both active AND has finished
      // replaying historical events (caughtUp). During the replay window after a
      // workspace switch, the aggregator is cleared and re-hydrating; fall back to
      // the activity snapshot so the UI continues to reflect the last known state
      // (e.g., canInterrupt stays true for a workspace that is still streaming).
      //
      // For non-active workspaces, the aggregator's activeStreams may be stale since
      // they don't receive stream-end events when unsubscribed from onChat. Prefer the
      // activity snapshot's streaming state, which is updated via the lightweight activity
      // subscription for all workspaces.
      const useAggregatorState = isActiveWorkspace && transient.caughtUp;
      const canInterrupt = useAggregatorState
        ? activeStreams.length > 0
        : (activity?.streaming ?? activeStreams.length > 0);
      const currentModel = useAggregatorState
        ? (aggregator.getCurrentModel() ?? null)
        : (activity?.lastModel ?? aggregator.getCurrentModel() ?? null);
      const currentThinkingLevel = useAggregatorState
        ? (aggregator.getCurrentThinkingLevel() ?? null)
        : (activity?.lastThinkingLevel ?? aggregator.getCurrentThinkingLevel() ?? null);
      const aggregatorRecency = aggregator.getRecencyTimestamp();
      const recencyTimestamp =
        aggregatorRecency === null
          ? (activity?.recency ?? null)
          : Math.max(aggregatorRecency, activity?.recency ?? aggregatorRecency);
      const isStreamStarting = pendingStreamStartTime !== null && !canInterrupt;

      // Live streaming stats
      const activeStreamMessageId = aggregator.getActiveStreamMessageId();
      const streamingTokenCount = activeStreamMessageId
        ? aggregator.getStreamingTokenCount(activeStreamMessageId)
        : undefined;
      const streamingTPS = activeStreamMessageId
        ? aggregator.getStreamingTPS(activeStreamMessageId)
        : undefined;

      return {
        name: metadata?.name ?? workspaceId, // Fall back to ID if metadata missing
        messages: aggregator.getDisplayedMessages(),
        queuedMessage: transient.queuedMessage,
        canInterrupt,
        isCompacting: aggregator.isCompacting(),
        isStreamStarting,
        awaitingUserQuestion: aggregator.hasAwaitingUserQuestion(),
        loading: !hasMessages && !transient.caughtUp,
        hasOlderHistory: historyPagination.hasOlder,
        loadingOlderHistory: historyPagination.loading,
        muxMessages: messages,
        currentModel,
        currentThinkingLevel,
        recencyTimestamp,
        todos: aggregator.getCurrentTodos(),
        loadedSkills: aggregator.getLoadedSkills(),
        skillLoadErrors: aggregator.getSkillLoadErrors(),
        lastAbortReason: aggregator.getLastAbortReason(),
        agentStatus: aggregator.getAgentStatus(),
        pendingStreamStartTime,
        pendingStreamModel: aggregator.getPendingStreamModel(),
        autoRetryStatus: transient.autoRetryStatus,
        runtimeStatus: aggregator.getRuntimeStatus(),
        streamingTokenCount,
        streamingTPS,
      };
    });
  }

  // Cache sidebar state objects to return stable references
  private sidebarStateCache = new Map<string, WorkspaceSidebarState>();
  // Map from workspaceId -> the WorkspaceState reference used to compute sidebarStateCache.
  // React's useSyncExternalStore may call getSnapshot() multiple times per render; this
  // ensures getWorkspaceSidebarState() returns a referentially stable snapshot for a given
  // MapStore version even when timingStats would otherwise change via Date.now().
  private sidebarStateSourceState = new Map<string, WorkspaceState>();

  /**
   * Get sidebar state for a workspace (subset of full state).
   * Returns cached reference if values haven't changed.
   * This is critical for useSyncExternalStore - must return stable references.
   */
  getWorkspaceSidebarState(workspaceId: string): WorkspaceSidebarState {
    const fullState = this.getWorkspaceState(workspaceId);
    const isStarting = fullState.pendingStreamStartTime !== null && !fullState.canInterrupt;

    const cached = this.sidebarStateCache.get(workspaceId);
    if (cached && this.sidebarStateSourceState.get(workspaceId) === fullState) {
      return cached;
    }

    // Return cached if values match.
    // Note: timingStats/sessionStats are intentionally excluded - they change on every
    // streaming token and sidebar items don't use them. Components needing timing should
    // use useWorkspaceStatsSnapshot() which has its own subscription.
    if (
      cached?.canInterrupt === fullState.canInterrupt &&
      cached.isStarting === isStarting &&
      cached.awaitingUserQuestion === fullState.awaitingUserQuestion &&
      cached.currentModel === fullState.currentModel &&
      cached.recencyTimestamp === fullState.recencyTimestamp &&
      cached.loadedSkills === fullState.loadedSkills &&
      cached.skillLoadErrors === fullState.skillLoadErrors &&
      cached.agentStatus === fullState.agentStatus
    ) {
      // Even if we re-use the cached object, mark it as derived from the current
      // WorkspaceState so repeated getSnapshot() reads during this render are stable.
      this.sidebarStateSourceState.set(workspaceId, fullState);
      return cached;
    }

    // Create and cache new state
    const newState: WorkspaceSidebarState = {
      canInterrupt: fullState.canInterrupt,
      isStarting,
      awaitingUserQuestion: fullState.awaitingUserQuestion,
      currentModel: fullState.currentModel,
      recencyTimestamp: fullState.recencyTimestamp,
      loadedSkills: fullState.loadedSkills,
      skillLoadErrors: fullState.skillLoadErrors,
      agentStatus: fullState.agentStatus,
    };
    this.sidebarStateCache.set(workspaceId, newState);
    this.sidebarStateSourceState.set(workspaceId, fullState);
    return newState;
  }

  /**
   * Clear timing stats for a workspace.
   *
   * - Clears backend-persisted timing file (session-timing.json) when available.
   * - Clears in-memory timing derived from StreamingMessageAggregator.
   */
  clearTimingStats(workspaceId: string): void {
    if (this.client && this.statsEnabled) {
      this.client.workspace.stats
        .clear({ workspaceId })
        .then((result) => {
          if (!result.success) {
            console.warn(`Failed to clear timing stats for ${workspaceId}:`, result.error);
            return;
          }

          this.workspaceStats.delete(workspaceId);
          this.statsStore.bump(workspaceId);
        })
        .catch((error) => {
          console.warn(`Failed to clear timing stats for ${workspaceId}:`, error);
        });
    }

    const aggregator = this.aggregators.get(workspaceId);
    if (aggregator) {
      aggregator.clearSessionTimingStats();
      this.states.bump(workspaceId);
    }
  }

  /**
   * Get all workspace states as a Map.
   * Returns a new Map on each call - not cached/reactive.
   * Used by imperative code, not for React subscriptions.
   */
  getAllStates(): Map<string, WorkspaceState> {
    const allStates = new Map<string, WorkspaceState>();
    for (const workspaceId of this.aggregators.keys()) {
      allStates.set(workspaceId, this.getWorkspaceState(workspaceId));
    }
    return allStates;
  }

  /**
   * Get recency timestamps for all workspaces (for sorting in command palette).
   * Derived on-demand from individual workspace states.
   */
  getWorkspaceRecency(): Record<string, number> {
    return this.derived.get("recency", () => {
      const timestamps: Record<string, number> = {};
      for (const workspaceId of this.aggregators.keys()) {
        const state = this.getWorkspaceState(workspaceId);
        if (state.recencyTimestamp !== null) {
          timestamps[workspaceId] = state.recencyTimestamp;
        }
      }
      return timestamps;
    }) as Record<string, number>;
  }

  /**
   * Get aggregator for a workspace (used by components that need direct access).
   * Returns undefined if workspace does not exist.
   */
  getAggregator(workspaceId: string): StreamingMessageAggregator | undefined {
    return this.aggregators.get(workspaceId);
  }

  /**
   * Clear stored abort reason so manual retries can re-enable auto-retry.
   */
  clearLastAbortReason(workspaceId: string): void {
    const aggregator = this.aggregators.get(workspaceId);
    if (!aggregator) {
      return;
    }
    aggregator.clearLastAbortReason();
    this.states.bump(workspaceId);
  }

  async loadOlderHistory(workspaceId: string): Promise<void> {
    assert(
      typeof workspaceId === "string" && workspaceId.length > 0,
      "loadOlderHistory requires a non-empty workspaceId"
    );

    const client = this.client;
    if (!client) {
      console.warn(`[WorkspaceStore] Cannot load older history for ${workspaceId}: no ORPC client`);
      return;
    }

    const paginationState = this.historyPagination.get(workspaceId);
    if (!paginationState) {
      console.warn(
        `[WorkspaceStore] Cannot load older history for ${workspaceId}: pagination state is not initialized`
      );
      return;
    }

    if (!paginationState.hasOlder || paginationState.loading) {
      return;
    }

    if (!this.aggregators.has(workspaceId)) {
      console.warn(
        `[WorkspaceStore] Cannot load older history for ${workspaceId}: workspace is not registered`
      );
      return;
    }

    const requestedCursor = paginationState.nextCursor
      ? {
          beforeHistorySequence: paginationState.nextCursor.beforeHistorySequence,
          beforeMessageId: paginationState.nextCursor.beforeMessageId,
        }
      : null;

    this.historyPagination.set(workspaceId, {
      nextCursor: requestedCursor,
      hasOlder: paginationState.hasOlder,
      loading: true,
    });
    this.states.bump(workspaceId);

    try {
      const result = await client.workspace.history.loadMore({
        workspaceId,
        cursor: requestedCursor,
      });

      const aggregator = this.aggregators.get(workspaceId);
      const latestPagination = this.historyPagination.get(workspaceId);
      if (
        !aggregator ||
        !latestPagination ||
        !latestPagination.loading ||
        !areHistoryPaginationCursorsEqual(latestPagination.nextCursor, requestedCursor)
      ) {
        return;
      }

      if (result.hasOlder) {
        assert(
          result.nextCursor,
          `[WorkspaceStore] loadMore for ${workspaceId} returned hasOlder=true without nextCursor`
        );
      }

      const historicalMessages = result.messages.filter(isMuxMessage);
      const ignoredCount = result.messages.length - historicalMessages.length;
      if (ignoredCount > 0) {
        console.warn(
          `[WorkspaceStore] Ignoring ${ignoredCount} non-message history rows for ${workspaceId}`
        );
      }

      if (historicalMessages.length > 0) {
        aggregator.loadHistoricalMessages(historicalMessages, false, {
          mode: "append",
          skipDerivedState: true,
        });
        this.consumerManager.scheduleCalculation(workspaceId, aggregator);
      }

      this.historyPagination.set(workspaceId, {
        nextCursor: result.nextCursor,
        hasOlder: result.hasOlder,
        loading: false,
      });
    } catch (error) {
      console.error(`[WorkspaceStore] Failed to load older history for ${workspaceId}:`, error);

      const latestPagination = this.historyPagination.get(workspaceId);
      if (latestPagination) {
        this.historyPagination.set(workspaceId, {
          ...latestPagination,
          loading: false,
        });
      }
    } finally {
      if (this.isWorkspaceRegistered(workspaceId)) {
        this.states.bump(workspaceId);
      }
    }
  }

  /**
   * Mark the current active stream as "interrupting" (transient state).
   * Call this before invoking interruptStream so the UI shows "interrupting..."
   * immediately, avoiding a visual flash when the backend confirmation arrives.
   */
  setInterrupting(workspaceId: string): void {
    const aggregator = this.aggregators.get(workspaceId);
    if (aggregator) {
      aggregator.setInterrupting();
      this.states.bump(workspaceId);
    }
  }

  getWorkspaceStatsSnapshot(workspaceId: string): WorkspaceStatsSnapshot | null {
    return this.statsStore.get(workspaceId, () => {
      return this.workspaceStats.get(workspaceId) ?? null;
    });
  }

  /**
   * Bump state for a workspace to trigger React re-renders.
   * Used by addEphemeralMessage for frontend-only messages.
   */
  bumpState(workspaceId: string): void {
    this.states.bump(workspaceId);
  }

  /**
   * Get current TODO list for a workspace.
   * Returns empty array if workspace doesn't exist or has no TODOs.
   */
  getTodos(workspaceId: string): TodoItem[] {
    const aggregator = this.aggregators.get(workspaceId);
    return aggregator ? aggregator.getCurrentTodos() : [];
  }

  /**
   * Extract usage from session-usage.json (no tokenization or message iteration).
   *
   * Returns empty state if workspace doesn't exist (e.g., creation mode).
   */
  getWorkspaceUsage(workspaceId: string): WorkspaceUsageState {
    return this.usageStore.get(workspaceId, () => {
      const aggregator = this.aggregators.get(workspaceId);
      if (!aggregator) {
        return { totalTokens: 0 };
      }

      const model = aggregator.getCurrentModel();
      const sessionData = this.sessionUsage.get(workspaceId);

      // Session total: sum all models from persisted data
      const sessionTotal =
        sessionData && Object.keys(sessionData.byModel).length > 0
          ? sumUsageHistory(Object.values(sessionData.byModel))
          : undefined;

      // Last request from persisted data
      const lastRequest = sessionData?.lastRequest;

      // Calculate total tokens from session total
      const totalTokens = sessionTotal
        ? sessionTotal.input.tokens +
          sessionTotal.cached.tokens +
          sessionTotal.cacheCreate.tokens +
          sessionTotal.output.tokens +
          sessionTotal.reasoning.tokens
        : 0;

      // Get last message's context usage — only search within the current
      // compaction epoch. Pre-boundary messages carry stale contextUsage from
      // before compaction; including them inflates the usage indicator and
      // triggers premature auto-compaction.
      const messages = aggregator.getAllMessages();
      const lastContextUsage = (() => {
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (isDurableCompactionBoundaryMarker(msg)) break;
          if (msg.role === "assistant") {
            if (msg.metadata?.compacted) continue;
            const rawUsage = msg.metadata?.contextUsage;
            const providerMeta =
              msg.metadata?.contextProviderMetadata ?? msg.metadata?.providerMetadata;
            if (rawUsage) {
              const msgModel = msg.metadata?.model ?? model ?? "unknown";
              return createDisplayUsage(rawUsage, msgModel, providerMeta);
            }
          }
        }
        return undefined;
      })();

      // Live streaming data (unchanged)
      const activeStreamId = aggregator.getActiveStreamMessageId();
      const rawContextUsage = activeStreamId
        ? aggregator.getActiveStreamUsage(activeStreamId)
        : undefined;
      const rawStepProviderMetadata = activeStreamId
        ? aggregator.getActiveStreamStepProviderMetadata(activeStreamId)
        : undefined;
      const liveUsage =
        rawContextUsage && model
          ? createDisplayUsage(rawContextUsage, model, rawStepProviderMetadata)
          : undefined;

      const rawCumulativeUsage = activeStreamId
        ? aggregator.getActiveStreamCumulativeUsage(activeStreamId)
        : undefined;
      const rawCumulativeProviderMetadata = activeStreamId
        ? aggregator.getActiveStreamCumulativeProviderMetadata(activeStreamId)
        : undefined;
      const liveCostUsage =
        rawCumulativeUsage && model
          ? createDisplayUsage(rawCumulativeUsage, model, rawCumulativeProviderMetadata)
          : undefined;

      return { sessionTotal, lastRequest, lastContextUsage, totalTokens, liveUsage, liveCostUsage };
    });
  }

  private tryHydrateConsumersFromSessionUsageCache(
    workspaceId: string,
    aggregator: StreamingMessageAggregator
  ): boolean {
    const usage = this.sessionUsage.get(workspaceId);
    const tokenStatsCache = usage?.tokenStatsCache;
    if (!tokenStatsCache) {
      return false;
    }

    const messages = aggregator.getAllMessages();
    if (messages.length === 0) {
      return false;
    }

    const model = aggregator.getCurrentModel() ?? "unknown";
    if (tokenStatsCache.model !== model) {
      return false;
    }

    if (tokenStatsCache.history.messageCount !== messages.length) {
      return false;
    }

    const cachedMaxSeq = tokenStatsCache.history.maxHistorySequence;
    const currentMaxSeq = getMaxHistorySequence(messages);

    // Fall back to messageCount matching if either side lacks historySequence metadata.
    if (
      cachedMaxSeq !== undefined &&
      currentMaxSeq !== undefined &&
      cachedMaxSeq !== currentMaxSeq
    ) {
      return false;
    }

    this.consumerManager.hydrateFromCache(workspaceId, {
      consumers: tokenStatsCache.consumers,
      tokenizerName: tokenStatsCache.tokenizerName,
      totalTokens: tokenStatsCache.totalTokens,
      topFilePaths: tokenStatsCache.topFilePaths,
    });

    return true;
  }

  private ensureConsumersCached(workspaceId: string, aggregator: StreamingMessageAggregator): void {
    if (aggregator.getAllMessages().length === 0) {
      return;
    }

    const cached = this.consumerManager.getCachedState(workspaceId);
    const isPending = this.consumerManager.isPending(workspaceId);
    if (cached || isPending) {
      return;
    }

    if (this.tryHydrateConsumersFromSessionUsageCache(workspaceId, aggregator)) {
      return;
    }

    this.consumerManager.scheduleCalculation(workspaceId, aggregator);
  }

  /**
   * Get consumer breakdown (may be calculating).
   * Triggers lazy calculation if workspace is caught-up but no data exists.
   *
   * Architecture: Lazy trigger runs on EVERY access (outside MapStore.get())
   * so workspace switches trigger calculation even if MapStore has cached result.
   */
  getWorkspaceConsumers(workspaceId: string): WorkspaceConsumersState {
    const aggregator = this.aggregators.get(workspaceId);
    const isCaughtUp = this.chatTransientState.get(workspaceId)?.caughtUp ?? false;

    // Lazy trigger check (runs on EVERY access, not just when MapStore recomputes)
    const cached = this.consumerManager.getCachedState(workspaceId);
    const isPending = this.consumerManager.isPending(workspaceId);

    if (!cached && !isPending && isCaughtUp) {
      if (aggregator && aggregator.getAllMessages().length > 0) {
        // Defer scheduling/hydration to avoid setState-during-render warning
        // queueMicrotask ensures this runs after current render completes
        queueMicrotask(() => {
          this.ensureConsumersCached(workspaceId, aggregator);
        });
      }
    }

    // Return state (MapStore handles subscriptions, delegates to manager for actual state)
    return this.consumersStore.get(workspaceId, () => {
      return this.consumerManager.getStateSync(workspaceId);
    });
  }

  /**
   * Subscribe to usage store changes for a specific workspace.
   */
  subscribeUsage(workspaceId: string, listener: () => void): () => void {
    return this.usageStore.subscribeKey(workspaceId, listener);
  }

  /**
   * Subscribe to backend timing stats snapshots for a specific workspace.
   */
  subscribeStats(workspaceId: string, listener: () => void): () => void {
    const unsubscribeFromStore = this.statsStore.subscribeKey(workspaceId, listener);

    const previousCount = this.statsListenerCounts.get(workspaceId) ?? 0;
    const nextCount = previousCount + 1;
    this.statsListenerCounts.set(workspaceId, nextCount);

    if (previousCount === 0) {
      // Start the backend subscription only once we have an actual UI consumer.
      this.subscribeToStats(workspaceId);
    }

    return () => {
      unsubscribeFromStore();

      const currentCount = this.statsListenerCounts.get(workspaceId);
      if (!currentCount) {
        console.warn(
          `[WorkspaceStore] stats listener count underflow for ${workspaceId} (already 0)`
        );
        return;
      }

      if (currentCount === 1) {
        this.statsListenerCounts.delete(workspaceId);

        // No remaining listeners: stop the backend subscription and drop cached snapshot.
        const statsUnsubscribe = this.statsUnsubscribers.get(workspaceId);
        if (statsUnsubscribe) {
          statsUnsubscribe();
          this.statsUnsubscribers.delete(workspaceId);
        }
        this.workspaceStats.delete(workspaceId);

        // Clear MapStore caches for this workspace.
        // MapStore.delete() is version-gated, so bump first to ensure we clear even
        // if the key was only ever read (get()) and never bumped.
        this.statsStore.bump(workspaceId);
        this.statsStore.delete(workspaceId);
        return;
      }

      this.statsListenerCounts.set(workspaceId, currentCount - 1);
    };
  }

  /**
   * Subscribe to consumer store changes for a specific workspace.
   */
  subscribeConsumers(workspaceId: string, listener: () => void): () => void {
    return this.consumersStore.subscribeKey(workspaceId, listener);
  }

  /**
   * Update usage and schedule consumer calculation after stream completion.
   *
   * CRITICAL ORDERING: This must be called AFTER the aggregator updates its messages.
   * If called before, the UI will re-render and read stale data from the aggregator,
   * causing a race condition where usage appears empty until refresh.
   *
   * Handles both:
   * - Instant usage display (from API metadata) - only if usage present
   * - Async consumer breakdown (tokenization via Web Worker) - normally scheduled,
   *   but skipped during history replay to avoid O(N) scheduling overhead
   */
  private finalizeUsageStats(
    workspaceId: string,
    metadata?: { usage?: LanguageModelV2Usage }
  ): void {
    // During history replay: only bump usage, skip scheduling (caught-up schedules once at end)
    if (this.chatTransientState.get(workspaceId)?.replayingHistory) {
      if (metadata?.usage) {
        this.usageStore.bump(workspaceId);
      }
      return;
    }

    // Normal real-time path: always bump usage.
    //
    // Even if total usage is missing (e.g. provider doesn't return it or it timed out),
    // we still need to recompute usage snapshots to:
    // - Clear liveUsage once the active stream ends
    // - Pick up lastContextUsage changes from merged message metadata
    this.usageStore.bump(workspaceId);

    // Always schedule consumer calculation (tool calls, text, etc. need tokenization)
    // Even streams without usage metadata need token counts recalculated
    const aggregator = this.aggregators.get(workspaceId);
    if (aggregator) {
      this.consumerManager.scheduleCalculation(workspaceId, aggregator);
    }
  }

  private sleepWithAbort(timeoutMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }

      const onAbort = () => {
        cleanup();
        resolve();
      };

      const timeout = setTimeout(() => {
        cleanup();
        resolve();
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
      };

      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private isWorkspaceRegistered(workspaceId: string): boolean {
    return this.workspaceMetadata.has(workspaceId);
  }

  private getBackgroundCompletionCompaction(
    workspaceId: string
  ): { hasContinueMessage: boolean } | undefined {
    const aggregator = this.aggregators.get(workspaceId);
    if (!aggregator) {
      return undefined;
    }

    const compactingStreams = aggregator
      .getActiveStreams()
      .filter((stream) => stream.isCompacting === true);

    if (compactingStreams.length === 0) {
      return undefined;
    }

    return {
      hasContinueMessage: compactingStreams.some((stream) => stream.hasCompactionContinue === true),
    };
  }

  private applyWorkspaceActivitySnapshot(
    workspaceId: string,
    snapshot: WorkspaceActivitySnapshot | null
  ): void {
    const previous = this.workspaceActivity.get(workspaceId) ?? null;

    if (snapshot) {
      this.workspaceActivity.set(workspaceId, snapshot);
    } else {
      this.workspaceActivity.delete(workspaceId);
    }

    const changed =
      previous?.streaming !== snapshot?.streaming ||
      previous?.lastModel !== snapshot?.lastModel ||
      previous?.lastThinkingLevel !== snapshot?.lastThinkingLevel ||
      previous?.recency !== snapshot?.recency;

    if (!changed) {
      return;
    }

    if (this.aggregators.has(workspaceId)) {
      this.states.bump(workspaceId);
    }

    const startedStreamingSnapshot =
      previous?.streaming !== true && snapshot?.streaming === true ? snapshot : null;
    if (startedStreamingSnapshot) {
      this.activityStreamingStartRecency.set(workspaceId, startedStreamingSnapshot.recency);
    }

    const stoppedStreamingSnapshot =
      previous?.streaming === true && snapshot?.streaming === false ? snapshot : null;
    const isBackgroundStreamingStop =
      stoppedStreamingSnapshot !== null && workspaceId !== this.activeWorkspaceId;
    const streamStartRecency = this.activityStreamingStartRecency.get(workspaceId);
    const recencyAdvancedSinceStreamStart =
      stoppedStreamingSnapshot !== null &&
      streamStartRecency !== undefined &&
      stoppedStreamingSnapshot.recency > streamStartRecency;
    const backgroundCompaction = isBackgroundStreamingStop
      ? this.getBackgroundCompletionCompaction(workspaceId)
      : undefined;

    // Trigger response completion notifications for background workspaces only when
    // activity indicates a true completion (streaming true -> false WITH recency advance).
    // stream-abort/error transitions also flip streaming to false, but recency stays
    // unchanged there, so suppress completion notifications in those cases.
    if (stoppedStreamingSnapshot && recencyAdvancedSinceStreamStart && isBackgroundStreamingStop) {
      if (this.responseCompleteCallback) {
        // Activity snapshots don't include message/content metadata. Reuse any
        // still-active stream context captured before this workspace was backgrounded
        // so compaction continue turns remain suppressible in App notifications.
        this.responseCompleteCallback(
          workspaceId,
          "",
          true,
          "",
          backgroundCompaction,
          stoppedStreamingSnapshot.recency
        );
      }
    }

    if (isBackgroundStreamingStop) {
      // Inactive workspaces do not receive stream-end events via onChat. Once
      // activity confirms streaming stopped, clear stale stream contexts so they
      // cannot leak compaction metadata into future completion callbacks.
      this.aggregators.get(workspaceId)?.clearActiveStreams();
    }

    if (snapshot?.streaming !== true) {
      this.activityStreamingStartRecency.delete(workspaceId);
    }

    if (previous?.recency !== snapshot?.recency && this.aggregators.has(workspaceId)) {
      this.derived.bump("recency");
    }
  }

  private applyWorkspaceActivityList(snapshots: Record<string, WorkspaceActivitySnapshot>): void {
    const snapshotEntries = Object.entries(snapshots);

    // Defensive fallback: workspace.activity.list returns {} on backend read failures.
    // Preserve last-known snapshots instead of wiping sidebar activity state for all
    // workspaces during a transient metadata read error.
    if (snapshotEntries.length === 0) {
      return;
    }

    const seenWorkspaceIds = new Set<string>();

    for (const [workspaceId, snapshot] of snapshotEntries) {
      seenWorkspaceIds.add(workspaceId);
      this.applyWorkspaceActivitySnapshot(workspaceId, snapshot);
    }

    for (const workspaceId of Array.from(this.workspaceActivity.keys())) {
      if (seenWorkspaceIds.has(workspaceId)) {
        continue;
      }
      this.applyWorkspaceActivitySnapshot(workspaceId, null);
    }
  }

  private async runActivitySubscription(signal: AbortSignal): Promise<void> {
    let attempt = 0;

    while (!signal.aborted) {
      const client = this.client ?? (await this.waitForClient(signal));
      if (!client || signal.aborted) {
        return;
      }

      const attemptController = new AbortController();
      const onAbort = () => attemptController.abort();
      signal.addEventListener("abort", onAbort);

      const clientChangeSignal = this.clientChangeController.signal;
      const onClientChange = () => attemptController.abort();
      clientChangeSignal.addEventListener("abort", onClientChange, { once: true });

      try {
        // Open the live delta stream first so no state transition can be lost
        // between the list snapshot fetch and subscribe registration.
        const iterator = await client.workspace.activity.subscribe(undefined, {
          signal: attemptController.signal,
        });

        const snapshots = await client.workspace.activity.list();
        if (signal.aborted) {
          return;
        }
        // Client changed while list() was in flight — retry with the new client
        // instead of exiting permanently. The outer while loop will pick up the
        // replacement client on the next iteration.
        if (attemptController.signal.aborted) {
          continue;
        }

        queueMicrotask(() => {
          if (signal.aborted || attemptController.signal.aborted) {
            return;
          }
          this.applyWorkspaceActivityList(snapshots);
        });

        for await (const event of iterator) {
          if (signal.aborted) {
            return;
          }

          // Connection is alive again - don't carry old backoff into the next failure.
          attempt = 0;

          queueMicrotask(() => {
            if (signal.aborted || attemptController.signal.aborted) {
              return;
            }
            this.applyWorkspaceActivitySnapshot(event.workspaceId, event.activity);
          });
        }

        if (signal.aborted) {
          return;
        }

        if (!attemptController.signal.aborted) {
          console.warn("[WorkspaceStore] activity subscription ended unexpectedly; retrying...");
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }

        const abortError = isAbortError(error);
        if (attemptController.signal.aborted) {
          if (!abortError) {
            console.warn("[WorkspaceStore] activity subscription aborted; retrying...");
          }
        } else if (!abortError) {
          console.warn("[WorkspaceStore] Error in activity subscription:", error);
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        clientChangeSignal.removeEventListener("abort", onClientChange);
      }

      const delayMs = calculateOnChatBackoffMs(attempt);
      attempt++;

      await this.sleepWithAbort(delayMs, signal);
      if (signal.aborted) {
        return;
      }
    }
  }

  private async waitForClient(signal: AbortSignal): Promise<RouterClient<AppRouter> | null> {
    while (!signal.aborted) {
      if (this.client) {
        return this.client;
      }

      // Wait for a client to be attached (e.g., initial connect or reconnect).
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }

        const clientChangeSignal = this.clientChangeController.signal;
        const onAbort = () => {
          cleanup();
          resolve();
        };

        const timeout = setTimeout(() => {
          cleanup();
          resolve();
        }, ON_CHAT_RETRY_BASE_MS);

        const cleanup = () => {
          clearTimeout(timeout);
          signal.removeEventListener("abort", onAbort);
          clientChangeSignal.removeEventListener("abort", onAbort);
        };

        signal.addEventListener("abort", onAbort, { once: true });
        clientChangeSignal.addEventListener("abort", onAbort, { once: true });
      });
    }

    return null;
  }

  /**
   * Reset derived UI state for a workspace so a fresh onChat replay can rebuild it.
   *
   * This is used when an onChat subscription ends unexpectedly (MessagePort/WebSocket hiccup).
   * Without clearing, replayed history would be merged into stale state (loadHistoricalMessages
   * only adds/overwrites, it doesn't delete messages that disappeared due to compaction/truncation).
   */
  private resetChatStateForReplay(workspaceId: string): void {
    const aggregator = this.aggregators.get(workspaceId);
    if (!aggregator) {
      return;
    }

    // Clear any pending UI bumps from deltas - we're about to rebuild the message list.
    this.cancelPendingIdleBump(workspaceId);

    aggregator.clear();

    // Reset per-workspace transient state so the next replay rebuilds from the backend source of truth.
    this.chatTransientState.set(workspaceId, createInitialChatTransientState());

    this.historyPagination.set(workspaceId, createInitialHistoryPaginationState());

    this.states.bump(workspaceId);
    this.checkAndBumpRecencyIfChanged();
  }

  private getStartupAutoCompactionThreshold(
    workspaceId: string,
    retryModelHint?: string | null
  ): number {
    const metadata = this.workspaceMetadata.get(workspaceId);
    const modelFromActiveAgent = metadata?.agentId
      ? metadata.aiSettingsByAgent?.[metadata.agentId]?.model
      : undefined;
    const pendingModel =
      retryModelHint ??
      modelFromActiveAgent ??
      metadata?.aiSettingsByAgent?.exec?.model ??
      metadata?.aiSettings?.model;
    const thresholdKey = getAutoCompactionThresholdKey(pendingModel ?? "default");
    const persistedThreshold = readPersistedState<unknown>(
      thresholdKey,
      DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT
    );
    const thresholdPercent =
      typeof persistedThreshold === "number" && Number.isFinite(persistedThreshold)
        ? persistedThreshold
        : DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT;

    if (thresholdPercent !== persistedThreshold) {
      // Self-heal malformed localStorage so future startup syncs remain valid.
      updatePersistedState<number>(thresholdKey, DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT);
    }

    return Math.max(0.1, Math.min(1, thresholdPercent / 100));
  }

  /**
   * Best-effort startup threshold sync so backend recovery uses the user's persisted
   * per-model threshold before AgentSession startup recovery kicks in.
   */
  private async syncAutoCompactionThresholdAtStartup(
    client: RouterClient<AppRouter>,
    workspaceId: string
  ): Promise<void> {
    try {
      // Startup auto-retry can resume a turn with a model different from the current
      // workspace selector. Ask backend for that retry-turn model first so threshold
      // sync uses the matching per-model localStorage key.
      const startupRetryModelResult = await client.workspace.getStartupAutoRetryModel?.({
        workspaceId,
      });
      const startupRetryModel = startupRetryModelResult?.success
        ? startupRetryModelResult.data
        : null;

      await client.workspace.setAutoCompactionThreshold({
        workspaceId,
        threshold: this.getStartupAutoCompactionThreshold(workspaceId, startupRetryModel),
      });
    } catch (error) {
      console.warn(
        `[WorkspaceStore] Failed to sync startup auto-compaction threshold for ${workspaceId}:`,
        error
      );
    }
  }

  /**
   * Subscribe to workspace chat events (history replay + live streaming).
   * Retries on unexpected iterator termination to avoid requiring a full app restart.
   */
  private async runOnChatSubscription(workspaceId: string, signal: AbortSignal): Promise<void> {
    let attempt = 0;

    while (!signal.aborted) {
      const client = this.client ?? (await this.waitForClient(signal));
      if (!client || signal.aborted) {
        return;
      }

      // Allow us to abort only this subscription attempt (without unsubscribing the workspace).
      const attemptController = new AbortController();
      const onAbort = () => attemptController.abort();
      signal.addEventListener("abort", onAbort);

      const clientChangeSignal = this.clientChangeController.signal;
      const onClientChange = () => attemptController.abort();
      clientChangeSignal.addEventListener("abort", onClientChange, { once: true });

      let stallInterval: ReturnType<typeof setInterval> | null = null;
      let lastChatEventAt = Date.now();

      try {
        // Always reset caughtUp at subscription start so historical events are
        // buffered until the caught-up marker arrives, regardless of replay mode.
        const transient = this.chatTransientState.get(workspaceId);
        if (transient) {
          transient.caughtUp = false;
        }

        // Reconnect incrementally whenever we can build a valid cursor.
        // Do not gate on transient.caughtUp here: retry paths may optimistically
        // set caughtUp=false to re-enable buffering, but the cursor can still
        // represent the latest rendered state for an incremental reconnect.
        const aggregator = this.aggregators.get(workspaceId);
        let mode: OnChatMode | undefined;

        if (aggregator) {
          const cursor = aggregator.getOnChatCursor();
          if (cursor?.history) {
            mode = {
              type: "since",
              cursor: {
                history: cursor.history,
                stream: cursor.stream,
              },
            };
          }
        }

        await this.syncAutoCompactionThresholdAtStartup(client, workspaceId);

        const autoRetryKey = getAutoRetryKey(workspaceId);
        const legacyAutoRetryEnabledRaw = readPersistedState<unknown>(autoRetryKey, undefined);
        const legacyAutoRetryEnabled =
          typeof legacyAutoRetryEnabledRaw === "boolean" ? legacyAutoRetryEnabledRaw : undefined;

        if (legacyAutoRetryEnabledRaw !== undefined && legacyAutoRetryEnabled === undefined) {
          // Self-heal malformed legacy values so onChat subscription retries do not
          // keep failing schema validation on every reconnect attempt.
          updatePersistedState<boolean | undefined>(autoRetryKey, undefined);
        }

        const onChatInput =
          legacyAutoRetryEnabled === undefined
            ? { workspaceId, mode }
            : { workspaceId, mode, legacyAutoRetryEnabled };

        const iterator = await client.workspace.onChat(onChatInput, {
          signal: attemptController.signal,
        });

        if (legacyAutoRetryEnabled !== undefined) {
          // One-way migration: once we have successfully forwarded the legacy value
          // to the backend, clear the renderer key so future sessions rely solely
          // on backend persistence.
          updatePersistedState<boolean | undefined>(autoRetryKey, undefined);
        }

        // Full replay: clear stale derived/transient state now that the subscription
        // is active. Deferred to after the iterator is established so the UI continues
        // displaying previous state until replay data actually starts arriving.
        if (!mode || mode.type === "full") {
          this.resetChatStateForReplay(workspaceId);
        }

        // Stall watchdog: server sends heartbeats every 5s, so if we don't receive ANY events
        // (including heartbeats) for 10s, the connection is likely dead.
        stallInterval = setInterval(() => {
          if (attemptController.signal.aborted) return;

          const elapsedMs = Date.now() - lastChatEventAt;
          if (elapsedMs < ON_CHAT_STALL_TIMEOUT_MS) return;

          console.warn(
            `[WorkspaceStore] onChat appears stalled for ${workspaceId} (no events for ${elapsedMs}ms); retrying...`
          );
          attemptController.abort();
        }, ON_CHAT_STALL_CHECK_INTERVAL_MS);

        for await (const data of iterator) {
          if (signal.aborted) {
            return;
          }

          lastChatEventAt = Date.now();

          // Connection is alive again - don't carry old backoff into the next failure.
          attempt = 0;

          const attemptSignal = attemptController.signal;
          queueMicrotask(() => {
            // Workspace switches abort the previous attempt before starting a new one.
            // Drop any already-queued chat events from that aborted attempt so stale
            // replay buffers cannot be repopulated after we synchronously cleared them.
            if (signal.aborted || attemptSignal.aborted) {
              return;
            }
            this.handleChatMessage(workspaceId, data);
          });
        }

        // Iterator ended without an abort - treat as unexpected and retry.
        if (signal.aborted) {
          return;
        }

        if (attemptController.signal.aborted) {
          // e.g., stall watchdog fired
          console.warn(
            `[WorkspaceStore] onChat subscription aborted for ${workspaceId}; retrying...`
          );
        } else {
          console.warn(
            `[WorkspaceStore] onChat subscription ended unexpectedly for ${workspaceId}; retrying...`
          );
        }
      } catch (error) {
        // Suppress errors when subscription was intentionally cleaned up
        if (signal.aborted) {
          return;
        }

        const abortError = isAbortError(error);

        if (attemptController.signal.aborted) {
          if (!abortError) {
            console.warn(
              `[WorkspaceStore] onChat subscription aborted for ${workspaceId}; retrying...`
            );
          }
        } else if (isIteratorValidationFailed(error)) {
          // EVENT_ITERATOR_VALIDATION_FAILED can happen when:
          // 1. Schema validation fails (event doesn't match WorkspaceChatMessageSchema)
          // 2. Workspace was removed on server side (iterator ends with error)
          // 3. Connection dropped (WebSocket/MessagePort error)

          // Only suppress if workspace no longer exists (was removed during the race)
          if (!this.isWorkspaceRegistered(workspaceId)) {
            return;
          }
          // Log with detailed validation info for debugging schema mismatches
          console.error(
            `[WorkspaceStore] Event validation failed for ${workspaceId}: ${formatValidationError(error)}`
          );
        } else if (!abortError) {
          console.error(`[WorkspaceStore] Error in onChat subscription for ${workspaceId}:`, error);
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        clientChangeSignal.removeEventListener("abort", onClientChange);
        if (stallInterval) {
          clearInterval(stallInterval);
        }
      }

      if (this.isWorkspaceRegistered(workspaceId)) {
        // Failed reconnect attempts may have buffered partial replay data.
        // Clear replay buffers before the next attempt so we don't append a
        // second replay copy and duplicate deltas/tool events on caught-up.
        this.clearReplayBuffers(workspaceId);

        // Preserve pagination across transient reconnect retries. Incremental
        // caught-up payloads intentionally omit hasOlderHistory, so resetting
        // here would permanently hide "Load older messages" until a full replay.
        const existingPagination =
          this.historyPagination.get(workspaceId) ?? createInitialHistoryPaginationState();
        this.historyPagination.set(workspaceId, {
          ...existingPagination,
          loading: false,
        });
      }

      const delayMs = calculateOnChatBackoffMs(attempt);
      attempt++;

      await this.sleepWithAbort(delayMs, signal);
      if (signal.aborted) {
        return;
      }
    }
  }

  /**
   * Register a workspace and initialize local state.
   */

  /**
   * Imperative metadata lookup — no React subscription. Safe to call from
   * event handlers / callbacks without causing re-renders.
   */
  getWorkspaceMetadata(workspaceId: string): FrontendWorkspaceMetadata | undefined {
    return this.workspaceMetadata.get(workspaceId);
  }

  addWorkspace(metadata: FrontendWorkspaceMetadata): void {
    const workspaceId = metadata.id;

    // Skip if already registered
    if (this.workspaceMetadata.has(workspaceId)) {
      return;
    }

    // Store metadata for name lookup
    this.workspaceMetadata.set(workspaceId, metadata);

    // Backend guarantees createdAt via config.ts - this should never be undefined
    assert(
      metadata.createdAt,
      `Workspace ${workspaceId} missing createdAt - backend contract violated`
    );

    const aggregator = this.getOrCreateAggregator(
      workspaceId,
      metadata.createdAt,
      metadata.unarchivedAt
    );

    // Initialize recency cache and bump derived store immediately
    // This ensures UI sees correct workspace order before messages load
    const initialRecency = aggregator.getRecencyTimestamp();
    if (initialRecency !== null) {
      this.recencyCache.set(workspaceId, initialRecency);
      this.derived.bump("recency");
    }

    // Initialize transient chat state
    if (!this.chatTransientState.has(workspaceId)) {
      this.chatTransientState.set(workspaceId, createInitialChatTransientState());
    }

    if (!this.historyPagination.has(workspaceId)) {
      this.historyPagination.set(workspaceId, createInitialHistoryPaginationState());
    }

    // Clear stale streaming state
    aggregator.clearActiveStreams();

    // Fetch persisted session usage (fire-and-forget)
    this.client?.workspace
      .getSessionUsage({ workspaceId })
      .then((data) => {
        if (data) {
          this.sessionUsage.set(workspaceId, data);
          this.usageStore.bump(workspaceId);
        }
      })
      .catch((error) => {
        console.warn(`Failed to fetch session usage for ${workspaceId}:`, error);
      });

    // Stats snapshots are subscribed lazily via subscribeStats().
    if (this.statsEnabled) {
      this.subscribeToStats(workspaceId);
    }

    this.ensureActiveOnChatSubscription();

    if (!this.client) {
      console.warn(`[WorkspaceStore] No ORPC client available for workspace ${workspaceId}`);
    }
  }

  /**
   * Remove a workspace and clean up subscriptions.
   */
  removeWorkspace(workspaceId: string): void {
    // Clean up consumer manager state
    this.consumerManager.removeWorkspace(workspaceId);

    // Clean up idle callback to prevent stale callbacks
    this.cancelPendingIdleBump(workspaceId);

    if (this.activeWorkspaceId === workspaceId) {
      this.activeWorkspaceId = null;
    }

    const statsUnsubscribe = this.statsUnsubscribers.get(workspaceId);
    if (statsUnsubscribe) {
      statsUnsubscribe();
      this.statsUnsubscribers.delete(workspaceId);
    }

    const unsubscribe = this.ipcUnsubscribers.get(workspaceId);
    if (unsubscribe) {
      unsubscribe();
      this.ipcUnsubscribers.delete(workspaceId);
    }
    if (this.activeOnChatWorkspaceId === workspaceId) {
      this.activeOnChatWorkspaceId = null;
    }

    this.pendingReplayReset.delete(workspaceId);

    // Clean up state
    this.states.delete(workspaceId);
    this.usageStore.delete(workspaceId);
    this.consumersStore.delete(workspaceId);
    this.aggregators.delete(workspaceId);
    this.chatTransientState.delete(workspaceId);
    this.workspaceMetadata.delete(workspaceId);
    this.workspaceActivity.delete(workspaceId);
    this.activityStreamingStartRecency.delete(workspaceId);
    this.recencyCache.delete(workspaceId);
    this.previousSidebarValues.delete(workspaceId);
    this.sidebarStateCache.delete(workspaceId);
    this.sidebarStateSourceState.delete(workspaceId);
    this.workspaceCreatedAt.delete(workspaceId);
    this.workspaceStats.delete(workspaceId);
    this.statsStore.delete(workspaceId);
    this.statsListenerCounts.delete(workspaceId);
    this.historyPagination.delete(workspaceId);
    this.sessionUsage.delete(workspaceId);

    this.ensureActiveOnChatSubscription();
    this.derived.bump("recency");
  }

  /**
   * Sync workspaces with metadata - add new, remove deleted.
   */
  syncWorkspaces(workspaceMetadata: Map<string, FrontendWorkspaceMetadata>): void {
    const metadataIds = new Set(Array.from(workspaceMetadata.values()).map((m) => m.id));
    const currentIds = new Set(this.workspaceMetadata.keys());

    // Add new workspaces
    for (const metadata of workspaceMetadata.values()) {
      if (!currentIds.has(metadata.id)) {
        this.addWorkspace(metadata);
      }
    }

    // Remove deleted workspaces
    for (const workspaceId of currentIds) {
      if (!metadataIds.has(workspaceId)) {
        this.removeWorkspace(workspaceId);
      }
    }

    // Re-evaluate the active subscription after additions/removals.
    // removeWorkspace can null activeWorkspaceId when the removed workspace
    // was active (e.g., stale singleton state between integration tests),
    // leaving addWorkspace's ensureActiveOnChatSubscription targeting the
    // old workspace. This final call reconciles the subscription with the
    // current activeWorkspaceId + registration state.
    this.ensureActiveOnChatSubscription();
  }

  /**
   * Cleanup all subscriptions (call on unmount).
   */
  dispose(): void {
    // Clean up consumer manager
    this.consumerManager.dispose();

    for (const unsubscribe of this.statsUnsubscribers.values()) {
      unsubscribe();
    }
    this.statsUnsubscribers.clear();

    for (const unsubscribe of this.ipcUnsubscribers.values()) {
      unsubscribe();
    }
    this.ipcUnsubscribers.clear();

    if (this.activityAbortController) {
      this.activityAbortController.abort();
      this.activityAbortController = null;
    }

    this.activeWorkspaceId = null;
    this.activeOnChatWorkspaceId = null;
    this.pendingReplayReset.clear();
    this.states.clear();
    this.derived.clear();
    this.usageStore.clear();
    this.consumersStore.clear();
    this.aggregators.clear();
    this.chatTransientState.clear();
    this.workspaceMetadata.clear();
    this.workspaceActivity.clear();
    this.activityStreamingStartRecency.clear();
    this.workspaceStats.clear();
    this.statsStore.clear();
    this.statsListenerCounts.clear();
    this.historyPagination.clear();
    this.sessionUsage.clear();
    this.recencyCache.clear();
    this.previousSidebarValues.clear();
    this.sidebarStateCache.clear();
    this.workspaceCreatedAt.clear();
  }

  /**
   * Subscribe to idle compaction events.
   * Callback is called when backend signals a workspace started idle compaction.
   * Returns unsubscribe function.
   */
  onIdleCompactionStarted(callback: (workspaceId: string) => void): () => void {
    this.idleCompactionCallbacks.add(callback);
    return () => this.idleCompactionCallbacks.delete(callback);
  }

  /**
   * Notify all listeners that a workspace started idle compaction.
   */
  private notifyIdleCompactionStarted(workspaceId: string): void {
    for (const callback of this.idleCompactionCallbacks) {
      try {
        callback(workspaceId);
      } catch (error) {
        console.error("Error in idle compaction callback:", error);
      }
    }
  }

  /**
   * Subscribe to file-modifying tool completions.
   * @param listener Called with workspaceId when a file-modifying tool completes
   * @param workspaceId If provided, only notify for this workspace
   */
  subscribeFileModifyingTool(
    listener: (workspaceId: string) => void,
    workspaceId?: string
  ): () => void {
    if (workspaceId) {
      // Per-workspace: wrap listener to match subscribeKey signature
      return this.fileModifyingToolSubs.subscribeKey(workspaceId, () => listener(workspaceId));
    }
    // All workspaces: subscribe to global notifications
    return this.fileModifyingToolSubs.subscribeAny(() => {
      // Notify for all workspaces that have pending changes
      for (const wsId of this.fileModifyingToolMs.keys()) {
        listener(wsId);
      }
    });
  }

  /**
   * Get when a file-modifying tool last completed for this workspace.
   * Returns undefined if no tools have completed since last clear.
   */
  getFileModifyingToolMs(workspaceId: string): number | undefined {
    return this.fileModifyingToolMs.get(workspaceId);
  }

  /**
   * Clear the file-modifying tool timestamp after ReviewPanel has consumed it.
   */
  clearFileModifyingToolMs(workspaceId: string): void {
    this.fileModifyingToolMs.delete(workspaceId);
  }

  /**
   * Simulate a file-modifying tool completion for testing.
   * Triggers the same subscription as a real tool-call-end for file_edit_* or bash.
   */
  simulateFileModifyingToolEnd(workspaceId: string): void {
    this.fileModifyingToolMs.set(workspaceId, Date.now());
    this.fileModifyingToolSubs.bump(workspaceId);
  }

  // Private methods

  /**
   * Get or create aggregator for a workspace.
   *
   * REQUIRES: createdAt must be provided for new aggregators.
   * Backend guarantees every workspace has createdAt via config.ts.
   *
   * If aggregator already exists, createdAt is optional (it was already set during creation).
   */
  private getOrCreateAggregator(
    workspaceId: string,
    createdAt: string,
    unarchivedAt?: string
  ): StreamingMessageAggregator {
    if (!this.aggregators.has(workspaceId)) {
      // Create new aggregator with required createdAt and workspaceId for localStorage persistence
      const aggregator = new StreamingMessageAggregator(createdAt, workspaceId, unarchivedAt);
      // Wire up navigation callback for notification clicks
      if (this.navigateToWorkspaceCallback) {
        aggregator.onNavigateToWorkspace = this.navigateToWorkspaceCallback;
      }
      // Wire up response complete callback for "notify on response" feature
      if (this.responseCompleteCallback) {
        aggregator.onResponseComplete = this.responseCompleteCallback;
      }
      this.aggregators.set(workspaceId, aggregator);
      this.workspaceCreatedAt.set(workspaceId, createdAt);
    } else if (unarchivedAt) {
      // Update unarchivedAt on existing aggregator (e.g., after restore from archive)
      this.aggregators.get(workspaceId)!.setUnarchivedAt(unarchivedAt);
    }

    return this.aggregators.get(workspaceId)!;
  }

  /**
   * Check if data is a buffered event type by checking the handler map.
   * This ensures isStreamEvent() and processStreamEvent() can never fall out of sync.
   */
  private isBufferedEvent(data: WorkspaceChatMessage): boolean {
    if (!("type" in data)) {
      return false;
    }

    // Buffer high-frequency stream events (including bash/task live updates) until
    // caught-up so full-replay reconnects can deterministically rebuild transient state.
    return (
      data.type in this.bufferedEventHandlers ||
      data.type === "bash-output" ||
      data.type === "task-created"
    );
  }

  private handleChatMessage(workspaceId: string, data: WorkspaceChatMessage): void {
    // Aggregator must exist - workspaces are initialized in addWorkspace() before subscriptions run.
    const aggregator = this.assertGet(workspaceId);

    const transient = this.assertChatTransientState(workspaceId);

    if (isCaughtUpMessage(data)) {
      const replay = data.replay ?? "full";

      // Check if there's an active stream in buffered events (reconnection scenario)
      const pendingEvents = transient.pendingStreamEvents;
      const hasActiveStream = pendingEvents.some(
        (event) => "type" in event && event.type === "stream-start"
      );

      const serverActiveStreamMessageId = data.cursor?.stream?.messageId;
      const localActiveStreamMessageId = aggregator.getActiveStreamMessageId();
      const streamContextMismatched =
        serverActiveStreamMessageId !== undefined &&
        serverActiveStreamMessageId !== localActiveStreamMessageId;

      // Track the server's replay window start for accurate reconnect cursors.
      // This prevents loadOlderHistory-prepended pages from polluting the cursor.
      const serverOldestSeq = data.cursor?.history?.oldestHistorySequence;
      if (typeof serverOldestSeq === "number") {
        aggregator.setEstablishedOldestHistorySequence(serverOldestSeq);
      }

      // Defensive cleanup:
      // - full replay means backend rebuilt state from scratch, so stale local stream contexts
      //   must be cleared even if a stream cursor is present in caught-up metadata.
      // - no stream cursor means no active stream exists server-side.
      // - mismatched stream IDs means local context is stale (e.g., stream A ended while
      //   disconnected and stream B is now active), so clear before replaying pending events.
      if (
        replay === "full" ||
        serverActiveStreamMessageId === undefined ||
        streamContextMismatched
      ) {
        aggregator.clearActiveStreams();
      }

      if (replay === "full") {
        // Full replay replaces backend-derived history state. Reset transient UI-only
        // fields before replay hydration so stale values do not survive reconnect fallback.
        // queuedMessage is safe to clear because backend now replays a fresh
        // queued-message-changed snapshot before caught-up.
        transient.queuedMessage = null;

        // Auto-retry status is ephemeral and may have resolved while disconnected.
        // Clear stale banners so reconnect UI reflects replayed events only.
        transient.autoRetryStatus = null;

        // Server can downgrade a requested since reconnect to full replay.
        // Clear stale interruption suppression state so retry UI is derived solely
        // from the replayed transcript instead of a pre-disconnect abort reason.
        aggregator.clearLastAbortReason();
      }

      if (replay === "full" || !data.cursor?.stream || streamContextMismatched) {
        // Live tool-call UI is tied to the active stream context; clear it when replay
        // replaces history, reports no active stream, or reports a different stream ID.
        transient.liveBashOutput.clear();
        transient.liveTaskIds.clear();
      }

      if (transient.historicalMessages.length > 0) {
        const loadMode = replay === "full" ? "replace" : "append";
        aggregator.loadHistoricalMessages(transient.historicalMessages, hasActiveStream, {
          mode: loadMode,
        });
        transient.historicalMessages.length = 0;
      } else if (replay === "full") {
        // Full replay can legitimately contain zero messages (e.g. compacted to empty).
        aggregator.loadHistoricalMessages([], hasActiveStream, { mode: "replace" });
      }

      // Mark that we're replaying buffered history (prevents O(N) scheduling)
      transient.replayingHistory = true;

      // Process buffered stream events now that history is loaded
      for (const event of pendingEvents) {
        this.processStreamEvent(workspaceId, aggregator, event);
      }
      pendingEvents.length = 0;

      // Done replaying buffered events
      transient.replayingHistory = false;

      if (replay === "since" && data.hasOlderHistory === undefined) {
        // Since reconnects keep the pre-disconnect pagination state. The server
        // omits hasOlderHistory for this mode because the client already knows it.
        if (!this.historyPagination.has(workspaceId)) {
          this.historyPagination.set(workspaceId, createInitialHistoryPaginationState());
        }
      } else {
        this.historyPagination.set(
          workspaceId,
          this.deriveHistoryPaginationState(aggregator, data.hasOlderHistory)
        );
      }
      // Mark as caught up
      transient.caughtUp = true;
      this.states.bump(workspaceId);
      this.checkAndBumpRecencyIfChanged(); // Messages loaded, update recency

      // Usage-only updates can trigger an extra full ChatPane render right after catch-up.
      // Schedule this as idle follow-up so initial transcript paint wins the critical path.
      this.scheduleCaughtUpUsageBump(workspaceId);

      // Hydrate consumer breakdown from persisted cache when possible.
      // Fall back to tokenization when no cache (or stale cache) exists.
      if (aggregator.getAllMessages().length > 0) {
        this.ensureConsumersCached(workspaceId, aggregator);
      }

      return;
    }

    // Handle idle-compaction-started event from backend execution.
    if ("type" in data && data.type === "idle-compaction-started") {
      this.notifyIdleCompactionStarted(workspaceId);
      return;
    }

    // Heartbeat events are no-ops for UI state - they exist only for connection liveness detection
    if ("type" in data && data.type === "heartbeat") {
      return;
    }

    // OPTIMIZATION: Buffer stream events until caught-up to reduce excess re-renders
    // When first subscribing to a workspace, we receive:
    // 1. Historical messages from chat.jsonl (potentially hundreds of messages)
    // 2. Partial stream state (if stream was interrupted)
    // 3. Active stream events (if currently streaming)
    //
    // Without buffering, each event would trigger a separate re-render as messages
    // arrive one-by-one over IPC. By buffering until "caught-up", we:
    // - Load all historical messages in one batch (O(1) render instead of O(N))
    // - Replay buffered stream events after history is loaded
    // - Provide correct context for stream continuation (history is complete)
    //
    // This is especially important for workspaces with long histories (100+ messages),
    // where unbuffered rendering would cause visible lag and UI stutter.
    if (!transient.caughtUp && this.isBufferedEvent(data)) {
      transient.pendingStreamEvents.push(data);
      return;
    }

    // Process event immediately (already caught up or not a stream event)
    this.processStreamEvent(workspaceId, aggregator, data);
  }

  private processStreamEvent(
    workspaceId: string,
    aggregator: StreamingMessageAggregator,
    data: WorkspaceChatMessage
  ): void {
    // Handle non-buffered special events first
    if (isStreamError(data)) {
      const transient = this.assertChatTransientState(workspaceId);

      // Suppress side effects during buffered replay (we're just hydrating UI state), but allow
      // live errors to trigger mux-gateway session-expired handling even before we're "caught up".
      // In particular, mux-gateway 401s can surface as a pre-stream stream-error (before any
      // stream-start) during startup/reconnect.
      const allowSideEffects = !transient.replayingHistory;

      applyWorkspaceChatEventToAggregator(aggregator, data, { allowSideEffects });

      this.states.bump(workspaceId);
      return;
    }

    if (isDeleteMessage(data)) {
      applyWorkspaceChatEventToAggregator(aggregator, data);
      this.cleanupStaleLiveBashOutput(workspaceId, aggregator);
      this.states.bump(workspaceId);
      this.checkAndBumpRecencyIfChanged();
      this.usageStore.bump(workspaceId);
      this.consumerManager.scheduleCalculation(workspaceId, aggregator);
      return;
    }

    if (isBashOutputEvent(data)) {
      const hasText = data.text.length > 0;
      const hasPhase = data.phase !== undefined;
      if (!hasText && !hasPhase) return;

      const transient = this.assertChatTransientState(workspaceId);

      const prev = transient.liveBashOutput.get(data.toolCallId);
      const next = appendLiveBashOutputChunk(
        prev,
        { text: data.text, isError: data.isError, phase: data.phase },
        BASH_TRUNCATE_MAX_TOTAL_BYTES
      );

      // Avoid unnecessary re-renders if this event didn't change the stored state.
      if (next === prev) return;

      transient.liveBashOutput.set(data.toolCallId, next);

      // High-frequency: throttle UI updates like other delta-style events.
      this.scheduleIdleStateBump(workspaceId);
      return;
    }

    if (isTaskCreatedEvent(data)) {
      const transient = this.assertChatTransientState(workspaceId);

      // Avoid unnecessary re-renders if the taskId is unchanged.
      const prev = transient.liveTaskIds.get(data.toolCallId);
      if (prev === data.taskId) return;

      transient.liveTaskIds.set(data.toolCallId, data.taskId);

      // Low-frequency: bump immediately so the user can open the child workspace quickly.
      this.states.bump(workspaceId);
      return;
    }
    // Try buffered event handlers (single source of truth)
    if ("type" in data && data.type in this.bufferedEventHandlers) {
      this.bufferedEventHandlers[data.type](workspaceId, aggregator, data);
      return;
    }

    // Regular messages (MuxMessage without type field)
    if (isMuxMessage(data)) {
      const transient = this.assertChatTransientState(workspaceId);

      if (!transient.caughtUp) {
        // Buffer historical MuxMessages
        transient.historicalMessages.push(data);
      } else {
        // Process live events immediately (after history loaded)
        applyWorkspaceChatEventToAggregator(aggregator, data);

        const muxMeta = data.metadata?.muxMetadata as { type?: string } | undefined;
        const isCompactionBoundarySummary =
          data.role === "assistant" &&
          (data.metadata?.compactionBoundary === true || muxMeta?.type === "compaction-summary");

        if (isCompactionBoundarySummary) {
          // Live compaction prunes older messages inside the aggregator; refresh the
          // pagination cursor so "Load more" starts from the new oldest visible sequence.
          this.historyPagination.set(workspaceId, this.deriveHistoryPaginationState(aggregator));
        }

        this.states.bump(workspaceId);
        this.usageStore.bump(workspaceId);
        this.checkAndBumpRecencyIfChanged();
      }
      return;
    }

    // If we reach here, unknown message type - log for debugging
    if ("role" in data || "type" in data) {
      console.error("[WorkspaceStore] Unknown message type - not processed", {
        workspaceId,
        hasRole: "role" in data,
        hasType: "type" in data,
        type: "type" in data ? (data as { type: string }).type : undefined,
        role: "role" in data ? (data as { role: string }).role : undefined,
      });
    }
    // Note: Messages without role/type are silently ignored (expected for some IPC events)
  }
}

// ============================================================================
// React Integration with useSyncExternalStore
// ============================================================================

// Singleton store instance
let storeInstance: WorkspaceStore | null = null;

/**
 * Get or create the singleton WorkspaceStore instance.
 */
function getStoreInstance(): WorkspaceStore {
  storeInstance ??= new WorkspaceStore(() => {
    // Model tracking callback - can hook into other systems if needed
  });
  return storeInstance;
}

/**
 * Direct access to the singleton store instance.
 * Use this for non-hook subscriptions (e.g., in useEffect callbacks).
 */
export const workspaceStore = {
  onIdleCompactionStarted: (callback: (workspaceId: string) => void) =>
    getStoreInstance().onIdleCompactionStarted(callback),
  subscribeFileModifyingTool: (listener: (workspaceId: string) => void, workspaceId?: string) =>
    getStoreInstance().subscribeFileModifyingTool(listener, workspaceId),
  getFileModifyingToolMs: (workspaceId: string) =>
    getStoreInstance().getFileModifyingToolMs(workspaceId),
  clearFileModifyingToolMs: (workspaceId: string) =>
    getStoreInstance().clearFileModifyingToolMs(workspaceId),
  /**
   * Simulate a file-modifying tool completion for testing.
   * Triggers the same subscription as a real tool-call-end for file_edit_* or bash.
   */
  simulateFileModifyingToolEnd: (workspaceId: string) =>
    getStoreInstance().simulateFileModifyingToolEnd(workspaceId),
  /**
   * Get sidebar-specific state for a workspace.
   * Useful in tests for checking recencyTimestamp without hooks.
   */
  getWorkspaceSidebarState: (workspaceId: string) =>
    getStoreInstance().getWorkspaceSidebarState(workspaceId),
  /**
   * Register a workspace in the store (idempotent).
   * Exposed for test helpers that need to ensure workspace registration
   * before setting it as active.
   */
  addWorkspace: (metadata: FrontendWorkspaceMetadata) => getStoreInstance().addWorkspace(metadata),
  /**
   * Set the active workspace for onChat subscription management.
   * Exposed for test helpers that bypass React routing effects.
   */
  setActiveWorkspaceId: (workspaceId: string | null) =>
    getStoreInstance().setActiveWorkspaceId(workspaceId),
};

/**
 * Hook to get state for a specific workspace.
 * Only re-renders when THIS workspace's state changes.
 *
 * Uses per-key subscription for surgical updates - only notified when
 * this specific workspace's state changes.
 */
export function useWorkspaceState(workspaceId: string): WorkspaceState {
  const store = getStoreInstance();

  return useSyncExternalStore(
    (listener) => store.subscribeKey(workspaceId, listener),
    () => store.getWorkspaceState(workspaceId)
  );
}

/**
 * Hook to access the raw store for imperative operations.
 */
export function useWorkspaceStoreRaw(): WorkspaceStore {
  return getStoreInstance();
}

/**
 * Hook to get workspace recency timestamps.
 * Subscribes to derived state since recency is updated via derived.bump("recency").
 */
export function useWorkspaceRecency(): Record<string, number> {
  const store = getStoreInstance();

  return useSyncExternalStore(store.subscribeDerived, () => store.getWorkspaceRecency());
}

/**
 * Hook to get sidebar-specific state for a workspace.
 * Only re-renders when sidebar-relevant fields change (not on every message).
 *
 * getWorkspaceSidebarState returns cached references, so this won't cause
 * unnecessary re-renders even when the subscription fires.
 */
export function useWorkspaceSidebarState(workspaceId: string): WorkspaceSidebarState {
  const store = getStoreInstance();

  return useSyncExternalStore(
    (listener) => store.subscribeKey(workspaceId, listener),
    () => store.getWorkspaceSidebarState(workspaceId)
  );
}

/**
 * Hook to get UI-only live stdout/stderr for a running bash tool call.
 */
export function useBashToolLiveOutput(
  workspaceId: string | undefined,
  toolCallId: string | undefined
): LiveBashOutputView | null {
  const store = getStoreInstance();

  return useSyncExternalStore(
    (listener) => {
      if (!workspaceId) return () => undefined;
      return store.subscribeKey(workspaceId, listener);
    },
    () => {
      if (!workspaceId || !toolCallId) return null;
      return store.getBashToolLiveOutput(workspaceId, toolCallId);
    }
  );
}

/**
 * Hook to get UI-only taskId for a running task tool call.
 *
 * This exists because foreground tasks (run_in_background=false) won't return a tool result
 * until the child workspace finishes, but we still want to expose the spawned taskId ASAP.
 */
export function useTaskToolLiveTaskId(
  workspaceId: string | undefined,
  toolCallId: string | undefined
): string | null {
  const store = getStoreInstance();

  return useSyncExternalStore(
    (listener) => {
      if (!workspaceId) return () => undefined;
      return store.subscribeKey(workspaceId, listener);
    },
    () => {
      if (!workspaceId || !toolCallId) return null;
      return store.getTaskToolLiveTaskId(workspaceId, toolCallId);
    }
  );
}

/**
 * Hook to get the toolCallId of the latest streaming (executing) bash.
 * Returns null if no bash is currently streaming.
 * Used by BashToolCall to auto-expand/collapse.
 */
export function useLatestStreamingBashId(workspaceId: string | undefined): string | null {
  const store = getStoreInstance();

  return useSyncExternalStore(
    (listener) => {
      if (!workspaceId) return () => undefined;
      return store.subscribeKey(workspaceId, listener);
    },
    () => {
      if (!workspaceId) return null;
      const aggregator = store.getAggregator(workspaceId);
      if (!aggregator) return null;
      // Aggregator caches the result, so this is O(1) on subsequent calls
      return aggregator.getLatestStreamingBashToolCallId();
    }
  );
}

/**
 * Hook to get an aggregator for a workspace.
 */
export function useWorkspaceAggregator(
  workspaceId: string
): StreamingMessageAggregator | undefined {
  const store = useWorkspaceStoreRaw();
  return store.getAggregator(workspaceId);
}

/**
 * Disable the displayed message cap for a workspace and trigger a re-render.
 * Used by HistoryHiddenMessage “Load all”.
 */
export function showAllMessages(workspaceId: string): void {
  assert(
    typeof workspaceId === "string" && workspaceId.length > 0,
    "showAllMessages requires workspaceId"
  );

  const store = getStoreInstance();
  const aggregator = store.getAggregator(workspaceId);
  if (aggregator) {
    aggregator.setShowAllMessages(true);
    store.bumpState(workspaceId);
  }
}

/**
 * Add an ephemeral message to a workspace and trigger a re-render.
 * Used for displaying frontend-only messages like /plan output.
 */
export function addEphemeralMessage(workspaceId: string, message: MuxMessage): void {
  const store = getStoreInstance();
  const aggregator = store.getAggregator(workspaceId);
  if (aggregator) {
    aggregator.addMessage(message);
    store.bumpState(workspaceId);
  }
}

/**
 * Remove an ephemeral message from a workspace and trigger a re-render.
 * Used for dismissing frontend-only messages like /plan output.
 */
export function removeEphemeralMessage(workspaceId: string, messageId: string): void {
  const store = getStoreInstance();
  const aggregator = store.getAggregator(workspaceId);
  if (aggregator) {
    aggregator.removeMessage(messageId);
    store.bumpState(workspaceId);
  }
}

/**
 * Hook for usage metadata (instant, no tokenization).
 * Updates immediately when usage metadata arrives from API responses.
 */
export function useWorkspaceUsage(workspaceId: string): WorkspaceUsageState {
  const store = getStoreInstance();
  return useSyncExternalStore(
    (listener) => store.subscribeUsage(workspaceId, listener),
    () => store.getWorkspaceUsage(workspaceId)
  );
}

/**
 * Hook for backend timing stats snapshots.
 */
export function useWorkspaceStatsSnapshot(workspaceId: string): WorkspaceStatsSnapshot | null {
  const store = getStoreInstance();

  // NOTE: subscribeStats() starts/stops a backend subscription; if React re-subscribes on every
  // render (because the subscribe callback is unstable), we can trigger an infinite loop.
  // This useCallback is for correctness, not performance.
  const subscribe = useCallback(
    (listener: () => void) => store.subscribeStats(workspaceId, listener),
    [store, workspaceId]
  );
  const getSnapshot = useCallback(
    () => store.getWorkspaceStatsSnapshot(workspaceId),
    [store, workspaceId]
  );

  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * Hook for consumer breakdown (lazy, with tokenization).
 * Updates after async Web Worker calculation completes.
 */
export function useWorkspaceConsumers(workspaceId: string): WorkspaceConsumersState {
  const store = getStoreInstance();
  return useSyncExternalStore(
    (listener) => store.subscribeConsumers(workspaceId, listener),
    () => store.getWorkspaceConsumers(workspaceId)
  );
}
