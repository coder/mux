import { countTokens, countTokensBatch } from "@/node/utils/main/tokenizer";
import { calculateTokenStats } from "@/common/utils/tokens/tokenStatsCalculator";
import type { MuxMessage } from "@/common/types/message";
import type { ChatStats } from "@/common/types/chatStats";
import assert from "@/common/utils/assert";

export class TokenizerService {
  /**
   * Count tokens for a single string
   */
  async countTokens(model: string, text: string): Promise<number> {
    assert(
      typeof model === "string" && model.length > 0,
      "Tokenizer countTokens requires model name"
    );
    assert(typeof text === "string", "Tokenizer countTokens requires text");
    return countTokens(model, text);
  }

  /**
   * Count tokens for a batch of strings
   */
  async countTokensBatch(model: string, texts: string[]): Promise<number[]> {
    assert(
      typeof model === "string" && model.length > 0,
      "Tokenizer countTokensBatch requires model name"
    );
    assert(Array.isArray(texts), "Tokenizer countTokensBatch requires an array of strings");
    return countTokensBatch(model, texts);
  }

  /**
   * Calculate detailed token statistics for a chat history
   */
  async calculateStats(messages: MuxMessage[], model: string): Promise<ChatStats> {
    assert(Array.isArray(messages), "Tokenizer calculateStats requires an array of messages");
    assert(
      typeof model === "string" && model.length > 0,
      "Tokenizer calculateStats requires model name"
    );

    return calculateTokenStats(messages, model);
  }
}
