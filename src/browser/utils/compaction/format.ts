import type { CompactionRequestData } from "@/common/types/message";

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
 * Build the text shown in the editor when editing a /compact request.
 *
 * `rawCommand` is intentionally a single-line command (no multiline payload).
 * If a continue message exists, we append its text on subsequent lines.
 */
export function buildCompactionEditText(request: {
  rawCommand: string;
  parsed: CompactionRequestData;
}): string {
  const continueMessage = request.parsed.continueMessage;
  const continueText = continueMessage?.text;
  const hasImages = (continueMessage?.imageParts?.length ?? 0) > 0;
  const hasReviews = (continueMessage?.reviews?.length ?? 0) > 0;
  const isDefaultResume =
    typeof continueText === "string" &&
    continueText.trim() === "Continue" &&
    !hasImages &&
    !hasReviews;

  if (typeof continueText === "string" && continueText.trim().length > 0 && !isDefaultResume) {
    return `${request.rawCommand}\n${continueText}`;
  }
  return request.rawCommand;
}
