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

// Workspace-turn task metadata must stay attached to exactly one queued message;
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

/**
 * Queue for messages sent during active streaming.
 *
 * Stores:
 * - Message texts (accumulated)
 * - First muxMetadata (preserved - never overwritten by subsequent adds)
 * - Latest options (model, etc. - updated on each add)
 * - File parts (accumulated across all messages)
 *
 * IMPORTANT:
 * - Compaction requests must preserve their muxMetadata even when follow-up messages are queued.
 * - Agent-skill invocations cannot be batched with other messages; otherwise the skill metadata would
 *   “leak” onto later queued sends.
 *
 * Display logic:
 * - Single compaction request → shows rawCommand (/compact)
 * - Single agent-skill invocation → shows rawCommand (/{skill})
 * - Multiple messages → shows all actual message texts
 */
interface QueuedMessageInternalOptions {
  synthetic?: boolean;
  agentInitiated?: boolean;
  onAccepted?: () => Promise<void> | void;
  onAcceptedPreStreamFailure?: (error: SendMessageError) => Promise<void> | void;
  onCanceled?: (reason: string) => Promise<void> | void;
}

export class MessageQueue {
  private messages: string[] = [];
  private firstMuxMetadata?: unknown;
  private latestOptions?: SendMessageOptions;
  private accumulatedFileParts: FilePart[] = [];
  private dedupeKeys: Set<string> = new Set<string>();
  private goalInterventionPolicy?: GoalInterventionPolicy;
  private queueDispatchMode: QueueDispatchMode = "tool-end";
  private queuedEntryCount = 0;
  private queuedSyntheticCount = 0;
  private queuedAgentInitiatedCount = 0;
  private onCanceled?: (reason: string) => Promise<void> | void;
  private onAccepted?: () => Promise<void> | void;
  private onAcceptedPreStreamFailure?: (error: SendMessageError) => Promise<void> | void;

  /**
   * Check if the queue currently contains a compaction request.
   */
  hasCompactionRequest(): boolean {
    return isCompactionMetadata(this.firstMuxMetadata);
  }

  hasWorkspaceTurn(handleId: string): boolean {
    return (
      handleId.length > 0 &&
      isWorkspaceTurnMetadata(this.firstMuxMetadata) &&
      this.firstMuxMetadata.taskHandleId === handleId
    );
  }

  getQueueDispatchMode(): QueueDispatchMode {
    return this.queueDispatchMode;
  }

  /**
   * Add a message to the queue.
   * Preserves muxMetadata from first message, updates other options.
   * Accumulates file parts.
   *
   * @throws Error if trying to add a compaction request when queue already has messages
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
   * Keys reset when the queue is cleared (drain or user clear).
   */
  hasDedupeKey(dedupeKey: string): boolean {
    return this.dedupeKeys.has(dedupeKey);
  }

