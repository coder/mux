import { useSyncExternalStore } from "react";
import type { APIClient } from "@/browser/contexts/API";

/**
 * Per-workspace cache of the instruction-file count surfaced in the right-sidebar
 * tab strip.
 *
 * The Instructions panel already fetches the full `WorkspaceInstructions` payload
 * when it renders, but the tab label needs the count even when the panel is not
 * mounted (e.g. another tab is active in the same tabset). This tiny store lets
 * the label trigger a single `getInstructions` IPC on first observation and
 * stay in sync with the panel's own fetches afterwards.
 */

const fileCountByWorkspace = new Map<string, number>();
const inFlightByWorkspace = new Map<string, Promise<void>>();
const subscribersByWorkspace = new Map<string, Set<() => void>>();

function getSubscribers(workspaceId: string): Set<() => void> {
  const existing = subscribersByWorkspace.get(workspaceId);
  if (existing) return existing;
  const created = new Set<() => void>();
  subscribersByWorkspace.set(workspaceId, created);
  return created;
}

function notify(workspaceId: string): void {
  const subscribers = subscribersByWorkspace.get(workspaceId);
  if (!subscribers) return;
  for (const callback of subscribers) callback();
}

export function getWorkspaceInstructionsFileCount(workspaceId: string): number | null {
  return fileCountByWorkspace.has(workspaceId)
    ? (fileCountByWorkspace.get(workspaceId) ?? null)
    : null;
}

export function setWorkspaceInstructionsFileCount(workspaceId: string, count: number): void {
  const previous = fileCountByWorkspace.get(workspaceId);
  if (previous === count) return;
  fileCountByWorkspace.set(workspaceId, count);
  notify(workspaceId);
}

export function subscribeWorkspaceInstructions(
  workspaceId: string,
  callback: () => void
): () => void {
  const subscribers = getSubscribers(workspaceId);
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0) subscribersByWorkspace.delete(workspaceId);
  };
}

/**
 * Trigger a one-shot `getInstructions` fetch when the file count is unknown.
 * No-op if the count is already cached or a fetch is already in flight.
 */
export function ensureWorkspaceInstructionsFetched(api: APIClient, workspaceId: string): void {
  if (fileCountByWorkspace.has(workspaceId)) return;
  if (inFlightByWorkspace.has(workspaceId)) return;
  const promise = api.workspace
    .getInstructions({ workspaceId })
    .then((result) => {
      setWorkspaceInstructionsFileCount(workspaceId, result.files.length);
    })
    .catch(() => {
      // Swallow: the panel surfaces fetch errors. Keep the badge silent.
    })
    .finally(() => {
      inFlightByWorkspace.delete(workspaceId);
    });
  inFlightByWorkspace.set(workspaceId, promise);
}

export function useWorkspaceInstructionsFileCount(workspaceId: string): number | null {
  return useSyncExternalStore(
    (callback) => subscribeWorkspaceInstructions(workspaceId, callback),
    () => getWorkspaceInstructionsFileCount(workspaceId),
    () => null
  );
}
