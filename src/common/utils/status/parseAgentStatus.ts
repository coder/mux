export interface ParsedAgentStatus {
  emoji?: string;
  message: string;
  url?: string;
}

// Basic URL matcher. Intentionally simple: we only need the first URL to make it clickable.
const URL_REGEX = /https?:\/\/[^\s"'<>]+/i;

function truncateMessage(message: string, maxLength: number): string {
  if (message.length <= maxLength) {
    return message;
  }
  // Truncate to maxLength-1 and add ellipsis (total = maxLength)
  return message.slice(0, maxLength - 1) + "…";
}

/**
 * Returns true if `str` is a single emoji grapheme cluster.
 * Uses Intl.Segmenter so variation selectors / skin tones count as a single cluster.
 */
function isSingleEmojiGrapheme(str: string): boolean {
  if (!str) return false;

  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  const segments = [...segmenter.segment(str)];
  if (segments.length !== 1) return false;

  const emojiRegex = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;
  return emojiRegex.test(segments[0].segment);
}

function sanitizeUrl(url: string): string {
  // Trim common trailing punctuation that often follows URLs in prose.
  return url.replace(/[])}.,;:!?]+$/g, "");
}

/**
 * Parse a single-line status string into { emoji?, message, url? }.
 *
 * Parsing order matters:
 * 1) Extract URL and remove it from the message (prevents redundancy in UI)
 * 2) Extract leading emoji (if present)
 * 3) Truncate AFTER extraction
 */
export function parseAgentStatusFromLine(rawLine: string, maxLength: number): ParsedAgentStatus {
  let line = rawLine.trim();

  // URL extraction (first URL only)
  let url: string | undefined;
  const urlMatch = URL_REGEX.exec(line);
  if (urlMatch) {
    url = sanitizeUrl(urlMatch[0]);
    // Remove the matched substring (not the sanitized version) to keep surrounding punctuation intact.
    const index = urlMatch.index;
    line = (line.slice(0, index) + line.slice(index + urlMatch[0].length))
      .replace(/\s+/g, " ")
      .trim();
  }

  // Leading emoji extraction
  let emoji: string | undefined;
  if (line.length > 0) {
    const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
    const first = segmenter.segment(line)[Symbol.iterator]().next();
    if (!first.done) {
      const firstCluster = first.value.segment;
      const rest = line.slice(first.value.index + firstCluster.length);
      if (isSingleEmojiGrapheme(firstCluster) && /^\s/.test(rest)) {
        emoji = firstCluster;
        line = rest.trim();
      }
    }
  }

  const message = truncateMessage(line, maxLength);

  return {
    ...(emoji ? { emoji } : {}),
    message,
    ...(url ? { url } : {}),
  };
}
