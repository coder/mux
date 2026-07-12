import type { FilePart, SendMessageOptions } from "@/common/orpc/types";
import type { SendMessageError } from "@/common/types/errors";
import type { ReviewNoteData } from "@/common/types/review";

// Type guard for compaction request metadata (for display text)
interface CompactionMetadata {
  type: "compaction-request";
  rawCommand: string;
}

// Type guard for agent skill metadata (for display + batching constraints)
interface AgentSkillMetadata {
  type: "agent-skill";
  rawCommand: string;
  skillName: string;
  scope: "project" | "global" | "built-in";
}

function isAgentSkillMetadata(meta: unknown): meta is AgentSkillMetadata {
  if (typeof meta !== "object" || meta === null) return false;
  const obj = meta as Record<string, unknown>;
  if (obj.type !== "agent-skill") return false;
  if (typeof obj.rawCommand !== "string") return false;
  if (typeof obj.skillName !== "string") return false;
  if (obj.scope !== "project" && obj.scope !== "global" && obj.scope !== "built-in") return false;
  return true;
}

function isCompactionMetadata(meta: unknown): meta is CompactionMetadata {
  if (typeof meta !== "object" || meta === null) return false;
  const obj = meta as Record<string, unknown>;
  return obj.type === "compaction-request" && typeof obj.rawCommand === "string";
}

// Workspace-turn task metadata must stay attached to exactly one queued entry;
// otherwise a batched follow-up would leave one durable task handle with no matching stream-end.
interface WorkspaceTurnMetadata {
  type: "workspace-turn-task";
  taskHandleId: string;
  ownerWorkspaceId: string;
  turnId: string;
}

function isWorkspaceTurnMetadata(meta: unknown): meta is WorkspaceTurnMetadata {
  if (typeof meta !== "object" || meta === null) return false;
  const obj = meta as Record<string, unknown>;
  return (
    obj.type === "workspace-turn-task" &&
    typeof obj.taskHandleId === "string" &&
    typeof obj.ownerWorkspaceId === "string" &&
    typeof obj.turnId === "string"
  );
}

// Type guard for metadata with reviews
interface MetadataWithReviews {
  reviews?: ReviewNoteData[];
}

function hasReviews(meta: unknown): meta is MetadataWithReviews {
  if (typeof meta !== "object" || meta === null) return false;
  const obj = meta as Record<string, unknown>;
  return Array.isArray(obj.reviews);
}

type GoalInterventionPolicy = NonNullable<SendMessageOptions["goalInterventionPolicy"]>;

// Derive from the Zod schema (SendMessageOptions) to stay in sync automatically.
type QueueDispatchMode = NonNullable<SendMessageOptions["queueDispatchMode"]>;

interface QueuedMessageInternalOptions {
  synthetic?: boolean;
  agentInitiated?: boolean;
  /** Keep this queued add isolated so its dedupe key can be removed without affecting siblings. */
  sealed?: boolean;
  /** Dedupe-keyed maintenance sends are removable by prefix without changing global queue rules. */
  removableDedupeKey?: boolean;
  onAccepted?: () => Promise<void> | void;
  onAcceptedPreStreamFailure?: (error: SendMessageError) => Promise<void> | void;
  onCanceled?: (reason: string) => Promise<void> | void;
}

type QueueClearCallbacks = Pick<
  QueuedMessageInternalOptions,
  "onCanceled" | "onAcceptedPreStreamFailure"
>;

/**
 * One dispatchable unit in the queue. Plain follow-up messages batch into a single
 * entry (joined text, accumulated file parts); "special" sends (compaction requests,
 * agent-skill invocations, workspace-turn follow-ups, callback-carrying internal
 * sends) always start their own entry so their metadata/callbacks stay attached to
 * exactly one dispatch.
 */
interface QueueEntry {
  messages: string[];
  /** First muxMetadata added to this entry (never overwritten by later batched adds). */
  muxMetadata?: unknown;
  latestOptions?: SendMessageOptions;
  fileParts: FilePart[];
  /** Dedupe keys registered by addOnce for adds that landed in this entry. */
  dedupeKeys: Set<string>;
  goalInterventionPolicy?: GoalInterventionPolicy;
  dispatchMode: QueueDispatchMode;
  /**
   * Sealed entries never accept later batched messages: their callbacks/metadata
   * correlate to exactly one turn (workspace-turn follow-ups, agent skills).
   * Later messages queue as a new entry behind them instead.
   */
  sealed: boolean;
  /** User-originated entries are the only ones exposed to/restored into the composer. */
  userAuthored: boolean;
  addCount: number;
  syntheticCount: number;
  agentInitiatedCount: number;
  onCanceled?: (reason: string) => Promise<void> | void;
  onAccepted?: () => Promise<void> | void;
  onAcceptedPreStreamFailure?: (error: SendMessageError) => Promise<void> | void;
}

