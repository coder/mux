import {
  normalizeFuzzyText,
  scoreSingleTermNormalized,
  splitQueryIntoTerms,
} from "@/browser/utils/fuzzySearch";

/**
 * Structured search document for field-aware palette ranking.
 * Scoring primary and secondary fields independently avoids penalizing
 * exact title matches when metadata (keywords, subtitles, paths) is long.
 */
export interface SearchDoc {
  primaryText: string;
  secondaryText?: string[];
}

/**
 * Internal match result — a rank tuple, not a blended scalar.
 * Sorting precedence: exactPrimaryQuery > primaryAvg > secondaryAvg > caller tie-break.
 */
interface QueryMatch {
  matches: true;
  /** Whether the full normalized query exactly equals the normalized primary text. */
  exactPrimaryQuery: boolean;
  /** Average per-term score against the primary field (0 if no primary hits). */
  primaryAvg: number;
  /** Average per-term best score across secondary fields (0 if no secondary hits). */
  secondaryAvg: number;
}

function scoreQueryAgainstDoc(doc: SearchDoc, query: string): QueryMatch | null {
  const normalizedQuery = normalizeFuzzyText(query);
  const terms = splitQueryIntoTerms(normalizedQuery);
  if (terms.length === 0) {
    return { matches: true, exactPrimaryQuery: false, primaryAvg: 0, secondaryAvg: 0 };
  }

  const primary = normalizeFuzzyText(doc.primaryText);
  const secondary = (doc.secondaryText ?? [])
    .map((field) => normalizeFuzzyText(field))
    .filter((field) => field.length > 0);

  let primaryTotal = 0;
  let secondaryTotal = 0;

  for (const term of terms) {
    const primaryScore = scoreSingleTermNormalized(primary, term);
    const secondaryScore = Math.max(
      0,
      ...secondary.map((field) => scoreSingleTermNormalized(field, term))
    );

    // AND semantics: every term must match in at least one field.
    if (primaryScore === 0 && secondaryScore === 0) {
      return null; // no match
    }

    primaryTotal += primaryScore;
    secondaryTotal += secondaryScore;
  }

  return {
    matches: true,
    exactPrimaryQuery: primary === normalizedQuery,
    primaryAvg: primaryTotal / terms.length,
    secondaryAvg: secondaryTotal / terms.length,
  };
}

function compareMatches(a: QueryMatch, b: QueryMatch): number {
  // Exact primary query match always wins.
  if (a.exactPrimaryQuery !== b.exactPrimaryQuery) return a.exactPrimaryQuery ? -1 : 1;
  // Then by primary field quality.
  if (a.primaryAvg !== b.primaryAvg) return b.primaryAvg - a.primaryAvg;
  // Then by secondary field quality.
  return b.secondaryAvg - a.secondaryAvg;
}

/**
 * Field-aware scored ranking for command palette list modes.
 * Scores each item's primary label and secondary metadata independently
 * so exact title matches are never penalized by long metadata fields.
 * Items that don't match the query are filtered out.
 * When the query is empty, returns items sorted by tie-breaker only.
 */
export function rankByPaletteQuery<T>(params: {
  items: T[];
  query: string;
  toSearchDoc: (item: T) => SearchDoc;
  tieBreak: (a: T, b: T) => number;
}): T[] {
  const q = params.query.trim();
  if (!q) return [...params.items].sort(params.tieBreak);

  const scored: Array<{ item: T; match: QueryMatch }> = [];
  for (const item of params.items) {
    const match = scoreQueryAgainstDoc(params.toSearchDoc(item), q);
    if (match) scored.push({ item, match });
  }

  return scored
    .sort((a, b) => compareMatches(a.match, b.match) || params.tieBreak(a.item, b.item))
    .map((entry) => entry.item);
}
