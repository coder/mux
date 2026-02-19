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

function fuzzySubsequenceMatchNormalized(haystack: string, needle: string): boolean {
  // By convention, an empty needle matches everything.
  if (!needle) return true;
  if (!haystack) return false;

  let needleIdx = 0;
  for (const ch of haystack) {
    if (ch === needle[needleIdx]) {
      needleIdx++;
      if (needleIdx >= needle.length) {
        return true;
      }
    }
  }

  return false;
}

export function fuzzySubsequenceMatch(haystack: string, needle: string): boolean {
  assert(typeof haystack === "string", "fuzzySubsequenceMatch: haystack must be a string");
  assert(typeof needle === "string", "fuzzySubsequenceMatch: needle must be a string");

  return fuzzySubsequenceMatchNormalized(normalizeFuzzyText(haystack), normalizeFuzzyText(needle));
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

export function scoreAllTerms(haystack: string, query: string): number {
  assert(typeof haystack === "string", "scoreAllTerms: haystack must be a string");
  assert(typeof query === "string", "scoreAllTerms: query must be a string");

  const terms = splitQueryIntoTerms(query);
  if (terms.length === 0) return 1;

  const normalizedHaystack = normalizeFuzzyText(haystack);
  let totalScore = 0;
  for (const term of terms) {
    const score = scoreSingleTermNormalized(normalizedHaystack, term);
    if (score === 0) return 0; // AND semantics: all terms must match
    totalScore += score;
  }

  return totalScore / terms.length;
}

export function matchesAllTerms(haystack: string, query: string): boolean {
  assert(typeof haystack === "string", "matchesAllTerms: haystack must be a string");
  assert(typeof query === "string", "matchesAllTerms: query must be a string");

  const terms = splitQueryIntoTerms(query);
  if (terms.length === 0) return true;

  const normalizedHaystack = normalizeFuzzyText(haystack);
  for (const term of terms) {
    if (!fuzzySubsequenceMatchNormalized(normalizedHaystack, term)) {
      return false;
    }
  }

  return true;
}
