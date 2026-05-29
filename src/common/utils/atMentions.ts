import assert from "@/common/utils/assert";

export interface AtMentionLineRange {
  startLine: number;
  endLine: number;
}

export interface AtMention {
  /** Original (trimmed) token contents after the leading @ (e.g. "src/foo.ts#L1-3"). */
  token: string;
  /** The file path portion (e.g. "src/foo.ts"). */
  path: string;
  /** Parsed line range when provided in #Lx-y form. */
  range?: AtMentionLineRange;
  /** Error message if a #... fragment was present but not a supported #Lx-y range. */
  rangeError?: string;
}

export interface AtMentionCursorMatch {
  /** Index of the leading '@' character. */
  startIndex: number;
  /** End index (exclusive) of the mention token (does not include trailing punctuation). */
  endIndex: number;
  /** The query text after '@' (does not include any #... fragment). */
  query: string;
}

const TRAILING_PUNCTUATION_RE = /[(){}<>,.;:!?"'`\]]+$/;

function stripTrailingPunctuation(token: string): string {
  return token.replace(TRAILING_PUNCTUATION_RE, "");
}

function isWordChar(ch: string | undefined): boolean {
  return Boolean(ch && /[A-Za-z0-9_]/.test(ch));
}

function parseRange(
  fragment: string
):
  | { range: AtMentionLineRange; rangeError?: undefined }
  | { range?: undefined; rangeError: string } {
  const match = /^L(\d+)-(\d+)$/i.exec(fragment);
  if (!match) {
    return {
      rangeError: `Unsupported range fragment: #${fragment} (expected #L<start>-<end>)`,
    };
  }

  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return { rangeError: `Invalid range fragment: #${fragment}` };
  }
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return { rangeError: `Invalid range fragment: #${fragment}` };
  }
  if (start < 1 || end < 1) {
    return { rangeError: `Invalid range fragment: #${fragment} (line numbers must be >= 1)` };
  }
  if (start > end) {
    return { rangeError: `Invalid range fragment: #${fragment} (start must be <= end)` };
  }

  return { range: { startLine: start, endLine: end } };
}

/**
 * Extract @mentions from freeform text.
 *
 * MVP rules:
 * - A mention starts at '@' and continues until whitespace.
 * - Trailing punctuation (commas, parens, etc.) is ignored.
 * - Optional line range suffix: #L<start>-<end>
 *
 * NOTE: Callers should apply additional heuristics (e.g. only expand when path looks like a file).
 */
export function extractAtMentions(text: string): AtMention[] {
  const result: AtMention[] = [];

  for (const match of text.matchAll(/@(\S+)/g)) {
    const index = match.index;
    if (typeof index !== "number") continue;

    // Avoid matching email addresses or other "word@word" patterns.
    if (index > 0 && isWordChar(text[index - 1])) {
      continue;
    }

    const rawToken = match[1];
    if (typeof rawToken !== "string") continue;

    const token = stripTrailingPunctuation(rawToken);
    if (!token) continue;

    const [path, fragment] = token.split("#", 2);
    if (!path) continue;

    if (!fragment) {
      result.push({ token, path });
      continue;
    }

    const parsed = parseRange(fragment);
    result.push({ token, path, ...parsed });
  }

  return result;
}

/**
 * Find the @mention token currently under the cursor.
 *
 * This is used for interactive autocomplete (file path suggestions). It intentionally ignores
 * tokens that already have a "#" fragment, since the user is likely specifying a line range.
 */
export function findAtMentionAtCursor(text: string, cursor: number): AtMentionCursorMatch | null {
  assert(Number.isInteger(cursor), "cursor must be an integer");
  assert(cursor >= 0 && cursor <= text.length, "cursor out of bounds");

  // Expand to token boundaries (whitespace-delimited).
  let tokenStart = cursor;
  while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1] ?? "")) {
    tokenStart--;
  }

  let tokenEnd = cursor;
  while (tokenEnd < text.length && !/\s/.test(text[tokenEnd] ?? "")) {
    tokenEnd++;
  }

  // Search backwards for an '@' within this token, but avoid "word@word" patterns.
  let atIndex = -1;
  for (let i = cursor - 1; i >= tokenStart; i--) {
    if (text[i] === "@") {
      atIndex = i;
      break;
    }
  }

  if (atIndex === -1) {
    return null;
  }

  if (atIndex > 0 && isWordChar(text[atIndex - 1])) {
    return null;
  }

  const rawAfterAt = text.slice(atIndex + 1, tokenEnd);
  const cleanedAfterAt = stripTrailingPunctuation(rawAfterAt);

  // Do not autocomplete after the user started specifying a fragment (e.g. #L1-10).
  if (cleanedAfterAt.includes("#")) {
    return null;
  }

  return {
    startIndex: atIndex,
    endIndex: atIndex + 1 + cleanedAfterAt.length,
    query: cleanedAfterAt,
  };
}
