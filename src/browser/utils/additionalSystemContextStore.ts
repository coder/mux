import { useSyncExternalStore } from "react";

const contentByWorkspace = new Map<string, string>();
const subscribersByWorkspace = new Map<string, Set<() => void>>();

function getSubscribers(workspaceId: string): Set<() => void> {
  const existing = subscribersByWorkspace.get(workspaceId);
  if (existing) return existing;
  const created = new Set<() => void>();
  subscribersByWorkspace.set(workspaceId, created);
  return created;
}

export function readAdditionalSystemContextSnapshot(workspaceId: string): string {
  return contentByWorkspace.get(workspaceId) ?? "";
}

export function updateAdditionalSystemContextSnapshot(workspaceId: string, content: string): void {
  if (content.length === 0) {
    contentByWorkspace.delete(workspaceId);
  } else {
    contentByWorkspace.set(workspaceId, content);
  }

  for (const subscriber of getSubscribers(workspaceId)) {
    subscriber();
  }
}

export function subscribeAdditionalSystemContext(
  workspaceId: string,
  callback: () => void
): () => void {
  const subscribers = getSubscribers(workspaceId);
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0) {
      subscribersByWorkspace.delete(workspaceId);
    }
  };
}

export function useAdditionalSystemContextSnapshot(workspaceId: string): string {
  return useSyncExternalStore(
    (callback) => subscribeAdditionalSystemContext(workspaceId, callback),
    () => readAdditionalSystemContextSnapshot(workspaceId),
    () => ""
  );
}
