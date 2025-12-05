import assert from "@/common/utils/assert";
import type { MuxMessage, DisplayedMessage, QueuedMessage } from "@/common/types/message";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import type { TodoItem } from "@/common/types/tools";
import { StreamingMessageAggregator } from "@/browser/utils/messages/StreamingMessageAggregator";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getRetryStateKey } from "@/common/constants/storage";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { useSyncExternalStore } from "react";
import {
  isCaughtUpMessage,
  isStreamError,
  isDeleteMessage,
  isMuxMessage,
  isQueuedMessageChanged,
  isRestoreToInput,
} from "@/common/orpc/types";
import type { StreamEndEvent, StreamAbortEvent } from "@/common/types/stream";
import { MapStore } from "./MapStore";
import { collectUsageHistory, createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import { WorkspaceConsumerManager } from "./WorkspaceConsumerManager";
import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import type { TokenConsumer } from "@/common/types/chatStats";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import { createFreshRetryState } from "@/browser/utils/messages/retryState";
import { trackStreamCompleted } from "@/common/telemetry";

export interface WorkspaceState {
  name: string; // User-facing workspace name (e.g., "feature-branch")
  messages: DisplayedMessage[];
  queuedMessage: QueuedMessage | null;
  canInterrupt: boolean;
  isCompacting: boolean;
  loading: boolean;
  muxMessages: MuxMessage[];
  currentModel: string | null;
  recencyTimestamp: number | null;
  todos: TodoItem[];
  agentStatus: { emoji: string; message: string; url?: string } | undefined;
  pendingStreamStartTime: number | null;
}

/**
 * Subset of WorkspaceState needed for sidebar display.
 * Subscribing to only these fields prevents re-renders when messages update.
 */
export interface WorkspaceSidebarState {
  canInterrupt: boolean;
  currentModel: string | null;
  recencyTimestamp: number | null;
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
 * - usageHistory: Total usage per message (sum of all steps) for cost calculation
 * - lastContextUsage: Last step's usage for context window display (inputTokens = actual context size)
 */
export interface WorkspaceUsageState {
  /** Usage history for cost calculation (total across all steps per message) */
  usageHistory: ChatUsageDisplay[];
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
  private consumersStore = new MapStore<string, WorkspaceConsumersState>();

  // Manager for consumer calculations (debouncing, caching, lazy loading)
  // Architecture: WorkspaceStore orchestrates (decides when), manager executes (performs calculations)
  // Dual-cache: consumersStore (MapStore) handles subscriptions, manager owns data cache
  private readonly consumerManager: WorkspaceConsumerManager;

  // Supporting data structures
  private aggregators = new Map<string, StreamingMessageAggregator>();
  private ipcUnsubscribers = new Map<string, () => void>();
  private caughtUp = new Map<string, boolean>();
  private historicalMessages = new Map<string, MuxMessage[]>();
  private pendingStreamEvents = new Map<string, WorkspaceChatMessage[]>();
  private workspaceMetadata = new Map<string, FrontendWorkspaceMetadata>(); // Store metadata for name lookup
  private queuedMessages = new Map<string, QueuedMessage | null>(); // Cached queued messages

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
      aggregator.handleStreamStart(data as never);
      if (this.onModelUsed) {
        this.onModelUsed((data as { model: string }).model);
      }
      // Don't reset retry state here - stream might still fail after starting
      // Retry state will be reset on stream-end (successful completion)
      this.states.bump(workspaceId);
      // Bump usage store so liveUsage is recomputed with new activeStreamId
      this.usageStore.bump(workspaceId);
    },
    "stream-delta": (workspaceId, aggregator, data) => {
      aggregator.handleStreamDelta(data as never);
      this.scheduleIdleStateBump(workspaceId);
    },
    "stream-end": (workspaceId, aggregator, data) => {
      const streamEndData = data as StreamEndEvent;
      aggregator.handleStreamEnd(streamEndData as never);
      aggregator.clearTokenState(streamEndData.messageId);

      // Track stream completion telemetry
      this.trackStreamCompletedTelemetry(streamEndData, false);

      // Reset retry state on successful stream completion
      updatePersistedState(getRetryStateKey(workspaceId), createFreshRetryState());

      // Flush any pending debounced bump before final bump to avoid double-bump
      this.cancelPendingIdleBump(workspaceId);
      this.states.bump(workspaceId);
      this.checkAndBumpRecencyIfChanged();
      this.finalizeUsageStats(workspaceId, streamEndData.metadata);
    },
    "stream-abort": (workspaceId, aggregator, data) => {
      const streamAbortData = data as StreamAbortEvent;
      aggregator.clearTokenState(streamAbortData.messageId);
      aggregator.handleStreamAbort(streamAbortData as never);

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
      this.dispatchResumeCheck(workspaceId);
      this.finalizeUsageStats(workspaceId, streamAbortData.metadata);
    },
    "tool-call-start": (workspaceId, aggregator, data) => {
      aggregator.handleToolCallStart(data as never);
      this.states.bump(workspaceId);
    },
    "tool-call-delta": (workspaceId, aggregator, data) => {
      aggregator.handleToolCallDelta(data as never);
      this.scheduleIdleStateBump(workspaceId);
    },
    "tool-call-end": (workspaceId, aggregator, data) => {
      aggregator.handleToolCallEnd(data as never);
      this.states.bump(workspaceId);
      this.consumerManager.scheduleCalculation(workspaceId, aggregator);
    },
    "reasoning-delta": (workspaceId, aggregator, data) => {
      aggregator.handleReasoningDelta(data as never);
      this.scheduleIdleStateBump(workspaceId);
    },
    "reasoning-end": (workspaceId, aggregator, data) => {
      aggregator.handleReasoningEnd(data as never);
      this.states.bump(workspaceId);
    },
    "usage-delta": (workspaceId, aggregator, data) => {
      aggregator.handleUsageDelta(data as never);
      this.usageStore.bump(workspaceId);
    },
    "init-start": (workspaceId, aggregator, data) => {
      aggregator.handleMessage(data);
      this.states.bump(workspaceId);
    },
    "init-output": (workspaceId, aggregator, data) => {
      aggregator.handleMessage(data);
      this.states.bump(workspaceId);
    },
    "init-end": (workspaceId, aggregator, data) => {
      aggregator.handleMessage(data);
      this.states.bump(workspaceId);
    },
    "queued-message-changed": (workspaceId, _aggregator, data) => {
      if (!isQueuedMessageChanged(data)) return;

      // Create QueuedMessage once here instead of on every render
      // Use displayText which handles slash commands (shows /compact instead of expanded prompt)
      // Show queued message if there's text OR images (support image-only queued messages)
      const hasContent = data.queuedMessages.length > 0 || (data.imageParts?.length ?? 0) > 0;
      const queuedMessage: QueuedMessage | null = hasContent
        ? {
            id: `queued-${workspaceId}`,
            content: data.displayText,
            imageParts: data.imageParts,
          }
        : null;

      this.queuedMessages.set(workspaceId, queuedMessage);
      this.states.bump(workspaceId);
    },
    "restore-to-input": (workspaceId, _aggregator, data) => {
      if (!isRestoreToInput(data)) return;

      // Use INSERT_TO_CHAT_INPUT event with mode="replace"
      window.dispatchEvent(
        createCustomEvent(CUSTOM_EVENTS.INSERT_TO_CHAT_INPUT, {
          text: data.text,
          mode: "replace",
          imageParts: data.imageParts,
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

  // Track workspaces currently replaying buffered history (to avoid O(N) scheduling)
  private replayingHistory = new Set<string>();

  // Track model usage (injected dependency for useModelLRU integration)
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

  setClient(client: RouterClient<AppRouter>) {
    this.client = client;
  }

  /**
   * Dispatch resume check event for a workspace.
   * Triggers useResumeManager to check if interrupted stream can be resumed.
   */
  private dispatchResumeCheck(workspaceId: string): void {
    window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.RESUME_CHECK_REQUESTED, { workspaceId }));
  }

  /**
   * Schedule a state bump during browser idle time.
   * Instead of updating UI on every delta, wait until the browser has spare capacity.
   * This adapts to actual CPU availability - fast machines update more frequently,
   * slow machines naturally throttle without dropping data.
   *
   * Data is always updated immediately in the aggregator - only UI notification is deferred.
   */
  private scheduleIdleStateBump(workspaceId: string): void {
    // Skip if already scheduled
    if (this.deltaIdleHandles.has(workspaceId)) {
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
   * Cancel any pending idle state bump for a workspace.
   * Used when immediate state visibility is needed (e.g., stream-end).
   * Just cancels the callback - the caller will bump() immediately after.
   */
  private cancelPendingIdleBump(workspaceId: string): void {
    const handle = this.deltaIdleHandles.get(workspaceId);
    if (handle) {
      cancelIdleCallback(handle);
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

  /**
   * Assert that workspace exists and return its aggregator.
   * Centralized assertion for all workspace access methods.
   */
  private assertGet(workspaceId: string): StreamingMessageAggregator {
    const aggregator = this.aggregators.get(workspaceId);
    assert(aggregator, `Workspace ${workspaceId} not found - must call addWorkspace() first`);
    return aggregator;
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
      const isCaughtUp = this.caughtUp.get(workspaceId) ?? false;
      const activeStreams = aggregator.getActiveStreams();
      const messages = aggregator.getAllMessages();
      const metadata = this.workspaceMetadata.get(workspaceId);

      return {
        name: metadata?.name ?? workspaceId, // Fall back to ID if metadata missing
        messages: aggregator.getDisplayedMessages(),
        queuedMessage: this.queuedMessages.get(workspaceId) ?? null,
        canInterrupt: activeStreams.length > 0,
        isCompacting: aggregator.isCompacting(),
        loading: !hasMessages && !isCaughtUp,
        muxMessages: messages,
        currentModel: aggregator.getCurrentModel() ?? null,
        recencyTimestamp: aggregator.getRecencyTimestamp(),
        todos: aggregator.getCurrentTodos(),
        agentStatus: aggregator.getAgentStatus(),
        pendingStreamStartTime: aggregator.getPendingStreamStartTime(),
      };
    });
  }

  // Cache sidebar state objects to return stable references
  private sidebarStateCache = new Map<string, WorkspaceSidebarState>();

  /**
   * Get sidebar state for a workspace (subset of full state).
   * Returns cached reference if values haven't changed.
   * This is critical for useSyncExternalStore - must return stable references.
   */
  getWorkspaceSidebarState(workspaceId: string): WorkspaceSidebarState {
    const fullState = this.getWorkspaceState(workspaceId);
    const cached = this.sidebarStateCache.get(workspaceId);

    // Return cached if values match
    if (
      cached &&
      cached.canInterrupt === fullState.canInterrupt &&
      cached.currentModel === fullState.currentModel &&
      cached.recencyTimestamp === fullState.recencyTimestamp &&
      cached.agentStatus === fullState.agentStatus
    ) {
      return cached;
    }

    // Create and cache new state
    const newState: WorkspaceSidebarState = {
      canInterrupt: fullState.canInterrupt,
      currentModel: fullState.currentModel,
      recencyTimestamp: fullState.recencyTimestamp,
      agentStatus: fullState.agentStatus,
    };
    this.sidebarStateCache.set(workspaceId, newState);
    return newState;
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
   * Extract usage from messages (no tokenization).
   * Each usage entry calculated with its own model for accurate costs.
   *
   * Returns empty state if workspace doesn't exist (e.g., creation mode).
   */
  getWorkspaceUsage(workspaceId: string): WorkspaceUsageState {
    return this.usageStore.get(workspaceId, () => {
      const aggregator = this.aggregators.get(workspaceId);
      if (!aggregator) {
        return { usageHistory: [], totalTokens: 0 };
      }

      const messages = aggregator.getAllMessages();
      const model = aggregator.getCurrentModel();

      // Collect usage history for cost calculation (total across all steps per message)
      const usageHistory = collectUsageHistory(messages, model);

      // Calculate total from usage history (now includes historical)
      const totalTokens = usageHistory.reduce(
        (sum, u) =>
          sum +
          u.input.tokens +
          u.cached.tokens +
          u.cacheCreate.tokens +
          u.output.tokens +
          u.reasoning.tokens,
        0
      );

      // Get last message's context usage for context window display
      // Uses contextUsage (last step) if available, falls back to usage for old messages
      // Skips compacted messages - their usage reflects pre-compaction context, not current
      const lastContextUsage = (() => {
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (msg.role === "assistant") {
            // Skip compacted messages - their usage is from pre-compaction context
            // and doesn't reflect current context window size
            if (msg.metadata?.compacted) {
              continue;
            }
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

      // Include active stream usage if currently streaming
      const activeStreamId = aggregator.getActiveStreamMessageId();

      // Live context usage (last step's inputTokens = current context window)
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

      // Live cost usage (cumulative across all steps, with accumulated cache creation tokens)
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

      return { usageHistory, lastContextUsage, totalTokens, liveUsage, liveCostUsage };
    });
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
    const isCaughtUp = this.caughtUp.get(workspaceId) ?? false;

    // Lazy trigger check (runs on EVERY access, not just when MapStore recomputes)
    const cached = this.consumerManager.getCachedState(workspaceId);
    const isPending = this.consumerManager.isPending(workspaceId);

    if (!cached && !isPending && isCaughtUp) {
      if (aggregator && aggregator.getAllMessages().length > 0) {
        // Defer scheduling to avoid setState-during-render warning
        // queueMicrotask ensures this runs after current render completes
        queueMicrotask(() => {
          this.consumerManager.scheduleCalculation(workspaceId, aggregator);
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
    if (this.replayingHistory.has(workspaceId)) {
      if (metadata?.usage) {
        this.usageStore.bump(workspaceId);
      }
      return;
    }

    // Normal real-time path: bump usage and schedule calculation
    if (metadata?.usage) {
      this.usageStore.bump(workspaceId);
    }

    // Always schedule consumer calculation (tool calls, text, etc. need tokenization)
    // Even streams without usage metadata need token counts recalculated
    const aggregator = this.aggregators.get(workspaceId);
    if (aggregator) {
      this.consumerManager.scheduleCalculation(workspaceId, aggregator);
    }
  }

  /**
   * Add a workspace and subscribe to its IPC events.
   */
  addWorkspace(metadata: FrontendWorkspaceMetadata): void {
    const workspaceId = metadata.id;

    // Skip if already subscribed
    if (this.ipcUnsubscribers.has(workspaceId)) {
      return;
    }

    // Store metadata for name lookup
    this.workspaceMetadata.set(workspaceId, metadata);

    // Backend guarantees createdAt via config.ts - this should never be undefined
    assert(
      metadata.createdAt,
      `Workspace ${workspaceId} missing createdAt - backend contract violated`
    );

    const aggregator = this.getOrCreateAggregator(workspaceId, metadata.createdAt);

    // Initialize recency cache and bump derived store immediately
    // This ensures UI sees correct workspace order before messages load
    const initialRecency = aggregator.getRecencyTimestamp();
    if (initialRecency !== null) {
      this.recencyCache.set(workspaceId, initialRecency);
      this.derived.bump("recency");
    }

    // Initialize state
    if (!this.caughtUp.has(workspaceId)) {
      this.caughtUp.set(workspaceId, false);
    }
    if (!this.historicalMessages.has(workspaceId)) {
      this.historicalMessages.set(workspaceId, []);
    }

    // Clear stale streaming state
    aggregator.clearActiveStreams();

    // Subscribe to IPC events
    // Wrap in queueMicrotask to ensure IPC events don't update during React render
    if (this.client) {
      const controller = new AbortController();
      const { signal } = controller;

      // Fire and forget the async loop
      (async () => {
        try {
          const iterator = await this.client!.workspace.onChat({ workspaceId }, { signal });

          for await (const data of iterator) {
            if (signal.aborted) break;
            queueMicrotask(() => {
              this.handleChatMessage(workspaceId, data);
            });
          }
        } catch (error) {
          // Suppress errors when subscription was intentionally cleaned up
          if (signal.aborted) return;

          // EVENT_ITERATOR_VALIDATION_FAILED with ErrorEvent cause happens when:
          // - The workspace was removed on server side (iterator ends with error)
          // - Connection dropped (WebSocket/MessagePort error)
          // Only suppress if workspace no longer exists (was removed during the race)
          const isIteratorError =
            error instanceof Error &&
            "code" in error &&
            error.code === "EVENT_ITERATOR_VALIDATION_FAILED";
          const workspaceRemoved = !this.states.has(workspaceId);
          if (isIteratorError && workspaceRemoved) return;

          console.error(`[WorkspaceStore] Error in onChat subscription for ${workspaceId}:`, error);
        }
      })();

      this.ipcUnsubscribers.set(workspaceId, () => controller.abort());
    } else {
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
    const handle = this.deltaIdleHandles.get(workspaceId);
    if (handle) {
      cancelIdleCallback(handle);
      this.deltaIdleHandles.delete(workspaceId);
    }

    // Unsubscribe from IPC
    const unsubscribe = this.ipcUnsubscribers.get(workspaceId);
    if (unsubscribe) {
      unsubscribe();
      this.ipcUnsubscribers.delete(workspaceId);
    }

    // Clean up state
    this.states.delete(workspaceId);
    this.usageStore.delete(workspaceId);
    this.consumersStore.delete(workspaceId);
    this.aggregators.delete(workspaceId);
    this.caughtUp.delete(workspaceId);
    this.historicalMessages.delete(workspaceId);
    this.pendingStreamEvents.delete(workspaceId);
    this.recencyCache.delete(workspaceId);
    this.previousSidebarValues.delete(workspaceId);
    this.sidebarStateCache.delete(workspaceId);
    this.workspaceCreatedAt.delete(workspaceId);
  }

  /**
   * Sync workspaces with metadata - add new, remove deleted.
   */
  syncWorkspaces(workspaceMetadata: Map<string, FrontendWorkspaceMetadata>): void {
    const metadataIds = new Set(Array.from(workspaceMetadata.values()).map((m) => m.id));
    const currentIds = new Set(this.ipcUnsubscribers.keys());

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
  }

  /**
   * Cleanup all subscriptions (call on unmount).
   */
  dispose(): void {
    // Clean up consumer manager
    this.consumerManager.dispose();

    for (const unsubscribe of this.ipcUnsubscribers.values()) {
      unsubscribe();
    }
    this.ipcUnsubscribers.clear();
    this.states.clear();
    this.derived.clear();
    this.usageStore.clear();
    this.consumersStore.clear();
    this.aggregators.clear();
    this.caughtUp.clear();
    this.historicalMessages.clear();
    this.pendingStreamEvents.clear();
    this.workspaceCreatedAt.clear();
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
    createdAt: string
  ): StreamingMessageAggregator {
    if (!this.aggregators.has(workspaceId)) {
      // Create new aggregator with required createdAt and workspaceId for localStorage persistence
      this.aggregators.set(workspaceId, new StreamingMessageAggregator(createdAt, workspaceId));
      this.workspaceCreatedAt.set(workspaceId, createdAt);
    }

    return this.aggregators.get(workspaceId)!;
  }

  /**
   * Check if data is a buffered event type by checking the handler map.
   * This ensures isStreamEvent() and processStreamEvent() can never fall out of sync.
   */
  private isBufferedEvent(data: WorkspaceChatMessage): boolean {
    return "type" in data && data.type in this.bufferedEventHandlers;
  }

  private handleChatMessage(workspaceId: string, data: WorkspaceChatMessage): void {
    // Aggregator must exist - IPC subscription happens in addWorkspace()
    const aggregator = this.assertGet(workspaceId);

    const isCaughtUp = this.caughtUp.get(workspaceId) ?? false;
    const historicalMsgs = this.historicalMessages.get(workspaceId) ?? [];

    if (isCaughtUpMessage(data)) {
      // Check if there's an active stream in buffered events (reconnection scenario)
      const pendingEvents = this.pendingStreamEvents.get(workspaceId) ?? [];
      const hasActiveStream = pendingEvents.some(
        (event) => "type" in event && event.type === "stream-start"
      );

      // Load historical messages first
      if (historicalMsgs.length > 0) {
        aggregator.loadHistoricalMessages(historicalMsgs, hasActiveStream);
        this.historicalMessages.set(workspaceId, []);
      }

      // Mark that we're replaying buffered history (prevents O(N) scheduling)
      this.replayingHistory.add(workspaceId);

      // Process buffered stream events now that history is loaded
      for (const event of pendingEvents) {
        this.processStreamEvent(workspaceId, aggregator, event);
      }
      this.pendingStreamEvents.set(workspaceId, []);

      // Done replaying buffered events
      this.replayingHistory.delete(workspaceId);

      // Mark as caught up
      this.caughtUp.set(workspaceId, true);
      this.states.bump(workspaceId);
      this.checkAndBumpRecencyIfChanged(); // Messages loaded, update recency

      // Bump usage after loading history
      this.usageStore.bump(workspaceId);

      // Schedule consumer calculation once after all buffered events processed
      if (aggregator.getAllMessages().length > 0) {
        this.consumerManager.scheduleCalculation(workspaceId, aggregator);
      }

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
    if (!isCaughtUp && this.isBufferedEvent(data)) {
      const pending = this.pendingStreamEvents.get(workspaceId) ?? [];
      pending.push(data);
      this.pendingStreamEvents.set(workspaceId, pending);
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
      aggregator.handleStreamError(data);

      // Increment retry attempt counter when stream fails
      // This handles auth errors that happen AFTER stream-start
      updatePersistedState(
        getRetryStateKey(workspaceId),
        (prev) => {
          const newAttempt = prev.attempt + 1;
          console.debug(
            `[retry] ${workspaceId} stream-error: incrementing attempt ${prev.attempt} → ${newAttempt}`
          );
          return {
            attempt: newAttempt,
            retryStartTime: Date.now(),
          };
        },
        { attempt: 0, retryStartTime: Date.now() }
      );

      this.states.bump(workspaceId);
      this.dispatchResumeCheck(workspaceId);
      return;
    }

    if (isDeleteMessage(data)) {
      aggregator.handleDeleteMessage(data);
      this.states.bump(workspaceId);
      this.checkAndBumpRecencyIfChanged();
      this.usageStore.bump(workspaceId);
      this.consumerManager.scheduleCalculation(workspaceId, aggregator);
      return;
    }

    // Try buffered event handlers (single source of truth)
    if ("type" in data && data.type in this.bufferedEventHandlers) {
      this.bufferedEventHandlers[data.type](workspaceId, aggregator, data);
      return;
    }

    // Regular messages (MuxMessage without type field)
    if (isMuxMessage(data)) {
      const isCaughtUp = this.caughtUp.get(workspaceId) ?? false;
      if (!isCaughtUp) {
        // Buffer historical MuxMessages
        const historicalMsgs = this.historicalMessages.get(workspaceId) ?? [];
        historicalMsgs.push(data);
        this.historicalMessages.set(workspaceId, historicalMsgs);
      } else {
        // Process live events immediately (after history loaded)
        aggregator.handleMessage(data);
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
 * Hook to get an aggregator for a workspace.
 */
export function useWorkspaceAggregator(
  workspaceId: string
): StreamingMessageAggregator | undefined {
  const store = useWorkspaceStoreRaw();
  return store.getAggregator(workspaceId);
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
