import assert from "@/common/utils/assert";

/**
 * Small fuzzy-matching helpers for the command palette (and similar UIs).
 *
 * We want something closer to an fzf experience:
 * - Space-separated terms are ANDed.
 * - Common formatting punctuation (e.g. `Ask: check …`) doesn't block matches.
 * - Each term is matched as a fuzzy subsequence (in-order characters; gaps allowed).
 *
 * NOTE: This intentionally does *not* score/rank matches; it's used as a boolean filter.
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