/**
 * FIFO queue of messages sent during active streaming.
 *
 * The queue holds ordered entries that dispatch one at a time (see dequeueNext):
 * - Plain messages batch into the newest open entry (texts joined, file parts
 *   accumulated, first muxMetadata preserved, latest options win).
 * - Compaction requests, agent-skill invocations, workspace-turn follow-ups, and
 *   callback-carrying internal sends each start their own entry, so queueing one
 *   never blocks later sends — they simply dispatch after it (no enqueue errors).
 * - Agent-skill / workspace-turn / callback entries are sealed: later messages
 *   start a new entry instead of adopting their metadata or callbacks.
 * - User-authored and background/agent-initiated messages never share an entry,
 *   so renderer/restoration projections can omit background work precisely.
 * - Compaction entries stay open: a follow-up typed behind a pending /compact
 *   batches under the compaction request (long-standing behavior).
 *
 * Display logic:
 * - A single-message compaction or agent-skill entry shows its rawCommand
 *   (e.g. /compact, /{skill}); otherwise entries show their actual message texts.
 */
export class MessageQueue {
  private entries: QueueEntry[] = [];

  /**
   * Check if the queue currently contains a compaction request.
   */
  hasCompactionRequest(): boolean {
    return this.entries.some((entry) => isCompactionMetadata(entry.muxMetadata));
  }

  hasWorkspaceTurn(handleId: string): boolean {
    return (
      handleId.length > 0 &&
      this.entries.some(
        (entry) =>
          isWorkspaceTurnMetadata(entry.muxMetadata) && entry.muxMetadata.taskHandleId === handleId
      )
    );
  }

  private getDispatchMode(entries: readonly QueueEntry[]): QueueDispatchMode {
    if (entries.length === 0) {
      return "tool-end";
    }
    return entries.some((entry) => entry.dispatchMode === "tool-end") ? "tool-end" : "turn-end";
  }

  /**
   * Effective dispatch mode across pending entries: any entry queued for tool-end
   * makes the whole queue dispatch at tool-end (sticky, matching pre-entry behavior),
   * otherwise turn-end. Empty queue reports the tool-end default.
   */
  getQueueDispatchMode(): QueueDispatchMode {
    return this.getDispatchMode(this.entries);
  }

  /**
   * Dispatch mode for user-visible entries only. Backend-initiated maintenance/wake
   * messages should not change the queue badge shown beside the user's own follow-up.
   */
  getVisibleQueueDispatchMode(): QueueDispatchMode {
    return this.getDispatchMode(this.getVisibleEntries());
  }

  /**
   * Add a message to the queue. Plain messages batch into the newest open entry;
   * special sends start their own entry (see class docblock). Never throws.
   */
  add(
    message: string,
    options?: SendMessageOptions & { fileParts?: FilePart[] },
    internal?: QueuedMessageInternalOptions
  ): boolean {
    return this.addInternal(message, options, internal);
  }

  /**
   * Whether a message queued via {@link addOnce} with this dedupe key is still pending.
   * Keys release when their entry dispatches or the queue is cleared.
   */
  hasDedupeKey(dedupeKey: string): boolean {
    return this.entries.some((entry) => entry.dedupeKeys.has(dedupeKey));
  }

  /**
   * Whether the queue's only content is the single message queued under this dedupe key.
   * Used to supersede low-value scheduled entries (heartbeats): a later real message must
   * not batch behind them, because batching would adopt the first entry's muxMetadata.
   */
  holdsOnlyDedupeKey(dedupeKey: string): boolean {
    return (
      this.entries.length === 1 &&
      this.entries[0].addCount === 1 &&
      this.entries[0].dedupeKeys.has(dedupeKey)
    );
  }

  /**
   * Add a message to the queue once, keyed by dedupeKey.
   * Returns true if the message was queued.
   */
  addOnce(
    message: string,
    options?: SendMessageOptions & { fileParts?: FilePart[] },
    dedupeKey?: string,
    internal?: QueuedMessageInternalOptions
  ): boolean {
    if (dedupeKey !== undefined && this.hasDedupeKey(dedupeKey)) {
      return false;
    }

    const didAdd = this.addInternal(message, options, internal);
    if (didAdd && dedupeKey !== undefined) {
      this.entries[this.entries.length - 1].dedupeKeys.add(dedupeKey);
    }
    return didAdd;
  }

