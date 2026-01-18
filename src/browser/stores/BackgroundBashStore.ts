import { useSyncExternalStore } from "react";
import type { APIClient } from "@/browser/contexts/API";
import type { BackgroundProcessInfo } from "@/common/orpc/schemas/api";
import { MapStore } from "./MapStore";

const EMPTY_SET = new Set<string>();
const EMPTY_PROCESSES: BackgroundProcessInfo[] = [];

function areProcessesEqual(a: BackgroundProcessInfo[], b: BackgroundProcessInfo[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((proc, index) => {
    const other = b[index];
    return (
      proc.id === other.id &&
      proc.pid === other.pid &&
      proc.script === other.script &&
      proc.displayName === other.displayName &&
      proc.startTime === other.startTime &&
      proc.status === other.status &&
      proc.exitCode === other.exitCode
    );
  });
}

function areSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

export class BackgroundBashStore {
  private client: APIClient | null = null;
  private processesStore = new MapStore<string, BackgroundProcessInfo[]>();
  private foregroundIdsStore = new MapStore<string, Set<string>>();
  private terminatingIdsStore = new MapStore<string, Set<string>>();

  private processesCache = new Map<string, BackgroundProcessInfo[]>();
  private autoBackgroundFetches = new Map<string, Promise<void>>();
  private foregroundIdsCache = new Map<string, Set<string>>();
  private terminatingIdsCache = new Map<string, Set<string>>();

  private subscriptions = new Map<string, AbortController>();
  private subscriptionCounts = new Map<string, number>();

  setClient(client: APIClient | null): void {
    this.client = client;
    if (!client) return;

    for (const workspaceId of this.subscriptionCounts.keys()) {
      this.ensureSubscribed(workspaceId);
    }
  }

  subscribeProcesses = (workspaceId: string, listener: () => void): (() => void) => {
    this.trackSubscription(workspaceId);
    const unsubscribe = this.processesStore.subscribeKey(workspaceId, listener);
    return () => {
      unsubscribe();
      this.untrackSubscription(workspaceId);
    };
  };

  subscribeForegroundIds = (workspaceId: string, listener: () => void): (() => void) => {
    this.trackSubscription(workspaceId);
    const unsubscribe = this.foregroundIdsStore.subscribeKey(workspaceId, listener);
    return () => {
      unsubscribe();
      this.untrackSubscription(workspaceId);
    };
  };

  subscribeTerminatingIds = (workspaceId: string, listener: () => void): (() => void) => {
    this.trackSubscription(workspaceId);
    const unsubscribe = this.terminatingIdsStore.subscribeKey(workspaceId, listener);
    return () => {
      unsubscribe();
      this.untrackSubscription(workspaceId);
    };
  };

  getProcesses(workspaceId: string): BackgroundProcessInfo[] {
    return this.processesStore.get(
      workspaceId,
      () => this.processesCache.get(workspaceId) ?? EMPTY_PROCESSES
    );
  }

  getForegroundIds(workspaceId: string): Set<string> {
    return this.foregroundIdsStore.get(
      workspaceId,
      () => this.foregroundIdsCache.get(workspaceId) ?? EMPTY_SET
    );
  }

  getTerminatingIds(workspaceId: string): Set<string> {
    return this.terminatingIdsStore.get(
      workspaceId,
      () => this.terminatingIdsCache.get(workspaceId) ?? EMPTY_SET
    );
  }

  async terminate(workspaceId: string, processId: string): Promise<void> {
    if (!this.client) {
      throw new Error("API not available");
    }

    this.markTerminating(workspaceId, processId);

    try {
      const result = await this.client.workspace.backgroundBashes.terminate({
        workspaceId,
        processId,
      });

      if (!result.success) {
        this.clearTerminating(workspaceId, processId);
        throw new Error(result.error);
      }
    } catch (error) {
      this.clearTerminating(workspaceId, processId);
      throw error;
    }
  }

  async sendToBackground(workspaceId: string, toolCallId: string): Promise<void> {
    if (!this.client) {
      throw new Error("API not available");
    }

    const result = await this.client.workspace.backgroundBashes.sendToBackground({
      workspaceId,
      toolCallId,
    });

    if (!result.success) {
      throw new Error(result.error);
    }
  }

  autoBackgroundOnSend(workspaceId: string): void {
    const foregroundIds = this.foregroundIdsCache.get(workspaceId);
    if (foregroundIds && foregroundIds.size > 0) {
      for (const toolCallId of foregroundIds) {
        this.sendToBackground(workspaceId, toolCallId).catch(() => {
          // Ignore failures - bash may have completed before the request.
        });
      }
      return;
    }

    void this.fetchForegroundIdsForAutoBackground(workspaceId);
  }

  private fetchForegroundIdsForAutoBackground(workspaceId: string): Promise<void> {
    const existing = this.autoBackgroundFetches.get(workspaceId);
    if (existing) {
      return existing;
    }

    const client = this.client;
    if (!client) {
      return Promise.resolve();
    }

    const controller = new AbortController();
    const { signal } = controller;

    const task = (async () => {
      try {
        const iterator = await client.workspace.backgroundBashes.subscribe(
          { workspaceId },
          { signal }
        );

        for await (const state of iterator) {
          controller.abort();

          const latestForegroundIds = new Set(state.foregroundToolCallIds);
          this.foregroundIdsCache.set(workspaceId, latestForegroundIds);

          if (latestForegroundIds.size === 0) {
            return;
          }

          for (const toolCallId of latestForegroundIds) {
            this.sendToBackground(workspaceId, toolCallId).catch(() => {
              // Ignore failures - bash may have completed before the request.
            });
          }
          return;
        }
      } catch (err) {
        if (!signal.aborted) {
          console.error("Failed to read foreground bash state:", err);
        }
      } finally {
        this.autoBackgroundFetches.delete(workspaceId);
      }
    })();

    this.autoBackgroundFetches.set(workspaceId, task);
    return task;
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
    const controller = this.subscriptions.get(workspaceId);
    if (controller) {
      controller.abort();
      this.subscriptions.delete(workspaceId);
    }

    this.processesCache.delete(workspaceId);
    this.foregroundIdsCache.delete(workspaceId);
    this.terminatingIdsCache.delete(workspaceId);
    this.processesStore.delete(workspaceId);
    this.foregroundIdsStore.delete(workspaceId);
    this.terminatingIdsStore.delete(workspaceId);
  }

  private ensureSubscribed(workspaceId: string): void {
    const client = this.client;
    if (!client || this.subscriptions.has(workspaceId)) {
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;
    this.subscriptions.set(workspaceId, controller);

    (async () => {
      try {
        const iterator = await client.workspace.backgroundBashes.subscribe(
          { workspaceId },
          { signal }
        );

        for await (const state of iterator) {
          if (signal.aborted) break;

          const previousProcesses = this.processesCache.get(workspaceId) ?? EMPTY_PROCESSES;
          if (!areProcessesEqual(previousProcesses, state.processes)) {
            this.processesCache.set(workspaceId, state.processes);
            this.processesStore.bump(workspaceId);
          }

          const nextForeground = new Set(state.foregroundToolCallIds);
          const previousForeground = this.foregroundIdsCache.get(workspaceId) ?? EMPTY_SET;
          if (!areSetsEqual(previousForeground, nextForeground)) {
            this.foregroundIdsCache.set(workspaceId, nextForeground);
            this.foregroundIdsStore.bump(workspaceId);
          }

          const previousTerminating = this.terminatingIdsCache.get(workspaceId) ?? EMPTY_SET;
          if (previousTerminating.size > 0) {
            const runningIds = new Set(
              state.processes.filter((proc) => proc.status === "running").map((proc) => proc.id)
            );
            const nextTerminating = new Set(
              [...previousTerminating].filter((id) => runningIds.has(id))
            );
            if (!areSetsEqual(previousTerminating, nextTerminating)) {
              this.terminatingIdsCache.set(workspaceId, nextTerminating);
              this.terminatingIdsStore.bump(workspaceId);
            }
          }
        }
      } catch (err) {
        if (!signal.aborted) {
          console.error("Failed to subscribe to background bash state:", err);
        }
      }
    })();
  }

  private markTerminating(workspaceId: string, processId: string): void {
    const previous = this.terminatingIdsCache.get(workspaceId) ?? EMPTY_SET;
    if (previous.has(processId)) {
      return;
    }

    const next = new Set(previous);
    next.add(processId);
    this.terminatingIdsCache.set(workspaceId, next);
    this.terminatingIdsStore.bump(workspaceId);
  }

  private clearTerminating(workspaceId: string, processId: string): void {
    const previous = this.terminatingIdsCache.get(workspaceId);
    if (!previous?.has(processId)) {
      return;
    }

    const next = new Set(previous);
    next.delete(processId);
    this.terminatingIdsCache.set(workspaceId, next);
    this.terminatingIdsStore.bump(workspaceId);
  }
}

let storeInstance: BackgroundBashStore | null = null;

function getStoreInstance(): BackgroundBashStore {
  storeInstance ??= new BackgroundBashStore();
  return storeInstance;
}

export function useBackgroundBashStoreRaw(): BackgroundBashStore {
  return getStoreInstance();
}

export function useBackgroundProcesses(workspaceId: string | undefined): BackgroundProcessInfo[] {
  const store = getStoreInstance();
  return useSyncExternalStore(
    (listener) => (workspaceId ? store.subscribeProcesses(workspaceId, listener) : () => undefined),
    () => (workspaceId ? store.getProcesses(workspaceId) : EMPTY_PROCESSES)
  );
}

export function useForegroundBashToolCallIds(workspaceId: string | undefined): Set<string> {
  const store = getStoreInstance();
  return useSyncExternalStore(
    (listener) =>
      workspaceId ? store.subscribeForegroundIds(workspaceId, listener) : () => undefined,
    () => (workspaceId ? store.getForegroundIds(workspaceId) : EMPTY_SET)
  );
}

export function useBackgroundBashTerminatingIds(workspaceId: string | undefined): Set<string> {
  const store = getStoreInstance();
  return useSyncExternalStore(
    (listener) =>
      workspaceId ? store.subscribeTerminatingIds(workspaceId, listener) : () => undefined,
    () => (workspaceId ? store.getTerminatingIds(workspaceId) : EMPTY_SET)
  );
}
