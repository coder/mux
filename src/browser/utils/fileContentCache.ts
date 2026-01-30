/**
 * LRU cache for file contents in localStorage.
 * Stores all content as base64 with per-entry storage keys and LRU eviction.
 */

import type { FileContentsResult } from "./fileExplorer";
import { createLRUCache } from "./lruCache";

/** @internal Exported for testing */
export const CACHE_CONFIG = {
  MAX_ENTRIES: 50,
  TTL_MS: 30 * 60 * 1000, // 30 minutes
};

/** Encode UTF-8 string to base64 */
function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const binString = Array.from(bytes, (b) => String.fromCodePoint(b)).join("");
  return btoa(binString);
}

/** Decode base64 to UTF-8 string */
function base64ToUtf8(base64: string): string {
  const binString = atob(base64);
  const bytes = Uint8Array.from(binString, (c) => c.codePointAt(0)!);
  return new TextDecoder().decode(bytes);
}

export interface CachedFileContent {
  /** File type */
  type: "text" | "image";
  /** Content stored as base64 */
  base64: string;
  /** MIME type for images */
  mimeType?: string;
  /** File size in bytes */
  size: number;
  /** Optional diff content */
  diff?: string | null;
}

/** Composite key for workspace + path */
function cacheKey(workspaceId: string, relativePath: string): string {
  return `${workspaceId}:${relativePath}`;
}

// LRU cache instance getter - recreated when config changes (for testing)
let _fileCache: ReturnType<typeof createLRUCache<CachedFileContent>> | null = null;
let _lastMaxEntries = 0;
let _lastTtlMs = 0;

function getFileCache() {
  // Recreate cache if config changed (supports test modifications)
  if (
    !_fileCache ||
    _lastMaxEntries !== CACHE_CONFIG.MAX_ENTRIES ||
    _lastTtlMs !== CACHE_CONFIG.TTL_MS
  ) {
    _lastMaxEntries = CACHE_CONFIG.MAX_ENTRIES;
    _lastTtlMs = CACHE_CONFIG.TTL_MS;
    _fileCache = createLRUCache<CachedFileContent>({
      entryPrefix: "explorer:file:",
      indexKey: "explorer:fileIndex",
      maxEntries: CACHE_CONFIG.MAX_ENTRIES,
      ttlMs: CACHE_CONFIG.TTL_MS,
    });
  }
  return _fileCache;
}

/**
 * Get the cached file content for a workspace/path.
 * Returns null if not found or expired.
 */
export function getCachedFileContent(
  workspaceId: string,
  relativePath: string
): (CachedFileContent & { cachedAt: number }) | null {
  const entry = getFileCache().getEntry(cacheKey(workspaceId, relativePath));
  if (!entry) return null;
  // Include cachedAt for API compatibility
  return { ...entry.data, cachedAt: entry.cachedAt };
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

  const entry: CachedFileContent = {
    type: data.type,
    base64: data.type === "image" ? data.base64 : utf8ToBase64(data.content),
    mimeType: data.type === "image" ? data.mimeType : undefined,
    size: data.size,
    diff,
  };

  getFileCache().set(cacheKey(workspaceId, relativePath), entry);
}

/**
 * Remove file content from cache (e.g., file deleted).
 */
export function removeCachedFileContent(workspaceId: string, relativePath: string): void {
  getFileCache().remove(cacheKey(workspaceId, relativePath));
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
    content: base64ToUtf8(cached.base64),
    size: cached.size,
  };
}
