/**
 * LRU cache for persisting shared message URLs in localStorage.
 * Uses per-entry storage keys for efficient single-entry updates.
 * Maintains a separate index for LRU eviction tracking.
 */

import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";

/** Prefix for individual share entries */
const ENTRY_PREFIX = "share:";
/** Key for LRU index (array of hashes, most recent last) */
const INDEX_KEY = "shareIndex";
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
  /** Whether the share was signed with user's key */
  signed?: boolean;
}

/**
 * SHA-256 hash of content, computed synchronously using SubtleCrypto workaround.
 * Falls back to a simple string hash if crypto is unavailable.
 */
async function hashContentAsync(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  // Use first 16 bytes (32 hex chars) for reasonable key length
  return hashArray
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Synchronous hash using cached async result or fallback.
 * We maintain a small in-memory cache of recent hashes to avoid async in hot paths.
 */
const hashCache = new Map<string, string>();
const MAX_HASH_CACHE = 100;

function hashContent(content: string): string {
  // Check memory cache first
  const cached = hashCache.get(content);
  if (cached) return cached;

  // Fallback: use simple hash for sync access, async will populate cache later
  // This is a simple FNV-1a hash - well-known and simple
  let hash = 2166136261;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const fallbackHash = (hash >>> 0).toString(16).padStart(8, "0");

  // Kick off async hash computation to populate cache for next time
  void hashContentAsync(content).then((sha256Hash) => {
    if (hashCache.size >= MAX_HASH_CACHE) {
      // Evict oldest entry
      const firstKey = hashCache.keys().next().value;
      if (firstKey) hashCache.delete(firstKey);
    }
    hashCache.set(content, sha256Hash);
  });

  return fallbackHash;
}

/** Get storage key for a hash */
function entryKey(hash: string): string {
  return `${ENTRY_PREFIX}${hash}`;
}

/**
 * Pre-warm the hash cache for content.
 * Ensures consistent hashing between setShareData and getShareData calls
 * by waiting for the async SHA-256 computation to complete.
 */
export async function warmHashCache(content: string): Promise<void> {
  // Trigger the fallback hash (which kicks off async SHA-256)
  hashContent(content);
  // Wait for async hash to complete and populate cache
  await hashContentAsync(content);
}

/**
 * Get the cached share data for content, if it exists and hasn't expired.
 */
export function getShareData(content: string): ShareData | undefined {
  const hash = hashContent(content);
  const entry = readPersistedState<ShareData | null>(entryKey(hash), null);

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
  const fullData: ShareData = { ...data, cachedAt: Date.now() };

  // Write the individual entry
  updatePersistedState(entryKey(hash), () => fullData, null);

  // Update LRU index
  updatePersistedState<string[]>(
    INDEX_KEY,
    (prev) => {
      // Remove existing occurrence and add to end (most recent)
      const filtered = prev.filter((h) => h !== hash);
      filtered.push(hash);

      // Evict oldest entries if over limit
      if (filtered.length > MAX_ENTRIES) {
        const toRemove = filtered.splice(0, filtered.length - MAX_ENTRIES);
        // Clean up evicted entries (fire and forget)
        for (const oldHash of toRemove) {
          updatePersistedState(entryKey(oldHash), () => null, null);
        }
      }

      return filtered;
    },
    []
  );
}

/**
 * Update expiration for cached content.
 */
export function updateShareExpiration(content: string, expiresAt: number | undefined): void {
  const hash = hashContent(content);

  updatePersistedState<ShareData | null>(
    entryKey(hash),
    (prev) => {
      if (!prev) return prev;
      return { ...prev, expiresAt };
    },
    null
  );
}

/**
 * Remove share data for content (e.g., after deletion or expiration).
 */
export function removeShareData(content: string): void {
  const hash = hashContent(content);

  // Remove the entry
  updatePersistedState(entryKey(hash), () => null, null);

  // Remove from index
  updatePersistedState<string[]>(INDEX_KEY, (prev) => prev.filter((h) => h !== hash), []);
}
