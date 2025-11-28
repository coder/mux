import type { ImagePart, SendMessageOptions } from "@/common/types/ipc";

/**
 * Queue for messages sent during active streaming.
 *
 * Stores:
 * - Message texts (accumulated)
 * - Latest options (model, thinking level, etc. - overwrites on each add)
 * - Image parts (accumulated across all messages)
 */
export class MessageQueue {
  private messages: string[] = [];
  private latestOptions?: SendMessageOptions;
  private accumulatedImages: ImagePart[] = [];

  /**
   * Add a message to the queue.
   * Updates to latest options, accumulates image parts.
   * Allows image-only messages (empty text with images).
   */
  add(message: string, options?: SendMessageOptions & { imageParts?: ImagePart[] }): void {
    const trimmedMessage = message.trim();
    const hasImages = options?.imageParts && options.imageParts.length > 0;

    // Reject if both text and images are empty
    if (trimmedMessage.length === 0 && !hasImages) {
      return;
    }

    // Add text message if non-empty
    if (trimmedMessage.length > 0) {
      this.messages.push(trimmedMessage);
    }

    if (options) {
      const { imageParts, ...restOptions } = options;
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
   * Returns rawCommand if this is a compaction request, otherwise joined messages.
   * Matches StreamingMessageAggregator behavior.
   */
  getDisplayText(): string {
    // Check if we have compaction metadata
    const cmuxMetadata = this.latestOptions?.muxMetadata;
    if (cmuxMetadata?.type === "compaction-request") {
      return cmuxMetadata.rawCommand;
    }

    // Otherwise return joined messages
    return this.messages.join("\n");
  }

  /**
   * Get accumulated image parts for display.
   */
  getImageParts(): ImagePart[] {
    return [...this.accumulatedImages];
  }

  /**
   * Get combined message and options for sending.
   * Returns joined messages with latest options + accumulated images.
   */
  produceMessage(): {
    message: string;
    options?: SendMessageOptions & { imageParts?: ImagePart[] };
  } {
    const joinedMessages = this.messages.join("\n");

    const options = this.latestOptions
      ? {
          ...this.latestOptions,
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
