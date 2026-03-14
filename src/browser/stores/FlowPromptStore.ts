import { useSyncExternalStore } from "react";
import type { APIClient } from "@/browser/contexts/API";
import type { FlowPromptState } from "@/common/orpc/types";
import { isAbortError } from "@/browser/utils/isAbortError";
import { MapStore } from "./MapStore";

const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 5000;

function createEmptyState(workspaceId: string): FlowPromptState {
  return {
    workspaceId,
    path: "",
    exists: false,
    hasNonEmptyContent: false,
    modifiedAtMs: null,
    contentFingerprint: null,
    lastEnqueuedFingerprint: null,
    isCurrentVersionEnqueued: false,
    hasPendingUpdate: false,
    autoSendMode: "off",
    nextHeadingContent: null,
    updatePreviewText: null,
  };
}

function areStatesEqual(a: FlowPromptState, b: FlowPromptState): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.path === b.path &&
    a.exists === b.exists &&
    a.hasNonEmptyContent === b.hasNonEmptyContent &&
    a.modifiedAtMs === b.modifiedAtMs &&
    a.contentFingerprint === b.contentFingerprint &&
    a.lastEnqueuedFingerprint === b.lastEnqueuedFingerprint &&
    a.isCurrentVersionEnqueued === b.isCurrentVersionEnqueued &&
    a.hasPendingUpdate === b.hasPendingUpdate &&
    a.autoSendMode === b.autoSendMode &&
    a.nextHeadingContent === b.nextHeadingContent &&
    a.updatePreviewText === b.updatePreviewText
  );
}

export class FlowPromptStore {
  private client: APIClient | null = null;
  private states = new MapStore<string, FlowPromptState>();
  private stateCache = new Map<string, FlowPromptState>();
  private subscriptions = new Map<
    string,
    { controller: AbortController; iterator: AsyncIterator<FlowPromptState> | null }
  >();
  private subscriptionCounts = new Map<string, number>();
  private retryAttempts = new Map<string, number>();
  private retryTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  setClient(client: APIClient | null): void {
    this.client = client;

    if (!client) {
      for (const subscription of this.subscriptions.values()) {
        subscription.controller.abort();
        void subscription.iterator?.return?.();
      }
      this.subscriptions.clear();
      for (const timeout of this.retryTimeouts.values()) {
        clearTimeout(timeout);
      }
      this.retryTimeouts.clear();
      this.retryAttempts.clear();
      return;
    }

    for (const workspaceId of this.subscriptionCounts.keys()) {
      this.ensureSubscribed(workspaceId);
    }
  }

  subscribe = (workspaceId: string, listener: () => void): (() => void) => {
    this.trackSubscription(workspaceId);
    const unsubscribe = this.states.subscribeKey(workspaceId, listener);
    return () => {
      unsubscribe();
      this.untrackSubscription(workspaceId);
    };
  };

  getState(workspaceId: string): FlowPromptState {
    return this.states.get(
      workspaceId,
      () => this.stateCache.get(workspaceId) ?? createEmptyState(workspaceId)
    );
  }

  private trackSubscription(workspaceId: string): void {
    const next = (this.subscriptionCounts.get(workspaceId) ?? 0) + 1;
    this.subscriptionCounts.set(workspaceId, next);
    if (next === 1) {
      this.ensureSubscribed(workspaceId);
    }
  }

  private untrackSubscription(workspaceId: string): void {
    const next = (this.subscriptionCounts.get(workspaceId) ?? 1) - 1;
    if (next > 0) {
      this.subscriptionCounts.set(workspaceId, next);
      return;
    }

    this.subscriptionCounts.delete(workspaceId);
    this.stopSubscription(workspaceId);
  }

  private stopSubscription(workspaceId: string): void {
    const subscription = this.subscriptions.get(workspaceId);
    if (subscription) {
      subscription.controller.abort();
      void subscription.iterator?.return?.();
      this.subscriptions.delete(workspaceId);
    }

    const retryTimeout = this.retryTimeouts.get(workspaceId);
    if (retryTimeout) {
      clearTimeout(retryTimeout);
      this.retryTimeouts.delete(workspaceId);
    }
    this.retryAttempts.delete(workspaceId);
    this.stateCache.delete(workspaceId);
    this.states.delete(workspaceId);
  }

  private scheduleRetry(workspaceId: string): void {
    if (this.retryTimeouts.has(workspaceId)) {
      return;
    }

    const attempt = this.retryAttempts.get(workspaceId) ?? 0;
    const delay = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
    this.retryAttempts.set(workspaceId, attempt + 1);

    const timeout = setTimeout(() => {
      this.retryTimeouts.delete(workspaceId);
      this.ensureSubscribed(workspaceId);
    }, delay);

    this.retryTimeouts.set(workspaceId, timeout);
  }

  private ensureSubscribed(workspaceId: string): void {
    const client = this.client;
    if (!client || this.subscriptions.has(workspaceId)) {
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;
    const subscription: {
      controller: AbortController;
      iterator: AsyncIterator<FlowPromptState> | null;
    } = {
      controller,
      iterator: null,
    };
    this.subscriptions.set(workspaceId, subscription);

    (async () => {
      try {
        const iterator = await client.workspace.flowPrompt.subscribe({ workspaceId }, { signal });
        if (signal.aborted || this.subscriptions.get(workspaceId) !== subscription) {
          void iterator.return?.();
          return;
        }

        subscription.iterator = iterator;

        for await (const state of iterator) {
          if (signal.aborted) {
            break;
          }

          const previous = this.stateCache.get(workspaceId) ?? createEmptyState(workspaceId);
          if (!areStatesEqual(previous, state)) {
            this.stateCache.set(workspaceId, state);
            this.states.bump(workspaceId);
          }
        }
      } catch (error) {
        if (!signal.aborted && !isAbortError(error)) {
          console.error("Failed to subscribe to Flow Prompting state:", error);
        }
      } finally {
        void subscription.iterator?.return?.();
        subscription.iterator = null;

        if (this.subscriptions.get(workspaceId) === subscription) {
          this.subscriptions.delete(workspaceId);
        }

        if (!signal.aborted && this.client && this.subscriptionCounts.has(workspaceId)) {
          this.scheduleRetry(workspaceId);
        }
      }
    })();
  }
}

let storeInstance: FlowPromptStore | null = null;

function getStoreInstance(): FlowPromptStore {
  storeInstance ??= new FlowPromptStore();
  return storeInstance;
}

export function useFlowPromptStoreRaw(): FlowPromptStore {
  return getStoreInstance();
}

export function useFlowPromptState(workspaceId: string | undefined): FlowPromptState | null {
  const store = getStoreInstance();
  return useSyncExternalStore(
    (listener) => (workspaceId ? store.subscribe(workspaceId, listener) : () => undefined),
    () => (workspaceId ? store.getState(workspaceId) : null)
  );
}