  /**
   * Whether the queue's only content is the single entry queued under this dedupe key.
   * Used to supersede low-value scheduled entries (heartbeats): a later real message must
   * not batch behind them, because batching would adopt the first entry's muxMetadata.
   */
  holdsOnlyDedupeKey(dedupeKey: string): boolean {
    return this.queuedEntryCount === 1 && this.dedupeKeys.has(dedupeKey);
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
    if (dedupeKey !== undefined && this.dedupeKeys.has(dedupeKey)) {
      return false;
    }

    const didAdd = this.addInternal(message, options, internal);
    if (didAdd && dedupeKey !== undefined) {
      this.dedupeKeys.add(dedupeKey);
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

    const incomingIsCompaction = isCompactionMetadata(options?.muxMetadata);
    const incomingIsAgentSkill = isAgentSkillMetadata(options?.muxMetadata);
    const incomingIsWorkspaceTurn = isWorkspaceTurnMetadata(options?.muxMetadata);
    const incomingHasAcceptedCallbacks =
      internal?.onAccepted != null ||
      internal?.onAcceptedPreStreamFailure != null ||
      internal?.onCanceled != null;
    const queueHasMessages = !this.isEmpty();
    const incomingMode = options?.queueDispatchMode ?? "tool-end";
    const nextQueueDispatchMode = !queueHasMessages
      ? incomingMode
      : incomingMode === "tool-end"
        ? "tool-end"
        : this.queueDispatchMode;

    const queueHasAgentSkill = isAgentSkillMetadata(this.firstMuxMetadata);
    const queueHasWorkspaceTurn = isWorkspaceTurnMetadata(this.firstMuxMetadata);
    const queueHasAcceptedCallbacks =
      this.onAccepted != null || this.onAcceptedPreStreamFailure != null || this.onCanceled != null;

    // Avoid leaking agent-skill metadata to later queued messages.
    // A skill invocation must be sent alone (or the user should restore/edit the queued message).
    if (queueHasAgentSkill) {
      throw new Error(
        "Cannot queue additional messages: an agent skill invocation is already queued. " +
          "Wait for the current stream to complete before sending another message."
      );
    }

    if (queueHasWorkspaceTurn) {
      throw new Error(
        "Cannot queue additional messages: a workspace turn follow-up is already queued. " +
          "Wait for it to dispatch before sending another message."
      );
    }
    if (queueHasAcceptedCallbacks) {
      throw new Error(
        "Cannot queue additional messages: an internal workspace turn follow-up is already queued. " +
          "Wait for it to dispatch before sending another message."
      );
    }

    if (incomingHasAcceptedCallbacks && queueHasMessages) {
      throw new Error(
        "Cannot queue workspace turn follow-up: queue already has messages. " +
          "Wait for the current stream to complete before sending another workspace turn."
      );
    }

    // Cannot add compaction to a queue that already has messages
    // (user should wait for those messages to send first)
    if (incomingIsCompaction && queueHasMessages) {
      throw new Error(
        "Cannot queue compaction request: queue already has messages. " +
          "Wait for current stream to complete before compacting."
      );
    }

    // Cannot batch agent-skill metadata with other messages (it would apply to the whole batch).
    if (incomingIsAgentSkill && queueHasMessages) {
      throw new Error(
        "Cannot queue agent skill invocation: queue already has messages. " +
          "Wait for the current stream to complete before running a skill."
      );
    }
    if (incomingIsWorkspaceTurn && queueHasMessages) {
      throw new Error(
        "Cannot queue workspace turn follow-up: queue already has messages. " +
          "Wait for the current stream to complete before sending another workspace turn."
      );
    }

    const nextGoalInterventionPolicy =
      this.goalInterventionPolicy === "pause" || options?.goalInterventionPolicy === "pause"
        ? "pause"
        : (options?.goalInterventionPolicy ?? this.goalInterventionPolicy);

    // Commit dispatch mode only after validation checks pass
    this.queueDispatchMode = nextQueueDispatchMode;

    this.goalInterventionPolicy = nextGoalInterventionPolicy;

    // Add text message if non-empty
    if (trimmedMessage.length > 0) {
      this.messages.push(trimmedMessage);
    }

    if (options) {
      const { fileParts, ...restOptions } = options;

      // Preserve first muxMetadata (see class docblock for rationale)
      if (options.muxMetadata !== undefined && this.firstMuxMetadata === undefined) {
        this.firstMuxMetadata = options.muxMetadata;
      }
      this.latestOptions = restOptions;

      if (fileParts && fileParts.length > 0) {
        this.accumulatedFileParts.push(...fileParts);
      }
    }
    if (internal?.onCanceled != null) {
      this.onCanceled = internal.onCanceled;
    }
    if (internal?.onAccepted != null) {
      this.onAccepted = internal.onAccepted;
    }
    if (internal?.onAcceptedPreStreamFailure != null) {
      this.onAcceptedPreStreamFailure = internal.onAcceptedPreStreamFailure;
    }

    this.queuedEntryCount += 1;
    if (internal?.synthetic === true) {
      this.queuedSyntheticCount += 1;
    }
    if (internal?.agentInitiated === true) {
      this.queuedAgentInitiatedCount += 1;
    }

    return true;
  }

  /**
   * Get all queued message texts (for editing/restoration).
   */
  getMessages(): string[] {
    return [...this.messages];
  }

  /**
   * Get display text for queued messages.
   * - Single compaction request shows rawCommand (/compact)
   * - Single agent-skill invocation shows rawCommand (/{skill})
   * - Multiple messages show all actual message texts
   */
  getDisplayText(): string {
    // Only show rawCommand for single compaction request
    if (this.messages.length === 1 && isCompactionMetadata(this.firstMuxMetadata)) {
      return this.firstMuxMetadata.rawCommand;
    }

    // Only show rawCommand for a single agent-skill invocation.
    // (Batching agent-skill with other messages is disallowed.)
    if (this.messages.length <= 1 && isAgentSkillMetadata(this.firstMuxMetadata)) {
      return this.firstMuxMetadata.rawCommand;
    }

    return this.messages.join("\n");
  }

  /**
   * Get accumulated file parts for display.
   */
  getFileParts(): FilePart[] {
    return [...this.accumulatedFileParts];
  }

  /**
   * Get reviews from metadata for display.
   */
  getReviews(): ReviewNoteData[] | undefined {
    if (hasReviews(this.firstMuxMetadata) && this.firstMuxMetadata.reviews?.length) {
      return this.firstMuxMetadata.reviews;
    }
    return undefined;
  }

  getClearCallbacks(): Pick<
    QueuedMessageInternalOptions,
    "onCanceled" | "onAcceptedPreStreamFailure"
  > {
    return {
      ...(this.onCanceled != null ? { onCanceled: this.onCanceled } : {}),
      ...(this.onAcceptedPreStreamFailure != null
        ? { onAcceptedPreStreamFailure: this.onAcceptedPreStreamFailure }
        : {}),
    };
  }

  /**
   * Get combined message and options for sending.
   */
  produceMessage(): {
    message: string;
    options?: SendMessageOptions & { fileParts?: FilePart[] };
    internal?: QueuedMessageInternalOptions;
  } {
    const joinedMessages = this.messages.join("\n");
    // First metadata takes precedence (preserves compaction + agent-skill invocations)
    const muxMetadata =
      this.firstMuxMetadata !== undefined
        ? this.firstMuxMetadata
        : (this.latestOptions?.muxMetadata as unknown);
    const options = this.latestOptions
      ? (() => {
          const restOptions: SendMessageOptions = { ...this.latestOptions };
          delete restOptions.queueDispatchMode;
          if (this.goalInterventionPolicy != null) {
            restOptions.goalInterventionPolicy = this.goalInterventionPolicy;
          }
          return {
            ...restOptions,
            muxMetadata,
            fileParts: this.accumulatedFileParts.length > 0 ? this.accumulatedFileParts : undefined,
          };
        })()
      : undefined;

    const allQueuedEntriesAreSynthetic =
      this.queuedEntryCount > 0 && this.queuedSyntheticCount === this.queuedEntryCount;
    const allQueuedEntriesAreAgentInitiated =
      this.queuedEntryCount > 0 && this.queuedAgentInitiatedCount === this.queuedEntryCount;
    const hasInternalOptions =
      allQueuedEntriesAreSynthetic ||
      allQueuedEntriesAreAgentInitiated ||
      this.onAccepted != null ||
      this.onAcceptedPreStreamFailure != null ||
      this.onCanceled != null;
    const internal = hasInternalOptions
      ? {
          ...(allQueuedEntriesAreSynthetic ? { synthetic: true } : {}),
          ...(allQueuedEntriesAreAgentInitiated ? { agentInitiated: true } : {}),
          ...(this.onCanceled != null ? { onCanceled: this.onCanceled } : {}),
          ...(this.onAccepted != null ? { onAccepted: this.onAccepted } : {}),
          ...(this.onAcceptedPreStreamFailure != null
            ? { onAcceptedPreStreamFailure: this.onAcceptedPreStreamFailure }
            : {}),
        }
      : undefined;

    return { message: joinedMessages, options, internal };
  }

  /**
   * Clear all queued messages, options, and images.
   */
  clear(): void {
    this.messages = [];
    this.firstMuxMetadata = undefined;
    this.latestOptions = undefined;
    this.accumulatedFileParts = [];
    this.dedupeKeys.clear();
    this.goalInterventionPolicy = undefined;
    this.queueDispatchMode = "tool-end";
    this.onCanceled = undefined;
    this.onAccepted = undefined;
    this.onAcceptedPreStreamFailure = undefined;
    this.queuedEntryCount = 0;
    this.queuedSyntheticCount = 0;
    this.queuedAgentInitiatedCount = 0;
  }

  /**
   * Check if queue is empty (no messages AND no images).
   */
  isEmpty(): boolean {
    return this.messages.length === 0 && this.accumulatedFileParts.length === 0;
  }
}
