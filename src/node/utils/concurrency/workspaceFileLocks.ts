import type { Config } from "@/node/config";
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
 * - Only one file operation per workspace session dir at a time across ALL services
 * - Nested calls within the same operation won't try to re-acquire the lock
 *   (MutexMap allows this by queuing operations)
 * - No deadlock from lock ordering issues
 *
 * NOTE:
 * Lock keys are derived from workspace session directory paths (not bare workspace IDs)
 * so independent MUX_ROOTs don't contend on fixed IDs like "mux-chat" during tests.
 *
 * Trade-off:
 * This is more conservative than separate locks (less concurrency) but guarantees
 * correctness. Since file operations are fast (ms range), the performance impact
 * is negligible compared to AI API calls (seconds range).
 */
export const workspaceFileLocks = new MutexMap<string>();

/**
 * Create a lock key for a workspace's session directory.
 *
 * We scope locks to the session dir path so separate mux roots can operate
 * concurrently even when they share a workspace ID.
 */
export function getWorkspaceFileLockKey(
  config: Pick<Config, "getSessionDir">,
  workspaceId: string
): string {
  return getWorkspaceFileLockKeyFromSessionDir(config.getSessionDir(workspaceId));
}

export function getWorkspaceFileLockKeyFromSessionDir(sessionDir: string): string {
  return sessionDir;
}