  private addInternal(
    message: string,
    options?: SendMessageOptions & { fileParts?: FilePart[] },
    internal?: QueuedMessageInternalOptions
  ): boolean {
    const trimmedMessage = message.trim();
    const hasFiles = options?.fileParts && options.fileParts.length > 0;

    // Reject if both text and file parts are empty
    if (trimmedMessage.length === 0 && !hasFiles) {
      return false;
    }

    const incomingHasAcceptedCallbacks =
      internal?.onAccepted != null ||
      internal?.onAcceptedPreStreamFailure != null ||
      internal?.onCanceled != null;
    const incomingIsUserAuthored =
      internal?.synthetic !== true && internal?.agentInitiated !== true;
    // Sealed entries must own their turn end-to-end: workspace-turn metadata and
    // internal callbacks correlate to exactly one dispatch, and agent-skill metadata
    // must not leak onto batched follow-ups.
    const incomingIsSealed =
      internal?.sealed === true ||
      internal?.removableDedupeKey === true ||
      isAgentSkillMetadata(options?.muxMetadata) ||
      isWorkspaceTurnMetadata(options?.muxMetadata) ||
      incomingHasAcceptedCallbacks;
    // Compaction starts its own entry (its metadata must not adopt earlier batched
    // texts), but stays open so a follow-up typed behind a pending /compact batches
    // under the compaction request, preserving long-standing behavior.
    const incomingStartsNewEntry = incomingIsSealed || isCompactionMetadata(options?.muxMetadata);
    const incomingMode = options?.queueDispatchMode ?? "tool-end";

    const tail = this.entries[this.entries.length - 1];
    let entry: QueueEntry;
    if (
      tail !== undefined &&
      !tail.sealed &&
      !incomingStartsNewEntry &&
      tail.userAuthored === incomingIsUserAuthored
    ) {
      entry = tail;
      // tool-end is sticky within an entry; turn-end never downgrades an entry
      // that something already queued for tool-end dispatch.
      if (incomingMode === "tool-end") {
        entry.dispatchMode = "tool-end";
      }
    } else {
      entry = {
        messages: [],
        fileParts: [],
        dedupeKeys: new Set<string>(),
        dispatchMode: incomingMode,
        sealed: incomingIsSealed,
        userAuthored: incomingIsUserAuthored,
        addCount: 0,
        syntheticCount: 0,
        agentInitiatedCount: 0,
      };
      this.entries.push(entry);
    }

    // Explicit pause is sticky within an entry (a batched steer must not unpause).
    entry.goalInterventionPolicy =
      entry.goalInterventionPolicy === "pause" || options?.goalInterventionPolicy === "pause"
        ? "pause"
        : (options?.goalInterventionPolicy ?? entry.goalInterventionPolicy);

    // Add text message if non-empty
    if (trimmedMessage.length > 0) {
      entry.messages.push(trimmedMessage);
    }

    if (options) {
      const { fileParts, ...restOptions } = options;

      // Preserve first muxMetadata per entry (see class docblock for rationale)
      if (options.muxMetadata !== undefined && entry.muxMetadata === undefined) {
        entry.muxMetadata = options.muxMetadata;
      }
      entry.latestOptions = restOptions;

      if (fileParts && fileParts.length > 0) {
        entry.fileParts.push(...fileParts);
      }
    }
    if (internal?.onCanceled != null) {
      entry.onCanceled = internal.onCanceled;
    }
    if (internal?.onAccepted != null) {
      entry.onAccepted = internal.onAccepted;
    }
    if (internal?.onAcceptedPreStreamFailure != null) {
      entry.onAcceptedPreStreamFailure = internal.onAcceptedPreStreamFailure;
    }

    entry.addCount += 1;
    if (internal?.synthetic === true) {
      entry.syntheticCount += 1;
    }
    if (internal?.agentInitiated === true) {
      entry.agentInitiatedCount += 1;
    }

    return true;
  }

  /**
   * Entries containing user-originated input. Fully synthetic entries (background
   * monitor wakes, scheduled maintenance, internal follow-ups) remain dispatchable
   * but must not appear in or restore over the user's composer.
   */
  private getVisibleEntries(): QueueEntry[] {
    return this.entries.filter((entry) => entry.userAuthored);
  }

  private getMessagesForEntries(entries: readonly QueueEntry[]): string[] {
    return entries.flatMap((entry) => entry.messages);
  }

