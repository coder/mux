import type { FilePart, SendMessageOptions } from "@/common/orpc/types";
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

// Type guard for metadata with reviews
interface MetadataWithReviews {
  reviews?: ReviewNoteData[];
}

function hasReviews(meta: unknown): meta is MetadataWithReviews {
  if (typeof meta !== "object" || meta === null) return false;
  const obj = meta as Record<string, unknown>;
  return Array.isArray(obj.reviews);
}

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
}

export class MessageQueue {
  private messages: string[] = [];
  private firstMuxMetadata?: unknown;
  private latestOptions?: SendMessageOptions;
  private accumulatedFileParts: FilePart[] = [];
  private dedupeKeys: Set<string> = new Set<string>();
  private queuedEntryCount = 0;
  private queuedSyntheticCount = 0;

  /**
   * Check if the queue currently contains a compaction request.
   */
  hasCompactionRequest(): boolean {
    return isCompactionMetadata(this.firstMuxMetadata);
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
  ): void {
    this.addInternal(message, options, internal);
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
    const queueHasMessages = !this.isEmpty();
    const queueHasAgentSkill = isAgentSkillMetadata(this.firstMuxMetadata);

    // Avoid leaking agent-skill metadata to later queued messages.
    // A skill invocation must be sent alone (or the user should restore/edit the queued message).
    if (queueHasAgentSkill) {
      throw new Error(
        "Cannot queue additional messages: an agent skill invocation is already queued. " +
          "Wait for the current stream to complete before sending another message."
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

    this.queuedEntryCount += 1;
    if (internal?.synthetic === true) {
      this.queuedSyntheticCount += 1;
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
      ? {
          ...this.latestOptions,
          muxMetadata,
          fileParts: this.accumulatedFileParts.length > 0 ? this.accumulatedFileParts : undefined,
        }
      : undefined;

    const allQueuedEntriesAreSynthetic =
      this.queuedEntryCount > 0 && this.queuedSyntheticCount === this.queuedEntryCount;
    const internal = allQueuedEntriesAreSynthetic ? { synthetic: true } : undefined;

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
    this.queuedEntryCount = 0;
    this.queuedSyntheticCount = 0;
  }

  /**
   * Check if queue is empty (no messages AND no images).
   */
  isEmpty(): boolean {
    return this.messages.length === 0 && this.accumulatedFileParts.length === 0;
  }
}
