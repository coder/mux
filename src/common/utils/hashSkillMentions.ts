/**
 * Utilities for #skill mentions in chat input.
 *
 * Unlike slash commands (which must be at the start of input), hash skill mentions
 * can appear anywhere in the message, allowing multiple skills in one message.
 */

import assert from "@/common/utils/assert";

export interface HashSkillCursorMatch {
  /** Index of the leading '#' character. */
  startIndex: number;
  /** End index (exclusive) of the skill token. */
  endIndex: number;
  /** The query text after '#' (the partial skill name being typed). */
  query: string;
}

export interface HashSkillMention {
  /** The skill name (without the leading #). */
  name: string;
  /** Index of the leading '#' character. */
  startIndex: number;
  /** End index (exclusive) of the skill token. */
  endIndex: number;
}

const TRAILING_PUNCTUATION_RE = /[(){}<>,.;:!?'"`\]]+$/;

function stripTrailingPunctuation(token: string): string {
  return token.replace(TRAILING_PUNCTUATION_RE, "");
}

function isWordChar(ch: string | undefined): boolean {
  return Boolean(ch && /[A-Za-z0-9_]/.test(ch));
}

/**
 * Find the #skill token currently under the cursor.
 *
 * Used for interactive autocomplete (skill suggestions). Only matches tokens that
 * look like skill names (alphanumeric + hyphens).
 */
export function findHashSkillAtCursor(text: string, cursor: number): HashSkillCursorMatch | null {
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

  // Search backwards for a '#' within this token.
  let hashIndex = -1;
  for (let i = cursor - 1; i >= tokenStart; i--) {
    if (text[i] === "#") {
      hashIndex = i;
      break;
    }
  }

  if (hashIndex === -1) {
    return null;
  }

  // Avoid matching word#word patterns (require # at token start or after whitespace).
  if (hashIndex > 0 && isWordChar(text[hashIndex - 1])) {
    return null;
  }

  const rawAfterHash = text.slice(hashIndex + 1, tokenEnd);
  const cleanedAfterHash = stripTrailingPunctuation(rawAfterHash);

  // Only match if what follows looks like a skill name (alphanumeric + hyphens).
  // Empty query is OK (user just typed "#").
  if (cleanedAfterHash && !/^[a-z0-9-]*$/i.test(cleanedAfterHash)) {
    return null;
  }

  return {
    startIndex: hashIndex,
    endIndex: hashIndex + 1 + cleanedAfterHash.length,
    query: cleanedAfterHash,
  };
}

/**
 * Extract all #skill mentions from text.
 *
 * Returns skill names that match the expected format (alphanumeric + hyphens).
 * Used for processing the message on send and for rendering.
 */
export function extractHashSkillMentions(
  text: string,
  validSkillNames: Set<string>
): HashSkillMention[] {
  const result: HashSkillMention[] = [];

  // Match # followed by alphanumeric and hyphens, not preceded by a word character.
  const regex = /#([a-z0-9][a-z0-9-]*)/gi;

  for (const match of text.matchAll(regex)) {
    const index = match.index;
    if (typeof index !== "number") continue;

    // Avoid matching word#word patterns.
    if (index > 0 && isWordChar(text[index - 1])) {
      continue;
    }

    const rawName = match[1];
    if (typeof rawName !== "string") continue;

    const name = stripTrailingPunctuation(rawName).toLowerCase();
    if (!name) continue;

    // Only include if it's a valid skill name.
    if (!validSkillNames.has(name)) {
      continue;
    }

    result.push({
      name,
      startIndex: index,
      endIndex: index + 1 + name.length,
    });
  }

  return result;
}

/**
 * Format user message text when hash skills are invoked.
 * Makes it explicit to the model that skills were invoked.
 */
export function formatHashSkillInvocationText(
  originalText: string,
  skillMentions: HashSkillMention[]
): string {
  if (skillMentions.length === 0) {
    return originalText;
  }

  // Remove the #skill mentions from the text and prepend skill invocation.
  // Process in reverse order to maintain indices.
  let processedText = originalText;
  const sortedMentions = [...skillMentions].sort((a, b) => b.startIndex - a.startIndex);

  for (const mention of sortedMentions) {
    const before = processedText.slice(0, mention.startIndex);
    const after = processedText.slice(mention.endIndex);
    // Remove the #skill, but preserve any surrounding whitespace structure.
    processedText = before + after;
  }

  // Clean up any double spaces that might result.
  processedText = processedText.replace(/  +/g, " ").trim();

  const skillNames = skillMentions.map((m) => m.name);
  const uniqueSkills = [...new Set(skillNames)];

  if (uniqueSkills.length === 1) {
    return processedText
      ? `Using skill ${uniqueSkills[0]}: ${processedText}`
      : `Use skill ${uniqueSkills[0]}`;
  }

  const skillList = uniqueSkills.join(", ");
  return processedText ? `Using skills ${skillList}: ${processedText}` : `Use skills ${skillList}`;
}