  private getDisplayTextForEntries(entries: readonly QueueEntry[]): string {
    return entries
      .map((entry) => {
        if (
          entry.messages.length <= 1 &&
          (isCompactionMetadata(entry.muxMetadata) || isAgentSkillMetadata(entry.muxMetadata))
        ) {
          return entry.muxMetadata.rawCommand;
        }
        return entry.messages.join("\n");
      })
      .filter((text) => text.length > 0)
      .join("\n");
  }

  private getFilePartsForEntries(entries: readonly QueueEntry[]): FilePart[] {
    return entries.flatMap((entry) => entry.fileParts);
  }

  private getReviewsForEntries(entries: readonly QueueEntry[]): ReviewNoteData[] | undefined {
    const reviews = entries.flatMap((entry) =>
      hasReviews(entry.muxMetadata) ? (entry.muxMetadata.reviews ?? []) : []
    );
    return reviews.length > 0 ? reviews : undefined;
  }

  /** Get all queued message texts across entries (including synthetic entries). */
  getMessages(): string[] {
    return this.getMessagesForEntries(this.entries);
  }

  /** Get user-visible queued message texts for the renderer/composer. */
  getVisibleMessages(): string[] {
    return this.getMessagesForEntries(this.getVisibleEntries());
  }

  /**
   * Get display text for queued messages.
   * - A single-message compaction/agent-skill entry shows its rawCommand (/compact, /{skill})
   * - Otherwise entries show their actual message texts, joined with newlines
   */
  getDisplayText(): string {
    return this.getDisplayTextForEntries(this.entries);
  }

  /** Get display text for user-visible entries only. */
  getVisibleDisplayText(): string {
    return this.getDisplayTextForEntries(this.getVisibleEntries());
  }

  /** Get accumulated file parts across all entries. */
  getFileParts(): FilePart[] {
    return this.getFilePartsForEntries(this.entries);
  }

  /** Get accumulated file parts for user-visible entries only. */
  getVisibleFileParts(): FilePart[] {
    return this.getFilePartsForEntries(this.getVisibleEntries());
  }

  /** Get reviews across all entries' metadata. */
  getReviews(): ReviewNoteData[] | undefined {
    return this.getReviewsForEntries(this.entries);
  }

  /** Get reviews across user-visible entries' metadata only. */
  getVisibleReviews(): ReviewNoteData[] | undefined {
    return this.getReviewsForEntries(this.getVisibleEntries());
  }

  /** Whether a user-visible queued entry is a compaction request. */
  hasVisibleCompactionRequest(): boolean {
    return this.getVisibleEntries().some((entry) => isCompactionMetadata(entry.muxMetadata));
  }

  /**
   * Cancellation callbacks for every pending entry, in queue order.
   * Callers must notify each one when clearing the queue.
   */
  getClearCallbacks(): QueueClearCallbacks[] {
    return this.entries
      .filter((entry) => entry.onCanceled != null || entry.onAcceptedPreStreamFailure != null)
      .map((entry) => ({
        ...(entry.onCanceled != null ? { onCanceled: entry.onCanceled } : {}),
        ...(entry.onAcceptedPreStreamFailure != null
          ? { onAcceptedPreStreamFailure: entry.onAcceptedPreStreamFailure }
          : {}),
      }));
  }

  /**
   * Remove only the entry pinned to this workspace-turn handle, leaving unrelated
   * queued messages intact (interrupting a queued turn must not drop user input).
   * Returns the removed entry's cancellation callbacks, or null when no entry matches.
   */
  removeWorkspaceTurn(handleId: string): QueueClearCallbacks | null {
    if (handleId.length === 0) {
      return null;
    }
    const index = this.entries.findIndex(
      (entry) =>
        isWorkspaceTurnMetadata(entry.muxMetadata) && entry.muxMetadata.taskHandleId === handleId
    );
    if (index === -1) {
      return null;
    }
    const [entry] = this.entries.splice(index, 1);
    return {
      ...(entry.onCanceled != null ? { onCanceled: entry.onCanceled } : {}),
      ...(entry.onAcceptedPreStreamFailure != null
        ? { onAcceptedPreStreamFailure: entry.onAcceptedPreStreamFailure }
        : {}),
    };
  }

