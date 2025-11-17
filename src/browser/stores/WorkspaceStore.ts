import assert from "@/common/utils/assert";
import type { MuxMessage, DisplayedMessage, QueuedMessage } from "@/common/types/message";
import { createMuxMessage } from "@/common/types/message";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { WorkspaceChatMessage } from "@/common/types/ipc";
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
} from "@/common/types/ipc";
import { MapStore } from "./MapStore";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import { WorkspaceConsumerManager } from "./WorkspaceConsumerManager";
import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import { sumUsageHistory } from "@/common/utils/tokens/usageAggregator";
import type { TokenConsumer } from "@/common/types/chatStats";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import { getCancelledCompactionKey } from "@/common/constants/storage";
import {
  isCompactingStream,
  findCompactionRequestMessage,
} from "@/common/utils/compaction/handler";
import { createFreshRetryState } from "@/browser/utils/messages/retryState";

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
 */
export interface WorkspaceUsageState {
  usageHistory: ChatUsageDisplay[];
  totalTokens: number;
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
    },
    "stream-delta": (workspaceId, aggregator, data) => {
      aggregator.handleStreamDelta(data as never);
      this.states.bump(workspaceId);
    },
    "stream-end": (workspaceId, aggregator, data) => {
      aggregator.handleStreamEnd(data as never);
      aggregator.clearTokenState((data as { messageId: string }).messageId);

      if (this.handleCompactionCompletion(workspaceId, aggregator, data)) {
        return;
      }

      // Reset retry state on successful stream completion
      updatePersistedState(getRetryStateKey(workspaceId), createFreshRetryState());

      this.states.bump(workspaceId);
      this.checkAndBumpRecencyIfChanged();
      this.finalizeUsageStats(workspaceId, (data as { metadata?: never }).metadata);
    },
    "stream-abort": (workspaceId, aggregator, data) => {
      aggregator.clearTokenState((data as { messageId: string }).messageId);
      aggregator.handleStreamAbort(data as never);

      if (this.handleCompactionAbort(workspaceId, aggregator, data)) {
        return;
      }

      this.states.bump(workspaceId);
      this.dispatchResumeCheck(workspaceId);
      this.finalizeUsageStats(workspaceId, (data as { metadata?: never }).metadata);
    },
    "tool-call-start": (workspaceId, aggregator, data) => {
      aggregator.handleToolCallStart(data as never);
      this.states.bump(workspaceId);
    },
    "tool-call-delta": (workspaceId, aggregator, data) => {
      aggregator.handleToolCallDelta(data as never);
      this.states.bump(workspaceId);
    },
    "tool-call-end": (workspaceId, aggregator, data) => {
      aggregator.handleToolCallEnd(data as never);
      this.states.bump(workspaceId);
      this.consumerManager.scheduleCalculation(workspaceId, aggregator);
    },
    "reasoning-delta": (workspaceId, aggregator, data) => {
      aggregator.handleReasoningDelta(data as never);
      this.states.bump(workspaceId);
    },
    "reasoning-end": (workspaceId, aggregator, data) => {
      aggregator.handleReasoningEnd(data as never);
      this.states.bump(workspaceId);
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

  /**
   * Dispatch resume check event for a workspace.
   * Triggers useResumeManager to check if interrupted stream can be resumed.
   */
  private dispatchResumeCheck(workspaceId: string): void {
    window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.RESUME_CHECK_REQUESTED, { workspaceId }));
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
   *
   * REQUIRES: Workspace must have been added via addWorkspace() first.
   */
  getAggregator(workspaceId: string): StreamingMessageAggregator {
    return this.assertGet(workspaceId);
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
   * REQUIRES: Workspace must have been added via addWorkspace() first.
   */
  getWorkspaceUsage(workspaceId: string): WorkspaceUsageState {
    return this.usageStore.get(workspaceId, () => {
      const aggregator = this.assertGet(workspaceId);

      const messages = aggregator.getAllMessages();

      // Extract usage from assistant messages
      const usageHistory: ChatUsageDisplay[] = [];
      let cumulativeHistorical: ChatUsageDisplay | undefined;

      for (const msg of messages) {
        if (msg.role === "assistant") {
          // Check for historical usage from compaction summaries
          // This preserves costs from messages deleted during compaction
          if (msg.metadata?.historicalUsage) {
            cumulativeHistorical = msg.metadata.historicalUsage;
          }

          // Extract current message's usage
          if (msg.metadata?.usage) {
            // Use the model from this specific message (not global)
            const model = msg.metadata.model ?? aggregator.getCurrentModel() ?? "unknown";

            const usage = createDisplayUsage(
              msg.metadata.usage,
              model,
              msg.metadata.providerMetadata
            );

            if (usage) {
              usageHistory.push(usage);
            }
          }
        }
      }

      // If we have historical usage from a compaction, prepend it to history
      // This ensures costs from pre-compaction messages are included in totals
      if (cumulativeHistorical) {
        usageHistory.unshift(cumulativeHistorical);
      }

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

      return { usageHistory, totalTokens };
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
   * Handle compact_summary tool completion.
   * Returns true if compaction was handled (caller should early return).
   */
  // Track processed compaction-request IDs to dedupe performCompaction across duplicated events
  private processedCompactionRequestIds = new Set<string>();

  private handleCompactionCompletion(
    workspaceId: string,
    aggregator: StreamingMessageAggregator,
    data: WorkspaceChatMessage
  ): boolean {
    // Type guard: only StreamEndEvent has messageId
    if (!("messageId" in data)) return false;

    // Check if this was a compaction stream
    if (!isCompactingStream(aggregator)) {
      return false;
    }

    // Extract the compaction-request message to identify this compaction run
    const compactionRequestMsg = findCompactionRequestMessage(aggregator);
    if (!compactionRequestMsg) {
      return false;
    }

    // Dedupe: If we've already processed this compaction-request, skip re-running
    if (this.processedCompactionRequestIds.has(compactionRequestMsg.id)) {
      return true; // Already handled compaction for this request
    }

    // Extract the summary text from the assistant's response
    const summary = aggregator.getCompactionSummary(data.messageId);
    if (!summary) {
      console.warn("[WorkspaceStore] Compaction completed but no summary text found");
      return false;
    }

    // Mark this compaction-request as processed before performing compaction
    this.processedCompactionRequestIds.add(compactionRequestMsg.id);

    this.performCompaction(workspaceId, aggregator, data, summary);
    return true;
  }

  /**
   * Handle interruption of a compaction stream (StreamAbortEvent).
   *
   * Two distinct flows trigger this:
   * - **Ctrl+A (accept early)**: Perform compaction with [truncated] sentinel
   * - **Ctrl+C (cancel)**: Skip compaction, let cancelCompaction handle cleanup
   *
   * Uses localStorage to distinguish flows:
   * - Checks for cancellation marker in localStorage
   * - Verifies messageId matches for freshness
   * - Reload-safe: localStorage persists across page reloads
   */
  private handleCompactionAbort(
    workspaceId: string,
    aggregator: StreamingMessageAggregator,
    data: WorkspaceChatMessage
  ): boolean {
    // Type guard: only StreamAbortEvent has messageId
    if (!("messageId" in data)) return false;

    // Check if this was a compaction stream
    if (!isCompactingStream(aggregator)) {
      return false;
    }

    // Get the compaction request message for ID verification
    const compactionRequestMsg = findCompactionRequestMessage(aggregator);
    if (!compactionRequestMsg) {
      return false;
    }

    // Ctrl+C flow: Check localStorage for cancellation marker
    // Verify compaction-request user message ID matches (stable across retries)
    const storageKey = getCancelledCompactionKey(workspaceId);
    const cancelData = localStorage.getItem(storageKey);
    if (cancelData) {
      try {
        const parsed = JSON.parse(cancelData) as { compactionRequestId: string; timestamp: number };
        if (parsed.compactionRequestId === compactionRequestMsg.id) {
          // This is a cancelled compaction - clean up marker and skip compaction
          localStorage.removeItem(storageKey);
          return false; // Skip compaction, cancelCompaction() handles cleanup
        }
      } catch (error) {
        console.error("[WorkspaceStore] Failed to parse cancellation data:", error);
      }
      // If compactionRequestId doesn't match or parse failed, clean up stale data
      localStorage.removeItem(storageKey);
    }

    // Ctrl+A flow: Accept early with [truncated] sentinel
    const partialSummary = aggregator.getCompactionSummary(data.messageId);
    if (!partialSummary) {
      console.warn("[WorkspaceStore] Compaction aborted but no partial summary found");
      return false;
    }

    // Append [truncated] sentinel on new line to indicate incomplete summary
    const truncatedSummary = partialSummary.trim() + "\n\n[truncated]";

    this.performCompaction(workspaceId, aggregator, data, truncatedSummary);
    return true;
  }

  /**
   * Perform history compaction by replacing chat history with summary message.
   * Type-safe: only called when we've verified data is a StreamEndEvent.
   */
  private performCompaction(
    workspaceId: string,
    aggregator: StreamingMessageAggregator,
    data: WorkspaceChatMessage,
    summary: string
  ): void {
    // Extract metadata safely with type guard
    const metadata = "metadata" in data ? data.metadata : undefined;

    // Calculate cumulative historical usage before replacing history
    // This preserves costs from all messages that are about to be deleted
    const currentUsage = this.getWorkspaceUsage(workspaceId);
    const historicalUsage =
      currentUsage.usageHistory.length > 0 ? sumUsageHistory(currentUsage.usageHistory) : undefined;

    // Extract continueMessage from compaction-request before history gets replaced
    const compactRequestMsg = findCompactionRequestMessage(aggregator);
    const muxMeta = compactRequestMsg?.metadata?.muxMetadata;
    const continueMessage =
      muxMeta?.type === "compaction-request" ? muxMeta.parsed.continueMessage : undefined;

    const summaryMessage = createMuxMessage(
      `summary-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
      "assistant",
      summary,
      {
        timestamp: Date.now(),
        compacted: true,
        model: aggregator.getCurrentModel(),
        usage: metadata?.usage,
        historicalUsage, // Store cumulative costs from all pre-compaction messages
        providerMetadata:
          metadata && "providerMetadata" in metadata
            ? (metadata.providerMetadata as Record<string, unknown> | undefined)
            : undefined,
        duration: metadata?.duration,
        systemMessageTokens:
          metadata && "systemMessageTokens" in metadata
            ? (metadata.systemMessageTokens as number | undefined)
            : undefined,
        // Store continueMessage in summary so it survives history replacement
        muxMetadata: continueMessage
          ? { type: "compaction-result", continueMessage, requestId: compactRequestMsg?.id }
          : { type: "normal" },
      }
    );

    void (async () => {
      try {
        await window.api.workspace.replaceChatHistory(workspaceId, summaryMessage);
      } catch (error) {
        console.error("[WorkspaceStore] Failed to replace history:", error);
      } finally {
        this.states.bump(workspaceId);
        this.checkAndBumpRecencyIfChanged();
      }
    })();
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
    const unsubscribe = window.api.workspace.onChat(workspaceId, (data: WorkspaceChatMessage) => {
      queueMicrotask(() => {
        this.handleChatMessage(workspaceId, data);
      });
    });

    this.ipcUnsubscribers.set(workspaceId, unsubscribe);
  }

  /**
   * Remove a workspace and clean up subscriptions.
   */
  removeWorkspace(workspaceId: string): void {
    // Clean up consumer manager state
    this.consumerManager.removeWorkspace(workspaceId);

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
      // Create new aggregator with required createdAt
      this.aggregators.set(workspaceId, new StreamingMessageAggregator(createdAt));
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
 */
export function useWorkspaceRecency(): Record<string, number> {
  const store = getStoreInstance();

  return useSyncExternalStore(store.subscribe, () => store.getWorkspaceRecency());
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
export function useWorkspaceAggregator(workspaceId: string) {
  const store = useWorkspaceStoreRaw();
  return store.getAggregator(workspaceId);
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
