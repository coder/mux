import assert from "@/common/utils/assert";

/**
 * Small fuzzy-matching helpers for the command palette (and similar UIs).
 *
 * We want something closer to an fzf experience:
 * - Space-separated terms are ANDed.
 * - Common formatting punctuation (e.g. `Ask: check …`) doesn't block matches.
 * - Each term can be matched as a fuzzy subsequence (in-order characters; gaps allowed).
 * - Scored helpers rank exact/contiguous matches above loose subsequence matches.
 */

const NORMALIZE_SEPARATORS_RE = /[:•·→/\\\-_]+/g;

export function normalizeFuzzyText(text: string): string {
  assert(typeof text === "string", "normalizeFuzzyText: text must be a string");

  return text.toLowerCase().replace(NORMALIZE_SEPARATORS_RE, " ").replace(/\s+/g, " ").trim();
}

export function splitQueryIntoTerms(query: string): string[] {
  assert(typeof query === "string", "splitQueryIntoTerms: query must be a string");

  const normalized = normalizeFuzzyText(query);
  if (!normalized) return [];

  return normalized.split(" ").filter((t) => t.length > 0);
}

/**
 * Score a single normalized term against a normalized haystack.
 * Returns 0 for no match, higher values (up to 1) for better matches.
 * Exact substring match scores highest; contiguous partial matches score
 * higher than scattered subsequence matches.
 */
export function scoreSingleTermNormalized(haystack: string, needle: string): number {
  assert(typeof haystack === "string", "scoreSingleTermNormalized: haystack must be a string");
  assert(typeof needle === "string", "scoreSingleTermNormalized: needle must be a string");

  if (!needle) return 1;
  if (!haystack) return 0;

  // Exact full match
  if (haystack === needle) return 1;

  // Substring match — score based on how much of the haystack the needle covers.
  const subIdx = haystack.indexOf(needle);
  if (subIdx !== -1) {
    // Bonus for word-boundary alignment (starts at beginning of a word).
    const atWordStart = subIdx === 0 || haystack[subIdx - 1] === " ";
    const coverage = needle.length / haystack.length;
    return atWordStart ? 0.8 + 0.2 * coverage : 0.6 + 0.2 * coverage;
  }

  // Fall back to subsequence match with quality penalty.
  // Score based on how tightly packed the matched characters are.
  let needleIdx = 0;
  let firstMatch = -1;
  let lastMatch = -1;
  for (let i = 0; i < haystack.length; i++) {
    if (haystack[i] === needle[needleIdx]) {
      if (firstMatch === -1) firstMatch = i;
      lastMatch = i;
      needleIdx++;
      if (needleIdx >= needle.length) break;
    }
  }

  if (needleIdx < needle.length) return 0; // no match

  // Tighter span = better score. Maximum span is haystack.length.
  const span = lastMatch - firstMatch + 1;
  const tightness = needle.length / span; // 1.0 = perfectly contiguous
  return 0.1 + 0.4 * tightness; // Range: 0.1 to 0.5 for subsequence matches
}