  /** Remove queued entries carrying a dedupe key with the given prefix. */
  removeByDedupeKeyPrefix(prefix: string): {
    removedCount: number;
    callbacks: QueueClearCallbacks[];
  } {
    if (prefix.length === 0) {
      return { removedCount: 0, callbacks: [] };
    }
    let removedCount = 0;
    const removedCallbacks: QueueClearCallbacks[] = [];
    this.entries = this.entries.flatMap((entry) => {
      const matchingKeys = [...entry.dedupeKeys].filter((dedupeKey) =>
        dedupeKey.startsWith(prefix)
      );
      if (matchingKeys.length === 0) {
        return [entry];
      }
      removedCount += matchingKeys.length;
      // Dedupe-keyed progress sends are agent-initiated and therefore isolated from user entries,
      // but multiple progress sends can still batch together. Remove only the matched messages and
      // preserve unrelated keys/messages that share the same entry.
      const matchingKeySet = new Set(matchingKeys);
      const keptMessages = entry.messages.filter((_message, index) => {
        const key = [...entry.dedupeKeys][index];
        return key == null || !matchingKeySet.has(key);
      });
      if (keptMessages.length > 0) {
        entry.messages = keptMessages;
        for (const key of matchingKeys) {
          entry.dedupeKeys.delete(key);
        }
        entry.addCount -= matchingKeys.length;
        entry.syntheticCount = Math.min(entry.syntheticCount, entry.addCount);
        entry.agentInitiatedCount = Math.min(entry.agentInitiatedCount, entry.addCount);
        return [entry];
      }
      if (entry.onCanceled != null || entry.onAcceptedPreStreamFailure != null) {
        removedCallbacks.push({
          ...(entry.onCanceled != null ? { onCanceled: entry.onCanceled } : {}),
          ...(entry.onAcceptedPreStreamFailure != null
            ? { onAcceptedPreStreamFailure: entry.onAcceptedPreStreamFailure }
            : {}),
        });
      }
      return [];
    });
    return { removedCount, callbacks: removedCallbacks };
  }

  /**
   * Move the oldest user-authored entry to the head so an explicit user "Send now"
   * action cannot be blocked by hidden synthetic/background work queued before it.
   * Returns false when no user-authored entry is pending.
   */
  prioritizeNextUserEntry(): boolean {
    const index = this.entries.findIndex((entry) => entry.userAuthored);
    if (index === -1) {
      return false;
    }
    if (index > 0) {
      const [entry] = this.entries.splice(index, 1);
      this.entries.unshift(entry);
    }
    return true;
  }

  /**
   * Remove the first entry and return its combined message and options for sending.
   * Later entries stay queued and dispatch on subsequent drains (FIFO).
   * Caller must check {@link isEmpty} first.
   */
  dequeueNext(): {
    message: string;
    options?: SendMessageOptions & { fileParts?: FilePart[] };
    internal?: QueuedMessageInternalOptions;
  } {
    const entry = this.entries.shift();
    if (entry === undefined) {
      return { message: "" };
    }

    const joinedMessages = entry.messages.join("\n");
    const options = entry.latestOptions
      ? (() => {
          const restOptions: SendMessageOptions = { ...entry.latestOptions };
          delete restOptions.queueDispatchMode;
          if (entry.goalInterventionPolicy != null) {
            restOptions.goalInterventionPolicy = entry.goalInterventionPolicy;
          }
          return {
            ...restOptions,
            // First metadata takes precedence (preserves compaction + agent-skill invocations)
            muxMetadata: entry.muxMetadata,
            fileParts: entry.fileParts.length > 0 ? entry.fileParts : undefined,
          };
        })()
      : undefined;

    const allAddsAreSynthetic = entry.addCount > 0 && entry.syntheticCount === entry.addCount;
    const allAddsAreAgentInitiated =
      entry.addCount > 0 && entry.agentInitiatedCount === entry.addCount;
    const hasInternalOptions =
      allAddsAreSynthetic ||
      allAddsAreAgentInitiated ||
      entry.onAccepted != null ||
      entry.onAcceptedPreStreamFailure != null ||
      entry.onCanceled != null;
    const internal = hasInternalOptions
      ? {
          ...(allAddsAreSynthetic ? { synthetic: true } : {}),
          ...(allAddsAreAgentInitiated ? { agentInitiated: true } : {}),
          ...(entry.onCanceled != null ? { onCanceled: entry.onCanceled } : {}),
          ...(entry.onAccepted != null ? { onAccepted: entry.onAccepted } : {}),
          ...(entry.onAcceptedPreStreamFailure != null
            ? { onAcceptedPreStreamFailure: entry.onAcceptedPreStreamFailure }
            : {}),
        }
      : undefined;

    return { message: joinedMessages, options, internal };
  }

  /**
   * Clear all queued entries. Callers that need to notify canceled entries must
   * capture {@link getClearCallbacks} beforehand.
   */
  clear(): void {
    this.entries = [];
  }

  /**
   * Check if queue is empty (no pending entries).
   */
  isEmpty(): boolean {
    return this.entries.length === 0;
  }
}
