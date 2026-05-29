import {
  DEFAULT_COMPACTION_WORD_TARGET,
  WORDS_TO_TOKENS_RATIO,
  buildCompactionPrompt,
} from "@/common/constants/ui";
import { isDefaultSourceContent } from "@/common/types/message";
import type { CompactionRequestData } from "@/common/types/message";

interface BuildCompactionMessageTextOptions {
  maxOutputTokens?: number;
  followUpContent?: CompactionRequestData["followUpContent"];
}

/**
 * Build the compaction prompt text sent to the model.
 *
 * This is shared by frontend-triggered and backend-triggered compaction flows
 * so prompt wording stays consistent regardless of where compaction starts.
 */
export function buildCompactionMessageText(options: BuildCompactionMessageTextOptions): string {
  const targetWords = options.maxOutputTokens
    ? Math.round(options.maxOutputTokens / WORDS_TO_TOKENS_RATIO)
    : DEFAULT_COMPACTION_WORD_TARGET;

  let messageText = buildCompactionPrompt(targetWords);

  if (options.followUpContent && !isDefaultSourceContent(options.followUpContent)) {
    messageText += `\n\nThe user wants to continue with: ${options.followUpContent.text}`;
  }

  return messageText;
}
