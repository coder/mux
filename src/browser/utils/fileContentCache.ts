/**
 * LRU cache for file contents in localStorage.
 * Stores text files as base64, images as base64 with mimeType.
 * Uses per-entry storage keys with a separate index for LRU eviction.
 */

import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import type { FileContentsResult } from "./fileExplorer";

/** Prefix for individual file entries */
const ENTRY_PREFIX = "explorer:file:";
/** Key for LRU index (array of cache keys, most recent last) */
const INDEX_KEY = "explorer:fileIndex";

/** @internal Exported for testing */
export const CACHE_CONFIG = {
  MAX_ENTRIES: 50,
  TTL_MS: 30 * 60 * 1000, // 30 minutes
};

export interface CachedFileContent {
  /** File type */
  type: "text" | "image";
  /** Content stored as base64 */
  base64: string;
  /** Original text content (for text files only, for cheap comparison) */
  textContent?: string;
  /** MIME type for images */
  mimeType?: string;
  /** File size in bytes */
  size: number;
  /** When this entry was cached */
  cachedAt: number;
  /** Optional diff content */
  diff?: string | null;
}

/** Get storage key for a workspace/path */
function entryKey(workspaceId: string, relativePath: string): string {
  return `${ENTRY_PREFIX}${workspaceId}:${relativePath}`;
}

/**
 * Get the cached file content for a workspace/path.
 * Returns null if not found or expired.
 */
export function getCachedFileContent(
  workspaceId: string,
  relativePath: string
): CachedFileContent | null {
  const key = entryKey(workspaceId, relativePath);
  const entry = readPersistedState<CachedFileContent | null>(key, null);

  if (!entry) return null;

  // Check if expired
  if (Date.now() - entry.cachedAt > CACHE_CONFIG.TTL_MS) {
    removeCachedFileContent(workspaceId, relativePath);
    return null;
  }

  return entry;
}

/**
 * Store file content in cache.
 * Uses LRU eviction when cache exceeds MAX_ENTRIES.
 */
export function setCachedFileContent(
  workspaceId: string,
  relativePath: string,
  data: FileContentsResult,
  diff: string | null
): void {
  // Don't cache error results
  if (data.type === "error") return;

  const key = entryKey(workspaceId, relativePath);

  const entry: CachedFileContent = {
    type: data.type,
    base64: data.type === "image" ? data.base64 : btoa(data.content),
    textContent: data.type === "text" ? data.content : undefined,
    mimeType: data.type === "image" ? data.mimeType : undefined,
    size: data.size,
    cachedAt: Date.now(),
    diff,
  };

  // Write the individual entry
  updatePersistedState(key, () => entry, null);

  // Update LRU index
  updatePersistedState<string[]>(
    INDEX_KEY,
    (prev) => {
      // Remove existing occurrence and add to end (most recent)
      const filtered = prev.filter((k) => k !== key);
      filtered.push(key);

      // Evict oldest entries if over limit
      if (filtered.length > CACHE_CONFIG.MAX_ENTRIES) {
        const toRemove = filtered.splice(0, filtered.length - CACHE_CONFIG.MAX_ENTRIES);
        // Clean up evicted entries
        for (const oldKey of toRemove) {
          updatePersistedState(oldKey, () => null, null);
        }
      }

      return filtered;
    },
    []
  );
}

/**
 * Remove file content from cache (e.g., file deleted).
 */
export function removeCachedFileContent(workspaceId: string, relativePath: string): void {
  const key = entryKey(workspaceId, relativePath);

  // Remove the entry
  updatePersistedState(key, () => null, null);

  // Remove from index
  updatePersistedState<string[]>(INDEX_KEY, (prev) => prev.filter((k) => k !== key), []);
}

/**
 * Convert cached content back to FileContentsResult.
 */
export function cacheToResult(cached: CachedFileContent): FileContentsResult {
  if (cached.type === "image") {
    return {
      type: "image",
      base64: cached.base64,
      mimeType: cached.mimeType ?? "application/octet-stream",
      size: cached.size,
    };
  }

  return {
    type: "text",
    content: cached.textContent ?? atob(cached.base64),
    size: cached.size,
  };
}
