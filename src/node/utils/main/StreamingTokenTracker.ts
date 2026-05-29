/**
 * StreamingTokenTracker - Synchronous token counting for streaming deltas
 *
 * Simplified tracker that provides immediate token counts for each delta.
 * TPS calculation moved to frontend for better replay support and flexibility.
 */

import { getTokenizerForModel, type Tokenizer } from "./tokenizer";

/**
 * StreamingTokenTracker provides synchronous token counting
 */
export class StreamingTokenTracker {
  private tokenizer: Tokenizer | null = null;
  private tokenizerModelKey: string | null = null;

  /**
   * Initialize tokenizer for the current model
   * Should be called when model changes or on first stream
   */
  async setModel(model: string, metadataModelOverride?: string): Promise<void> {
    const tokenizerModelKey = metadataModelOverride ?? model;
    if (this.tokenizer && this.tokenizerModelKey === tokenizerModelKey) {
      return;
    }

    this.tokenizer = await getTokenizerForModel(model, metadataModelOverride);
    this.tokenizerModelKey = tokenizerModelKey;
  }

  /**
   * Count tokens in a text string synchronously
   * Performance: <1ms per delta with LRU caching
   */
  async countTokens(text: string): Promise<number> {
    if (!this.tokenizer || !text) return 0;
    return this.tokenizer.countTokens(text);
  }
}
