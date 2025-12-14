/**
 * In-memory caches for the Code Review panel.
 *
 * Motivation: switching workspaces can trigger expensive git diff/numstat calls.
 * We keep the most recent results in an LRU so returning to a workspace is instant.
 *
 * Refresh semantics:
 * - Cache entries are updated on successful loads.
 * - Consumers can bypass the cache on manual refresh (Ctrl/Cmd+R).
 */

import { LRUCache } from "lru-cache";
import type { DiffHunk } from "@/common/types/review";
import type { FileTreeNode } from "@/common/utils/git/numstatParser";

export interface ReviewPanelDiagnosticInfo {
  command: string;
  outputLength: number;
  fileDiffCount: number;
  hunkCount: number;
}

export interface ReviewPanelDiffCacheValue {
  hunks: DiffHunk[];
  truncationWarning: string | null;
  diagnosticInfo: ReviewPanelDiagnosticInfo | null;
}

export interface ReviewPanelFileTreeCacheValue {
  fileTree: FileTreeNode;
}

interface CacheEntry<T> {
  value: T;
  cachedAt: number;
}

function estimateHunksSizeBytes(hunks: DiffHunk[]): number {
  // Rough bytes for JS strings (UTF-16) + a small constant per object.
  let bytes = hunks.length * 64;
  for (const hunk of hunks) {
    bytes +=
      (hunk.id.length +
        hunk.filePath.length +
        hunk.content.length +
        hunk.header.length +
        (hunk.oldPath?.length ?? 0) +
        (hunk.changeType?.length ?? 0)) *
      2;
  }
  return bytes;
}

function estimateFileTreeSizeBytes(node: FileTreeNode): number {
  // Rough bytes for JS strings + a constant per node.
  let bytes = 64 + (node.name.length + node.path.length) * 2;
  if (node.stats) {
    bytes += node.stats.filePath.length * 2;
  }
  if (node.totalStats) {
    bytes += node.totalStats.filePath.length * 2;
  }
  for (const child of node.children) {
    bytes += estimateFileTreeSizeBytes(child);
  }
  return bytes;
}

const DIFF_CACHE_MAX_SIZE_BYTES = 16 * 1024 * 1024; // 16MB
const FILE_TREE_CACHE_MAX_SIZE_BYTES = 4 * 1024 * 1024; // 4MB

const diffCache = new LRUCache<string, CacheEntry<ReviewPanelDiffCacheValue>>({
  max: 25,
  maxSize: DIFF_CACHE_MAX_SIZE_BYTES,
  sizeCalculation: (entry) => estimateHunksSizeBytes(entry.value.hunks),
});

const fileTreeCache = new LRUCache<string, CacheEntry<ReviewPanelFileTreeCacheValue>>({
  max: 25,
  maxSize: FILE_TREE_CACHE_MAX_SIZE_BYTES,
  sizeCalculation: (entry) => estimateFileTreeSizeBytes(entry.value.fileTree),
});

const inFlightDiffLoads = new Map<string, Promise<ReviewPanelDiffCacheValue>>();
const inFlightFileTreeLoads = new Map<string, Promise<ReviewPanelFileTreeCacheValue>>();

export function makeReviewDiffCacheKey(params: {
  workspaceId: string;
  workspacePath: string;
  diffBase: string;
  includeUncommitted: boolean;
  selectedFilePath: string | null;
}): string {
  // Use a null byte separator to avoid accidental collisions.
  return [
    "review-panel-diff:v1",
    params.workspaceId,
    params.workspacePath,
    params.diffBase,
    params.includeUncommitted ? "1" : "0",
    params.selectedFilePath ?? "",
  ].join("\u0000");
}

export function makeReviewFileTreeCacheKey(params: {
  workspaceId: string;
  workspacePath: string;
  diffBase: string;
  includeUncommitted: boolean;
}): string {
  return [
    "review-panel-tree:v1",
    params.workspaceId,
    params.workspacePath,
    params.diffBase,
    params.includeUncommitted ? "1" : "0",
  ].join("\u0000");
}

export function getCachedReviewDiff(key: string): ReviewPanelDiffCacheValue | null {
  return diffCache.get(key)?.value ?? null;
}

export function setCachedReviewDiff(key: string, value: ReviewPanelDiffCacheValue): void {
  diffCache.set(key, { value, cachedAt: Date.now() });
}

export function getCachedReviewFileTree(key: string): ReviewPanelFileTreeCacheValue | null {
  return fileTreeCache.get(key)?.value ?? null;
}

export function setCachedReviewFileTree(key: string, value: ReviewPanelFileTreeCacheValue): void {
  fileTreeCache.set(key, { value, cachedAt: Date.now() });
}

export function getInFlightReviewDiff(key: string): Promise<ReviewPanelDiffCacheValue> | null {
  return inFlightDiffLoads.get(key) ?? null;
}

export function setInFlightReviewDiff(
  key: string,
  promise: Promise<ReviewPanelDiffCacheValue>
): void {
  inFlightDiffLoads.set(key, promise);
  void promise.finally(() => {
    if (inFlightDiffLoads.get(key) === promise) {
      inFlightDiffLoads.delete(key);
    }
  });
}

export function getInFlightReviewFileTree(
  key: string
): Promise<ReviewPanelFileTreeCacheValue> | null {
  return inFlightFileTreeLoads.get(key) ?? null;
}

export function setInFlightReviewFileTree(
  key: string,
  promise: Promise<ReviewPanelFileTreeCacheValue>
): void {
  inFlightFileTreeLoads.set(key, promise);
  void promise.finally(() => {
    if (inFlightFileTreeLoads.get(key) === promise) {
      inFlightFileTreeLoads.delete(key);
    }
  });
}

/** For tests / debugging. */
export function clearReviewPanelCaches(): void {
  diffCache.clear();
  fileTreeCache.clear();
  inFlightDiffLoads.clear();
  inFlightFileTreeLoads.clear();
}
