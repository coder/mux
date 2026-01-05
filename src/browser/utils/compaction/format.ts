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
  const continueText = request.parsed.continueMessage?.text;
  if (typeof continueText === "string" && continueText.trim().length > 0) {
    return `${request.rawCommand}\n${continueText}`;
  }
  return request.rawCommand;
}
