import { MutexMap } from "./mutexMap";

/**
 * Shared file operation lock for all workspace-related file services.
 *
 * Why this exists:
 * Workspace persistence paths (chat.jsonl + partial.json) can compose operations
 * that touch the same directory in different orders. Separate mutex instances can
 * deadlock when one operation needs to call into another while a lock is held.
 *
 * Solution:
 * All workspace file operations share this single MutexMap instance. This ensures:
 * - Only one file operation per workspace at a time across ALL services
 * - Nested calls within the same operation won't try to re-acquire the lock
 *   (MutexMap allows this by queuing operations)
 * - No deadlock from lock ordering issues
 *
 * Trade-off:
 * This is more conservative than separate locks (less concurrency) but guarantees
 * correctness. Since file operations are fast (ms range), the performance impact
 * is negligible compared to AI API calls (seconds range).
 */
export const workspaceFileLocks = new MutexMap<string>();
