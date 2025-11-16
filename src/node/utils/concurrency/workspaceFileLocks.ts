import { MutexMap } from "./mutexMap";

/**
 * Shared file operation lock for all workspace-related file services.
 *
 * Why this exists:
 * Multiple services (HistoryService, PartialService) operate on files within
 * the same workspace directory. When these services call each other while holding
 * locks, separate mutex instances can cause deadlock:
 *
 * Deadlock scenario with separate locks:
 * 1. PartialService.commitToHistory() acquires partialService.fileLocks[workspace]
 * 2. Inside commitToHistory, calls historyService.updateHistory()
 * 3. historyService.updateHistory() tries to acquire historyService.fileLocks[workspace]
 * 4. If another operation holds historyService.fileLocks and tries to acquire
 *    partialService.fileLocks → DEADLOCK
 *
 * Solution:
 * All workspace file services share this single MutexMap instance. This ensures:
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
