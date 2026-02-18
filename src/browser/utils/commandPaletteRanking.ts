import { scoreAllTerms } from "@/browser/utils/fuzzySearch";

/**
 * Generic scored ranking for command palette list modes.
 * Scores each item via fuzzy search and returns items sorted by relevance.
 * Items that don't match the query (score=0) are filtered out.
 * When the query is empty, returns items sorted by tie-breaker only.
 */
export function rankByPaletteQuery<T>(params: {
  items: T[];
  query: string;
  toSearchText: (item: T) => string;
  tieBreak: (a: T, b: T) => number;
}): T[] {
  const q = params.query.trim();
  if (!q) return [...params.items].sort(params.tieBreak);

  return params.items
    .map((item) => ({ item, score: scoreAllTerms(params.toSearchText(item), q) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || params.tieBreak(a.item, b.item))
    .map((entry) => entry.item);
}
