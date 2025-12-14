import type { ImagePart, SendMessageOptions } from "@/common/orpc/types";
import type { ReviewNoteData } from "@/common/types/review";

// Type guard for compaction request metadata (for display text)
interface CompactionMetadata {
  type: "compaction-request";
  rawCommand: string;
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
 * - Image parts (accumulated across all messages)
 *
 * IMPORTANT: muxMetadata from the first message is preserved even when
 * subsequent messages are added. This prevents compaction requests from
 * losing their metadata when follow-up messages are queued.
 *
 * Display logic:
 * - Single compaction request → shows rawCommand (/compact)
 * - Multiple messages → shows all actual message texts
 */
export class MessageQueue {
  private messages: string[] = [];
  private firstMuxMetadata?: unknown;
  private latestOptions?: SendMessageOptions;
  private accumulatedImages: ImagePart[] = [];

  /**
   * Check if the queue currently contains a compaction request.
   */
  hasCompactionRequest(): boolean {
    return isCompactionMetadata(this.firstMuxMetadata);
  }

  /**
   * Add a message to the queue.
   * Preserves muxMetadata from first message, updates other options.
   * Accumulates image parts.
   *
   * @throws Error if trying to add a compaction request when queue already has messages
   */
  add(message: string, options?: SendMessageOptions & { imageParts?: ImagePart[] }): void {
    const trimmedMessage = message.trim();
    const hasImages = options?.imageParts && options.imageParts.length > 0;

    // Reject if both text and images are empty
    if (trimmedMessage.length === 0 && !hasImages) {
      return;
    }

    const incomingIsCompaction = isCompactionMetadata(options?.muxMetadata);
    const queueHasMessages = !this.isEmpty();

    // Cannot add compaction to a queue that already has messages
    // (user should wait for those messages to send first)
    if (incomingIsCompaction && queueHasMessages) {
      throw new Error(
        "Cannot queue compaction request: queue already has messages. " +
          "Wait for current stream to complete before compacting."
      );
    }

    // Add text message if non-empty
    if (trimmedMessage.length > 0) {
      this.messages.push(trimmedMessage);
    }

    if (options) {
      const { imageParts, ...restOptions } = options;

      // Preserve first muxMetadata (see class docblock for rationale)
      if (options.muxMetadata !== undefined && this.firstMuxMetadata === undefined) {
        this.firstMuxMetadata = options.muxMetadata;
      }
      this.latestOptions = restOptions;

      if (imageParts && imageParts.length > 0) {
        this.accumulatedImages.push(...imageParts);
      }
    }
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
   * - Multiple messages show all actual message texts
   */
  getDisplayText(): string {
    // Only show rawCommand for single compaction request
    if (this.messages.length === 1 && isCompactionMetadata(this.firstMuxMetadata)) {
      return this.firstMuxMetadata.rawCommand;
    }

    return this.messages.join("\n");
  }

  /**
   * Get accumulated image parts for display.
   */
  getImageParts(): ImagePart[] {
    return [...this.accumulatedImages];
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
    options?: SendMessageOptions & { imageParts?: ImagePart[] };
  } {
    const joinedMessages = this.messages.join("\n");
    // First metadata takes precedence (preserves compaction requests)
    const muxMetadata =
      this.firstMuxMetadata !== undefined
        ? this.firstMuxMetadata
        : (this.latestOptions?.muxMetadata as unknown);
    const options = this.latestOptions
      ? {
          ...this.latestOptions,
          muxMetadata,
          imageParts: this.accumulatedImages.length > 0 ? this.accumulatedImages : undefined,
        }
      : undefined;

    return { message: joinedMessages, options };
  }

  /**
   * Clear all queued messages, options, and images.
   */
  clear(): void {
    this.messages = [];
    this.firstMuxMetadata = undefined;
    this.latestOptions = undefined;
    this.accumulatedImages = [];
  }

  /**
   * Check if queue is empty (no messages AND no images).
   */
  isEmpty(): boolean {
    return this.messages.length === 0 && this.accumulatedImages.length === 0;
  }
}
