import type { CompactionRequestData } from "@/common/types/message";
import { isDefaultContinueMessage } from "@/common/types/message";

/**
 * Format compaction command *line* for display.
 *
 * Intentionally excludes the multiline continue payload; that content is stored in
 * `muxMetadata.parsed.continueMessage` and is shown/edited separately.
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

/**
 * Build the text shown in the editor when editing a /compact request.
 *
 * `rawCommand` is intentionally a single-line command (no multiline payload).
 * If a continue message exists, we append its text on subsequent lines.
 */
export function buildCompactionEditText(request: {
  rawCommand: string;
  parsed: CompactionRequestData;
}): string {
  const continueText = getCompactionContinueText(request.parsed.continueMessage);
  if (continueText) {
    return `${request.rawCommand}\n${continueText}`;
  }
  return request.rawCommand;
}

/**
 * Build the text shown in user message bubbles for a /compact request.
 * Uses a hard line break so the command and payload render on separate lines.
 */
export function buildCompactionDisplayText(request: {
  rawCommand: string;
  parsed: CompactionRequestData;
}): string {
  const continueText = getCompactionContinueText(request.parsed.continueMessage);
  if (continueText) {
    return `${request.rawCommand}  \n${continueText}`;
  }
  return request.rawCommand;
}
