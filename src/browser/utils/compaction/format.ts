import type { CompactionRequestData } from "@/common/types/message";
import { isDefaultContinueMessage } from "@/common/types/message";

/**
 * Format the compaction command line (without any multiline continue payload).
 */
export function formatCompactionCommandLine(options: {
  model?: string;
  maxOutputTokens?: number;
}): string {
  let cmd = "/compact";
  if (typeof options.maxOutputTokens === "number") {
    cmd += ` -t ${options.maxOutputTokens}`;
  }
  if (typeof options.model === "string" && options.model.trim().length > 0) {
    cmd += ` -m ${options.model}`;
  }
  return cmd;
}

/**
 * Return the visible continue text for a compaction request.
 * Hides the default resume sentinel ("Continue") and empty text.
 */
export function getCompactionContinueText(
  continueMessage?: CompactionRequestData["continueMessage"]
): string | null {
  if (!continueMessage) return null;
  if (isDefaultContinueMessage(continueMessage)) return null;
  const continueText = continueMessage.text;
  if (typeof continueText !== "string" || continueText.trim().length === 0) {
    return null;
  }
  return continueText;
}
