export interface FileCompletionsIndex {
  files: string[];
  filesLower: string[];
  basenamesLower: string[];
  sortedByPathLower: number[];
  sortedByBasenameLower: number[];
  defaultOrder: number[];
}

export const EMPTY_FILE_COMPLETIONS_INDEX: FileCompletionsIndex = {
  files: [],
  filesLower: [],
  basenamesLower: [],
  sortedByPathLower: [],
  sortedByBasenameLower: [],
  defaultOrder: [],
};

function countSlashes(value: string): number {
  let count = 0;
  for (const ch of value) {
    if (ch === "/") {
      count++;
    }
  }
  return count;
}

function lowerBound(
  sortedIndices: readonly number[],
  keys: readonly string[],
  query: string
): number {
  let lo = 0;
  let hi = sortedIndices.length;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const idx = sortedIndices[mid];
    const key = idx === undefined ? "" : (keys[idx] ?? "");

    if (key < query) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  return lo;
}

function collectPrefixMatches(
  sortedIndices: readonly number[],
  keys: readonly string[],
  query: string,
  addIndex: (idx: number) => boolean
): void {
  const start = lowerBound(sortedIndices, keys, query);
  for (let i = start; i < sortedIndices.length; i++) {
    const idx = sortedIndices[i];
    if (idx === undefined) {
      return;
    }

    const key = keys[idx];
    if (!key?.startsWith(query)) {
      return;
    }

    if (!addIndex(idx)) {
      return;
    }
  }
}

interface ScoredCandidate {
  index: number;
  score: number;
}

function compareCandidate(
  a: ScoredCandidate,
  b: ScoredCandidate,
  index: FileCompletionsIndex
): number {
  if (a.score !== b.score) return a.score - b.score;

  const aPath = index.files[a.index];
  const bPath = index.files[b.index];
  if (!aPath || !bPath) return 0;

  if (aPath.length !== bPath.length) return aPath.length - bPath.length;
  return aPath.localeCompare(bPath);
}

function considerCandidate(
  best: ScoredCandidate[],
  candidate: ScoredCandidate,
  index: FileCompletionsIndex,
  limit: number
): void {
  if (limit <= 0) return;

  if (best.length === limit) {
    const worst = best[best.length - 1];
    if (worst && compareCandidate(candidate, worst, index) >= 0) {
      return;
    }
  }

  let insertAt = 0;
  while (insertAt < best.length) {
    const other = best[insertAt];
    if (!other || compareCandidate(candidate, other, index) < 0) {
      break;
    }
    insertAt++;
  }

  best.splice(insertAt, 0, candidate);
  if (best.length > limit) {
    best.pop();
  }
}

export function buildFileCompletionsIndex(files: string[]): FileCompletionsIndex {
  const filesLower = files.map((p) => p.toLowerCase());
  const basenamesLower = filesLower.map((p) => {
    const lastSlash = p.lastIndexOf("/");
    return lastSlash === -1 ? p : p.slice(lastSlash + 1);
  });

  const indices = files.map((_, i) => i);

  const sortedByPathLower = [...indices].sort((a, b) => {
    const aPath = filesLower[a];
    const bPath = filesLower[b];
    if (aPath !== bPath) return aPath.localeCompare(bPath);
    return a - b;
  });

  const sortedByBasenameLower = [...indices].sort((a, b) => {
    const aBase = basenamesLower[a];
    const bBase = basenamesLower[b];
    if (aBase !== bBase) return aBase.localeCompare(bBase);

    const aPath = filesLower[a];
    const bPath = filesLower[b];
    if (aPath !== bPath) return aPath.localeCompare(bPath);

    return a - b;
  });

  const defaultOrder = [...indices].sort((a, b) => {
    const aPath = files[a];
    const bPath = files[b];
    if (!aPath || !bPath) return 0;

    const depthA = countSlashes(aPath);
    const depthB = countSlashes(bPath);
    if (depthA !== depthB) return depthA - depthB;

    if (aPath.length !== bPath.length) return aPath.length - bPath.length;
    return aPath.localeCompare(bPath);
  });

  return {
    files,
    filesLower,
    basenamesLower,
    sortedByPathLower,
    sortedByBasenameLower,
    defaultOrder,
  };
}

export function searchFileCompletions(
  index: FileCompletionsIndex,
  query: string,
  limit: number
): string[] {
  const resolvedLimit = Math.max(0, Math.trunc(limit));
  if (resolvedLimit === 0 || index.files.length === 0) {
    return [];
  }

  const normalizedQuery = query.replace(/\\/g, "/").trim().toLowerCase();

  const results: string[] = [];
  const seen = new Set<number>();

  const addIndex = (idx: number): boolean => {
    if (seen.has(idx)) {
      return results.length < resolvedLimit;
    }

    seen.add(idx);
    const filePath = index.files[idx];
    if (filePath) {
      results.push(filePath);
    }

    return results.length < resolvedLimit;
  };

  if (!normalizedQuery) {
    for (const idx of index.defaultOrder) {
      if (!addIndex(idx)) {
        break;
      }
    }

    return results;
  }

  collectPrefixMatches(index.sortedByPathLower, index.filesLower, normalizedQuery, addIndex);
  if (results.length < resolvedLimit) {
    collectPrefixMatches(
      index.sortedByBasenameLower,
      index.basenamesLower,
      normalizedQuery,
      addIndex
    );
  }

  if (results.length < resolvedLimit) {
    const remaining = resolvedLimit - results.length;
    const best: ScoredCandidate[] = [];
    const segmentNeedle = `/${normalizedQuery}`;

    for (let idx = 0; idx < index.filesLower.length; idx++) {
      if (seen.has(idx)) continue;

      const haystack = index.filesLower[idx];
      if (!haystack) continue;

      let score: number | null = null;
      if (haystack.startsWith(normalizedQuery)) score = 0;
      else if (haystack.includes(segmentNeedle)) score = 1;
      else if (haystack.includes(normalizedQuery)) score = 2;

      if (score === null) continue;

      considerCandidate(best, { index: idx, score }, index, remaining);
    }

    for (const candidate of best) {
      if (!addIndex(candidate.index)) {
        break;
      }
    }
  }

  return results;
}
