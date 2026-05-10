import type { APIClient } from "@/browser/contexts/API";
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

interface SaveCallbacks {
  onError?: (error: unknown) => void;
  onIdle?: () => void;
}

interface SaveState {
  inFlight: boolean;
  pending: string | null;
  callbacks: Set<SaveCallbacks>;
}

const saveStateByWorkspace = new Map<string, SaveState>();

function getSaveState(workspaceId: string): SaveState {
  const existing = saveStateByWorkspace.get(workspaceId);
  if (existing) return existing;
  const created: SaveState = { inFlight: false, pending: null, callbacks: new Set() };
  saveStateByWorkspace.set(workspaceId, created);
  return created;
}

function notifySaveError(state: SaveState, error: unknown): void {
  for (const callbacks of state.callbacks) {
    callbacks.onError?.(error);
  }
}

function notifySaveIdle(state: SaveState): void {
  for (const callbacks of state.callbacks) {
    callbacks.onIdle?.();
  }
  state.callbacks.clear();
}

function flushAdditionalSystemContextSave(api: APIClient, workspaceId: string): void {
  const state = getSaveState(workspaceId);
  if (state.inFlight) return;
  const next = state.pending;
  if (next == null) return;

  state.pending = null;
  state.inFlight = true;

  api.workspace
    .setAdditionalSystemContext({ workspaceId, content: next })
    .then((result) => updateAdditionalSystemContextSnapshot(workspaceId, result.content))
    .catch((error) => notifySaveError(state, error))
    .finally(() => {
      state.inFlight = false;
      if (state.pending == null) {
        notifySaveIdle(state);
        return;
      }
      flushAdditionalSystemContextSave(api, workspaceId);
    });
}

export function queueAdditionalSystemContextSave(
  api: APIClient,
  workspaceId: string,
  content: string,
  callbacks?: SaveCallbacks
): void {
  const state = getSaveState(workspaceId);
  if (callbacks) {
    state.callbacks.add(callbacks);
  }
  state.pending = content;
  flushAdditionalSystemContextSave(api, workspaceId);
}

export function useAdditionalSystemContextSnapshot(workspaceId: string): string {
  return useSyncExternalStore(
    (callback) => subscribeAdditionalSystemContext(workspaceId, callback),
    () => readAdditionalSystemContextSnapshot(workspaceId),
    () => ""
  );
}
