/**
 * Generic LRU cache backed by localStorage.
 *
 * Uses per-entry storage keys for efficient single-entry updates,
 * and a separate index array for LRU eviction tracking.
 *
 * Pattern extracted from fileContentCache.ts and sharedUrlCache.ts.
 */

import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";

export interface LRUCacheOptions {
  /** Prefix for individual entry keys (e.g., "prStatus:") */
  entryPrefix: string;
  /** Key for the LRU index array */
  indexKey: string;
  /** Maximum entries before eviction (default: 50) */
  maxEntries?: number;
  /** TTL in ms (optional, entries don't expire if not set) */
  ttlMs?: number;
}

export interface LRUCacheEntry<T> {
  data: T;
  cachedAt: number;
}

export interface LRUCache<T> {
  /** Get cached value, or null if not found/expired */
  get(key: string): T | null;
  /** Get the full entry with metadata, or null if not found/expired */
  getEntry(key: string): LRUCacheEntry<T> | null;
  /** Store a value in the cache */
  set(key: string, data: T): void;
  /** Update an existing entry without changing LRU order. Returns false if entry doesn't exist. */
  update(key: string, updater: (data: T) => T): boolean;
  /** Remove a value from the cache */
  remove(key: string): void;
}

/**
 * Create an LRU cache backed by localStorage.
 *
 * @example
 * ```ts
 * const cache = createLRUCache<{ name: string }>({
 *   entryPrefix: "user:",
 *   indexKey: "userIndex",
 *   maxEntries: 100,
 *   ttlMs: 60 * 60 * 1000, // 1 hour
 * });
 *
 * cache.set("123", { name: "Alice" });
 * const user = cache.get("123"); // { name: "Alice" }
 * ```
 */
export function createLRUCache<T>(options: LRUCacheOptions): LRUCache<T> {
  const { entryPrefix, indexKey, maxEntries = 50, ttlMs } = options;

  function fullKey(key: string): string {
    return `${entryPrefix}${key}`;
  }

  function getEntry(key: string): LRUCacheEntry<T> | null {
    const entry = readPersistedState<LRUCacheEntry<T> | null>(fullKey(key), null);
    if (!entry) return null;

    // Check TTL if configured
    if (ttlMs && Date.now() - entry.cachedAt > ttlMs) {
      remove(key);
      return null;
    }

    return entry;
  }

  function get(key: string): T | null {
    return getEntry(key)?.data ?? null;
  }

  function set(key: string, data: T): void {
    const fk = fullKey(key);
    const entry: LRUCacheEntry<T> = { data, cachedAt: Date.now() };

    updatePersistedState(fk, () => entry, null);

    // Update LRU index
    updatePersistedState<string[]>(
      indexKey,
      (prev) => {
        // Remove existing occurrence and add to end (most recent)
        const filtered = prev.filter((k) => k !== fk);
        filtered.push(fk);

        // Evict oldest entries if over limit
        if (filtered.length > maxEntries) {
          const toRemove = filtered.splice(0, filtered.length - maxEntries);
          for (const oldKey of toRemove) {
            updatePersistedState(oldKey, () => null, null);
          }
        }

        return filtered;
      },
      []
    );
  }

  function update(key: string, updater: (data: T) => T): boolean {
    const entry = getEntry(key);
    if (!entry) return false;

    const fk = fullKey(key);
    const updated: LRUCacheEntry<T> = { data: updater(entry.data), cachedAt: entry.cachedAt };
    updatePersistedState(fk, () => updated, null);
    return true;
  }

  function remove(key: string): void {
    const fk = fullKey(key);
    updatePersistedState(fk, () => null, null);
    updatePersistedState<string[]>(indexKey, (prev) => prev.filter((k) => k !== fk), []);
  }

  return { get, getEntry, set, update, remove };
}
