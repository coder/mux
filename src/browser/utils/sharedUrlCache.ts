/**
 * LRU cache for persisting shared message URLs in localStorage.
 * Keys are content hashes, values are mux.md share data with timestamps.
 * Evicts oldest entries when cache exceeds MAX_ENTRIES.
 */

import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";

const STORAGE_KEY = "sharedMessageUrls";
const MAX_ENTRIES = 1024;

export interface ShareData {
  /** Full URL with encryption key in fragment */
  url: string;
  /** File ID */
  id: string;
  /** Mutate key for delete/update operations */
  mutateKey: string;
  /** Expiration timestamp (ms), if set */
  expiresAt?: number;
  /** When this entry was cached (for LRU eviction) */
  cachedAt: number;
}

interface CacheData {
  entries: Record<string, ShareData>;
}

/**
 * Simple hash function for content strings.
 * Uses DJB2 algorithm - fast and produces good distribution.
 */
function hashContent(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = (hash * 33) ^ content.charCodeAt(i);
  }
  // Convert to unsigned 32-bit and then to hex string
  return (hash >>> 0).toString(16);
}

/**
 * Get the cached share data for content, if it exists and hasn't expired.
 */
export function getShareData(content: string): ShareData | undefined {
  const hash = hashContent(content);
  const cache = readPersistedState<CacheData>(STORAGE_KEY, { entries: {} });
  const entry = cache.entries[hash];

  if (!entry) return undefined;

  // Check if expired
  if (entry.expiresAt && entry.expiresAt < Date.now()) {
    // Entry has expired - remove it from cache
    removeShareData(content);
    return undefined;
  }

  return entry;
}

/**
 * Get the cached URL for content (convenience wrapper).
 */
export function getSharedUrl(content: string): string | undefined {
  return getShareData(content)?.url;
}

/**
 * Store share data for message content.
 * Uses LRU eviction when cache exceeds MAX_ENTRIES.
 */
export function setShareData(content: string, data: Omit<ShareData, "cachedAt">): void {
  const hash = hashContent(content);

  updatePersistedState<CacheData>(
    STORAGE_KEY,
    (prev) => {
      const entries = { ...prev.entries };

      // Add or update the entry
      entries[hash] = { ...data, cachedAt: Date.now() };

      // Evict oldest entries if over limit
      const keys = Object.keys(entries);
      if (keys.length > MAX_ENTRIES) {
        // Sort by cachedAt ascending (oldest first)
        keys.sort((a, b) => entries[a].cachedAt - entries[b].cachedAt);
        // Remove oldest entries to get back to MAX_ENTRIES
        const toRemove = keys.slice(0, keys.length - MAX_ENTRIES);
        for (const key of toRemove) {
          delete entries[key];
        }
      }

      return { entries };
    },
    { entries: {} }
  );
}

/**
 * Update expiration for cached content.
 */
export function updateShareExpiration(content: string, expiresAt: number | undefined): void {
  const hash = hashContent(content);

  updatePersistedState<CacheData>(
    STORAGE_KEY,
    (prev) => {
      const entry = prev.entries[hash];
      if (!entry) return prev;

      return {
        entries: {
          ...prev.entries,
          [hash]: { ...entry, expiresAt },
        },
      };
    },
    { entries: {} }
  );
}

/**
 * Remove share data for content (e.g., after deletion or expiration).
 */
export function removeShareData(content: string): void {
  const hash = hashContent(content);

  updatePersistedState<CacheData>(
    STORAGE_KEY,
    (prev) => {
      const entries = { ...prev.entries };
      delete entries[hash];
      return { entries };
    },
    { entries: {} }
  );
}

/**
 * Legacy wrapper for backwards compatibility.
 * @deprecated Use setShareData instead
 */
export function setSharedUrl(
  content: string,
  url: string,
  extra?: { id: string; mutateKey: string; expiresAt?: number }
): void {
  if (extra) {
    setShareData(content, { url, ...extra });
  } else {
    // Minimal entry (won't support delete/update but preserves old behavior)
    setShareData(content, { url, id: "", mutateKey: "" });
  }
}
