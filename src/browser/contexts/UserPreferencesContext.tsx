import { useEffect, useRef, useState, type ReactNode } from "react";

import { useAPI } from "@/browser/contexts/API";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import {
  subscribePersistedStateWrites,
  syncPersistedStateFromBackend,
} from "@/browser/hooks/usePersistedState";
import {
  normalizeUserPreferences,
  type UserPreferences,
} from "@/common/config/schemas/userPreferences";
import {
  applyStoredUserPreference,
  entriesFromUserPreferences,
  getStoredUserPreferenceEntries,
  getStoredUserPreferenceKeys,
  hasUserPreferenceEntry,
  isUserPreferenceStorageKey,
  readStoredUserPreferenceValue,
  removeStoredUserPreference,
} from "@/common/preferences/userPreferencesStorage";
import { normalizeOrder } from "@/common/utils/projectOrdering";
import { stableStringify } from "@/common/utils/stableStringify";

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined" || !window.localStorage) {
    return null;
  }

  return window.localStorage;
}

function writeBackendEntryToLocalStorage(entry: { key: string; value: unknown }, storage: Storage) {
  if (storage === getLocalStorage()) {
    syncPersistedStateFromBackend(entry.key, entry.value);
    return;
  }

  storage.setItem(entry.key, JSON.stringify(entry.value));
}

function removeBackendEntryFromLocalStorage(key: string, storage: Storage) {
  if (storage === getLocalStorage()) {
    syncPersistedStateFromBackend(key, undefined);
    return;
  }

  storage.removeItem(key);
}

export function overlayDirtyLocalValues(
  preferences: UserPreferences | undefined,
  dirtyKeys: Iterable<string>,
  storage: Storage
): UserPreferences | undefined {
  let next = preferences;
  for (const key of dirtyKeys) {
    const value = readStoredUserPreferenceValue(storage, key);
    next =
      value === undefined
        ? removeStoredUserPreference(next, key)
        : applyStoredUserPreference(next, key, value);
  }

  return next;
}

export function mergeMissingLocalPreferences(
  backendPreferences: UserPreferences | undefined,
  storage: Storage
): UserPreferences | undefined {
  const backendKeys = new Set(
    entriesFromUserPreferences(backendPreferences).map((entry) => entry.key)
  );
  let next = backendPreferences;
  for (const entry of getStoredUserPreferenceEntries(storage)) {
    if (backendKeys.has(entry.key)) {
      continue;
    }
    next = applyStoredUserPreference(next, entry.key, entry.value);
  }

  return next;
}

function mirrorBackendPreferences(params: {
  backendPreferences: UserPreferences | undefined;
  dirtyKeys: ReadonlySet<string>;
  initial: boolean;
  storage: Storage;
}) {
  const backendEntries = entriesFromUserPreferences(params.backendPreferences);
  const backendKeys = new Set(backendEntries.map((entry) => entry.key));

  for (const entry of backendEntries) {
    if (!params.dirtyKeys.has(entry.key)) {
      writeBackendEntryToLocalStorage(entry, params.storage);
    }
  }

  if (params.initial) {
    return;
  }

  for (const key of getStoredUserPreferenceKeys(params.storage)) {
    if (!backendKeys.has(key) && !params.dirtyKeys.has(key)) {
      removeBackendEntryFromLocalStorage(key, params.storage);
    }
  }
}

export function prunePreferenceScopes(params: {
  preferences: UserPreferences | undefined;
  projectPaths: Set<string>;
  workspaceIds: Set<string>;
  userProjects: Parameters<typeof normalizeOrder>[1];
}): UserPreferences | undefined {
  const next = params.preferences
    ? (JSON.parse(JSON.stringify(params.preferences)) as UserPreferences)
    : undefined;
  if (!next) {
    return undefined;
  }

  const pruneProjectRecord = <T,>(record: Record<string, T> | undefined) => {
    if (!record) {
      return;
    }
    for (const projectPath of Object.keys(record)) {
      if (!params.projectPaths.has(projectPath)) {
        delete record[projectPath];
      }
    }
  };

  if (next.navigation?.projectOrder) {
    next.navigation.projectOrder = normalizeOrder(
      next.navigation.projectOrder,
      params.userProjects
    );
  }

  pruneProjectRecord(next.ai?.projectDefaults);
  pruneProjectRecord(next.workspaceCreation?.byProject);
  pruneProjectRecord(next.review?.defaultBaseByProject);

  const workspaceNotifications = next.notifications?.notifyOnResponseByWorkspace;
  if (workspaceNotifications) {
    for (const workspaceId of Object.keys(workspaceNotifications)) {
      if (!params.workspaceIds.has(workspaceId)) {
        delete workspaceNotifications[workspaceId];
      }
    }
  }

  return normalizeUserPreferences(next);
}

