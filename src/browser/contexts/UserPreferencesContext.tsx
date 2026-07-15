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
  isUserPreferenceStorageKey,
  readStoredUserPreferenceValue,
  removeStoredUserPreference,
} from "@/common/preferences/userPreferencesStorage";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
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

export function mirrorBackendPreferences(params: {
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
      // The scratch composer persists AI prefs under the scratch system project
      // scope, which userProjects excludes and which may not exist in config yet.
      // Keep it valid here or pruning deletes those prefs and the picker reverts.
      if (projectPath === SCRATCH_PROJECT_CONFIG_KEY) {
        continue;
      }
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

export function canPrunePreferenceScopes(params: {
  hydrated: boolean;
  projectLoading: boolean;
  projectLoaded: boolean;
  projectLoadError: string | null | undefined;
  workspaceLoading: boolean;
  workspaceLoaded: boolean;
  workspaceLoadError: string | null | undefined;
}): boolean {
  return (
    params.hydrated &&
    !params.projectLoading &&
    params.projectLoaded &&
    params.projectLoadError == null &&
    !params.workspaceLoading &&
    params.workspaceLoaded &&
    params.workspaceLoadError == null
  );
}

const USER_PREFERENCE_RETRY_BASE_DELAY_MS = 250;
const USER_PREFERENCE_RETRY_MAX_DELAY_MS = 5000;

function getUserPreferenceRetryDelayMs(retryAttempt: number): number {
  return Math.min(
    USER_PREFERENCE_RETRY_BASE_DELAY_MS * 2 ** retryAttempt,
    USER_PREFERENCE_RETRY_MAX_DELAY_MS
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

export async function retryUserPreferenceHydration(params: {
  signal: AbortSignal;
  applyBackendConfig: () => Promise<void>;
  onError: (message: string, error: unknown) => void;
  getRetryDelayMs?: (retryAttempt: number) => number;
  waitForDelay?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
  const getRetryDelayMs = params.getRetryDelayMs ?? getUserPreferenceRetryDelayMs;
  const waitForDelay = params.waitForDelay ?? waitForRetryDelay;
  let retryAttempt = 0;

  while (!params.signal.aborted) {
    try {
      await params.applyBackendConfig();
      return;
    } catch (error) {
      const retryDelayMs = getRetryDelayMs(retryAttempt);
      retryAttempt += 1;
      params.onError(`Failed to hydrate user preferences, retrying in ${retryDelayMs}ms:`, error);
      await waitForDelay(retryDelayMs, params.signal);
    }
  }
}

interface UserPreferenceConfigClient {
  getConfig: () => Promise<{ userPreferences?: unknown; userPreferencesInitialized?: boolean }>;
  saveConfig: (input: { userPreferences?: UserPreferences | null }) => Promise<void>;
}

export function applyLocalPreferenceWrite(params: {
  preferences: UserPreferences | undefined;
  key: string;
  newValue: unknown;
  storage: Storage;
}): UserPreferences | undefined {
  const basePreferences =
    params.preferences ?? mergeMissingLocalPreferences(undefined, params.storage);
  return params.newValue === undefined || params.newValue === null
    ? removeStoredUserPreference(basePreferences, params.key)
    : applyStoredUserPreference(basePreferences, params.key, params.newValue);
}

export function shouldBackfillLocalPreferences(params: {
  backendPreferences: UserPreferences | undefined;
  userPreferencesInitialized: boolean | undefined;
}): boolean {
  return params.userPreferencesInitialized !== true && params.backendPreferences === undefined;
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
  const shouldBackfill = shouldBackfillLocalPreferences({
    backendPreferences,
    userPreferencesInitialized: config.userPreferencesInitialized,
  });
  mirrorBackendPreferences({
    backendPreferences,
    dirtyKeys: new Set(),
    initial: shouldBackfill,
    storage,
  });

  return shouldBackfill
    ? mergeMissingLocalPreferences(backendPreferences, storage)
    : backendPreferences;
}

export function createUserPreferenceSaveQueue(params: {
  configClient: UserPreferenceConfigClient;
  signal: AbortSignal;
  getCurrentPreferences: () => UserPreferences | undefined;
  clearDirtyKeys: () => void;
  onError: (message: string, error: unknown) => void;
}): (preferences: UserPreferences | undefined) => void {
  interface PendingPreferenceSave {
    value: UserPreferences | undefined;
  }
  let saveInFlight = false;
  let pendingSave: PendingPreferenceSave | null = null;
  let retryAttempt = 0;

  const flush = async () => {
    saveInFlight = true;
    try {
      while (pendingSave !== null && !params.signal.aborted) {
        const preferencesToSave = pendingSave.value;
        pendingSave = null;
        const savedFingerprint = stableStringify(preferencesToSave);

        try {
          await params.configClient.saveConfig({ userPreferences: preferencesToSave ?? null });
        } catch (error) {
          const hasNewerPendingSave = pendingSave !== null;
          if (!hasNewerPendingSave) {
            pendingSave = { value: preferencesToSave };
          }

          const retryDelayMs = getUserPreferenceRetryDelayMs(retryAttempt);
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
    pendingSave = { value: preferences };
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

    const applyBackendConfig = async () => {
      const config = await api.config.getConfig();
      if (signal.aborted) {
        return;
      }

      const backendPreferences = normalizeUserPreferences(config.userPreferences);
      const shouldBackfill = shouldBackfillLocalPreferences({
        backendPreferences,
        userPreferencesInitialized: config.userPreferencesInitialized,
      });
      mirrorBackendPreferences({
        backendPreferences,
        dirtyKeys: dirtyKeysRef.current,
        initial: shouldBackfill,
        storage,
      });

      const withLocalBackfill = shouldBackfill
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

      if (
        (shouldBackfill || dirtyKeysRef.current.size > 0) &&
        stableStringify(nextPreferences) !== stableStringify(backendPreferences)
      ) {
        enqueueSave(nextPreferences);
      }
    };

    const unsubscribeWrites = subscribePersistedStateWrites((event) => {
      if (event.source === "backend" || !isUserPreferenceStorageKey(event.key)) {
        return;
      }

      dirtyKeysRef.current.add(event.key);
      currentPreferencesRef.current = applyLocalPreferenceWrite({
        preferences: currentPreferencesRef.current,
        key: event.key,
        newValue: event.newValue,
        storage,
      });

      if (!hydratedRef.current) {
        return;
      }

      enqueueSave(currentPreferencesRef.current);
    });

    const initialSync = retryUserPreferenceHydration({
      signal,
      applyBackendConfig,
      onError: (message, error) => {
        console.warn(message, error);
      },
    });
    initialSync.catch((error) => {
      console.warn("Failed to retry user preference hydration:", error);
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
          const refresh = applyBackendConfig();
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
    if (
      !canPrunePreferenceScopes({
        hydrated,
        projectLoading: projectContext.loading,
        projectLoaded: projectContext.loaded,
        projectLoadError: projectContext.loadError,
        workspaceLoading: workspaceContext.loading,
        workspaceLoaded: workspaceContext.loaded,
        workspaceLoadError: workspaceContext.loadError,
      })
    ) {
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
        if (!prunedKeys.has(key)) {
          removeBackendEntryFromLocalStorage(key, storage);
        }
      }
    }

    savePreferencesRef.current(pruned);
  }, [
    hydrated,
    projectContext.loading,
    projectContext.loaded,
    projectContext.loadError,
    projectContext.userProjects,
    workspaceContext.loading,
    workspaceContext.loaded,
    workspaceContext.loadError,
    workspaceContext.workspaceMetadata,
  ]);

  return <>{props.children}</>;
}
