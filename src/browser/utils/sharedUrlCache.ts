/**
 * LRU cache for persisting shared message URLs in localStorage.
 * Keys are content hashes, values are mux.md URLs with timestamps.
 * Evicts oldest entries when cache exceeds MAX_ENTRIES.
 */

import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";

const STORAGE_KEY = "sharedMessageUrls";
const MAX_ENTRIES = 1024;

interface CacheEntry {
  url: string;
  timestamp: number;
}

interface CacheData {
  entries: Record<string, CacheEntry>;
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
 * Get the cached URL for a message content, if it exists.
 */
export function getSharedUrl(content: string): string | undefined {
  const hash = hashContent(content);
  const cache = readPersistedState<CacheData>(STORAGE_KEY, { entries: {} });
  return cache.entries[hash]?.url;
}

/**
 * Store a shared URL for message content.
 * Uses LRU eviction when cache exceeds MAX_ENTRIES.
 */
export function setSharedUrl(content: string, url: string): void {
  const hash = hashContent(content);

  updatePersistedState<CacheData>(
    STORAGE_KEY,
    (prev) => {
      const entries = { ...prev.entries };

      // Add or update the entry
      entries[hash] = { url, timestamp: Date.now() };

      // Evict oldest entries if over limit
      const keys = Object.keys(entries);
      if (keys.length > MAX_ENTRIES) {
        // Sort by timestamp ascending (oldest first)
        keys.sort((a, b) => entries[a].timestamp - entries[b].timestamp);
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
