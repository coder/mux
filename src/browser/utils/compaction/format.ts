import type { CompactionRequestData } from "@/common/types/message";

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