const USER_PREFERENCE_SAVE_RETRY_BASE_DELAY_MS = 250;
const USER_PREFERENCE_SAVE_RETRY_MAX_DELAY_MS = 5000;

function getUserPreferenceSaveRetryDelayMs(retryAttempt: number): number {
  return Math.min(
    USER_PREFERENCE_SAVE_RETRY_BASE_DELAY_MS * 2 ** retryAttempt,
    USER_PREFERENCE_SAVE_RETRY_MAX_DELAY_MS
  );
}

function waitForRetryDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const timeoutId = setTimeout(finish, delayMs);
    function finish() {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

interface UserPreferenceConfigClient {
  getConfig: () => Promise<{ userPreferences?: unknown }>;
  saveConfig: (input: { userPreferences?: UserPreferences | null }) => Promise<void>;
}

export async function hydrateUserPreferencesLocalCache(params: {
  configClient: UserPreferenceConfigClient;
  signal?: AbortSignal;
  storage?: Storage | null;
}): Promise<UserPreferences | undefined> {
  const storage = params.storage ?? getLocalStorage();
  if (!storage || params.signal?.aborted) {
    return undefined;
  }

  const config = await params.configClient.getConfig();
  if (params.signal?.aborted) {
    return undefined;
  }

  const backendPreferences = normalizeUserPreferences(config.userPreferences);
  mirrorBackendPreferences({
    backendPreferences,
    dirtyKeys: new Set(),
    initial: true,
    storage,
  });

  return mergeMissingLocalPreferences(backendPreferences, storage);
}

export function createUserPreferenceSaveQueue(params: {
  configClient: UserPreferenceConfigClient;
  signal: AbortSignal;
  getCurrentPreferences: () => UserPreferences | undefined;
  clearDirtyKeys: () => void;
  onError: (message: string, error: unknown) => void;
}): (preferences: UserPreferences | undefined) => void {
  let saveInFlight = false;
  let pendingSave: UserPreferences | undefined | null = null;
  let retryAttempt = 0;

  const flush = async () => {
    saveInFlight = true;
    try {
      while (pendingSave !== null && !params.signal.aborted) {
        const preferencesToSave = pendingSave;
        pendingSave = null;
        const savedFingerprint = stableStringify(preferencesToSave);

        try {
          await params.configClient.saveConfig({ userPreferences: preferencesToSave ?? null });
        } catch (error) {
          const hasNewerPendingSave = pendingSave !== null;
          if (!hasNewerPendingSave) {
            pendingSave = preferencesToSave;
          }

          const retryDelayMs = getUserPreferenceSaveRetryDelayMs(retryAttempt);
          retryAttempt += 1;
          params.onError(
            `Failed to persist user preferences, retrying in ${retryDelayMs}ms:`,
            error
          );
          await waitForRetryDelay(retryDelayMs, params.signal);
          continue;
        }

        retryAttempt = 0;
        if (params.signal.aborted) {
          return;
        }

        if (stableStringify(params.getCurrentPreferences()) === savedFingerprint) {
          params.clearDirtyKeys();
        }
      }
    } finally {
      saveInFlight = false;
      if (pendingSave !== null && !params.signal.aborted) {
        const retry = flush();
        retry.catch((error) => {
          params.onError("Failed to retry user preference persistence:", error);
        });
      }
    }
  };

  return (preferences) => {
    pendingSave = preferences;
    if (saveInFlight) {
      return;
    }

    const flushPromise = flush();
    flushPromise.catch((error) => {
      params.onError("Failed to flush user preference persistence:", error);
    });
  };
}

export function UserPreferencesProvider(props: { children: ReactNode }) {
  const { api } = useAPI();
  const projectContext = useProjectContext();
  const workspaceContext = useWorkspaceContext();
  const currentPreferencesRef = useRef<UserPreferences | undefined>(undefined);
  const dirtyKeysRef = useRef<Set<string>>(new Set());
  const savePreferencesRef = useRef<(preferences: UserPreferences | undefined) => void>(
    () => undefined
  );
  const hydratedRef = useRef(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!api) {
      savePreferencesRef.current = () => undefined;
      hydratedRef.current = false;
      setHydrated(false);
      return;
    }

    // Treat every concrete API client identity as a fresh backend source. Electron normally
    // reconnects through null, but direct client swaps should still rerun the initial backfill.
    currentPreferencesRef.current = undefined;
    dirtyKeysRef.current.clear();
    hydratedRef.current = false;
    setHydrated(false);

    const storage = getLocalStorage();
    if (!storage) {
      return;
    }

    const abortController = new AbortController();
    const { signal } = abortController;
    let iterator: AsyncIterator<unknown> | null = null;

    const enqueueSave = createUserPreferenceSaveQueue({
      configClient: api.config,
      signal,
      getCurrentPreferences: () => currentPreferencesRef.current,
      clearDirtyKeys: () => {
        dirtyKeysRef.current.clear();
      },
      onError: (message, error) => {
        console.warn(message, error);
      },
    });

    savePreferencesRef.current = enqueueSave;

    const applyBackendConfig = async (initial: boolean) => {
      const config = await api.config.getConfig();
      if (signal.aborted) {
        return;
      }

      const backendPreferences = normalizeUserPreferences(config.userPreferences);
      mirrorBackendPreferences({
        backendPreferences,
        dirtyKeys: dirtyKeysRef.current,
        initial,
        storage,
      });

      const withLocalBackfill = initial
        ? mergeMissingLocalPreferences(backendPreferences, storage)
        : backendPreferences;
      const nextPreferences = overlayDirtyLocalValues(
        withLocalBackfill,
        dirtyKeysRef.current,
        storage
      );

      currentPreferencesRef.current = nextPreferences;
      hydratedRef.current = true;
      setHydrated(true);

      if (initial && stableStringify(nextPreferences) !== stableStringify(backendPreferences)) {
        enqueueSave(nextPreferences);
      }
    };

    const unsubscribeWrites = subscribePersistedStateWrites((event) => {
      if (event.source === "backend" || !isUserPreferenceStorageKey(event.key)) {
        return;
      }

      dirtyKeysRef.current.add(event.key);
      currentPreferencesRef.current =
        event.newValue === undefined || event.newValue === null
          ? removeStoredUserPreference(currentPreferencesRef.current, event.key)
          : applyStoredUserPreference(currentPreferencesRef.current, event.key, event.newValue);

      enqueueSave(currentPreferencesRef.current);
    });

    const initialSync = applyBackendConfig(!hydratedRef.current);
    initialSync.catch((error) => {
      console.warn("Failed to hydrate user preferences:", error);
    });

    const subscription = (async () => {
      try {
        const subscribedIterator = await api.config.onConfigChanged(undefined, { signal });
        if (signal.aborted) {
          const cleanup = subscribedIterator.return?.();
          cleanup?.catch(() => undefined);
          return;
        }

        iterator = subscribedIterator;
        for await (const _ of subscribedIterator) {
          if (signal.aborted) {
            break;
          }
          const refresh = applyBackendConfig(!hydratedRef.current);
          refresh.catch((error) => {
            console.warn("Failed to refresh user preferences:", error);
          });
        }
      } catch {
        // Config subscriptions are cancelled during unmounts and API reconnects.
      }
    })();

    subscription.catch((error) => {
      console.warn("Failed to subscribe to user preference changes:", error);
    });

    return () => {
      abortController.abort();
      unsubscribeWrites();
      const cleanup = iterator?.return?.();
      cleanup?.catch(() => undefined);
      savePreferencesRef.current = () => undefined;
    };
  }, [api]);

  useEffect(() => {
    if (!hydrated || projectContext.loading || workspaceContext.loading) {
      return;
    }

    const projectPaths = new Set(projectContext.userProjects.keys());
    const workspaceIds = new Set(workspaceContext.workspaceMetadata.keys());
    const pruned = prunePreferenceScopes({
      preferences: currentPreferencesRef.current,
      projectPaths,
      workspaceIds,
      userProjects: projectContext.userProjects,
    });

    if (stableStringify(pruned) === stableStringify(currentPreferencesRef.current)) {
      return;
    }

    currentPreferencesRef.current = pruned;
    const storage = getLocalStorage();
    if (storage) {
      for (const entry of entriesFromUserPreferences(pruned)) {
        writeBackendEntryToLocalStorage(entry, storage);
      }
    }

    const prunedKeys = new Set(entriesFromUserPreferences(pruned).map((entry) => entry.key));
    if (storage) {
      for (const key of getStoredUserPreferenceKeys(storage)) {
        if (
          !prunedKeys.has(key) &&
          hasUserPreferenceEntry(currentPreferencesRef.current, key) === false
        ) {
          removeBackendEntryFromLocalStorage(key, storage);
        }
      }
    }

    savePreferencesRef.current(pruned);
  }, [
    hydrated,
    projectContext.loading,
    projectContext.userProjects,
    workspaceContext.loading,
    workspaceContext.workspaceMetadata,
  ]);

  return <>{props.children}</>;
}
