import React, {
  createContext,
  useContext,
  useSyncExternalStore,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type ExperimentId,
  EXPERIMENTS,
  getExperimentKey,
  getExperimentList,
} from "@/common/constants/experiments";
import { getStorageChangeEvent } from "@/common/constants/events";
import type { ExperimentValue } from "@/common/orpc/types";
import { useAPI } from "@/browser/contexts/API";

/**
 * Subscribe to experiment changes for a specific experiment ID.
 * Uses localStorage + custom events for cross-component sync.
 */
function subscribeToExperiment(experimentId: ExperimentId, callback: () => void): () => void {
  const key = getExperimentKey(experimentId);
  const storageChangeEvent = getStorageChangeEvent(key);

  const handleChange = () => callback();

  // Listen to both storage events (cross-tab) and custom events (same-tab)
  window.addEventListener("storage", handleChange);
  window.addEventListener(storageChangeEvent, handleChange);

  return () => {
    window.removeEventListener("storage", handleChange);
    window.removeEventListener(storageChangeEvent, handleChange);
  };
}

/**
 * Get explicit localStorage override for an experiment.
 * Returns undefined if no value is set or parsing fails.
 */
function getExperimentOverrideSnapshot(experimentId: ExperimentId): boolean | undefined {
  const key = getExperimentKey(experimentId);

  try {
    const stored = window.localStorage.getItem(key);
    // Check for literal "undefined" string defensively - this can occur if
    // JSON.stringify(undefined) is accidentally stored (it returns "undefined")
    if (stored === null || stored === "undefined") {
      return undefined;
    }

    const parsed = JSON.parse(stored) as unknown;
    return typeof parsed === "boolean" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Get current experiment state from localStorage.
 * Returns the stored value or the default if not set.
 */
function getExperimentSnapshot(experimentId: ExperimentId): boolean {
  const experiment = EXPERIMENTS[experimentId];
  return getExperimentOverrideSnapshot(experimentId) ?? experiment.enabledByDefault;
}

/**
 * Check if user has explicitly set a local override for an experiment.
 * Returns true if there's a value in localStorage (not using default).
 */
function hasLocalOverride(experimentId: ExperimentId): boolean {
  return getExperimentOverrideSnapshot(experimentId) !== undefined;
}

/**
 * Convert PostHog experiment variant to boolean enabled state.
 * For experiments with control/test variants, "test" means enabled.
 */
function getRemoteExperimentEnabled(value: string | boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return value === "test";
}

/**
 * True when any remote experiment value is still pending a background PostHog refresh.
 */
function hasPendingRemoteExperimentValues(
  remoteExperiments: Partial<Record<ExperimentId, ExperimentValue>>
): boolean {
  return Object.values(remoteExperiments).some(
    (remote) => remote?.source === "cache" && remote.value === null
  );
}

const REMOTE_EXPERIMENTS_POLL_INITIAL_DELAY_MS = 100;
const REMOTE_EXPERIMENTS_POLL_MAX_DELAY_MS = 5_000;
const REMOTE_EXPERIMENTS_POLL_MAX_ATTEMPTS = 8;

function getRemoteExperimentsPollDelayMs(attempt: number): number {
  return Math.min(
    REMOTE_EXPERIMENTS_POLL_INITIAL_DELAY_MS * 2 ** attempt,
    REMOTE_EXPERIMENTS_POLL_MAX_DELAY_MS
  );
}

/**
 * Set experiment state to localStorage and dispatch sync event.
 */
function setExperimentState(experimentId: ExperimentId, enabled: boolean): void {
  const key = getExperimentKey(experimentId);

  try {
    window.localStorage.setItem(key, JSON.stringify(enabled));

    // Dispatch custom event for same-tab synchronization
    const customEvent = new CustomEvent(getStorageChangeEvent(key), {
      detail: { key, newValue: enabled },
    });
    window.dispatchEvent(customEvent);
  } catch (error) {
    console.warn(`Error writing experiment state for "${experimentId}":`, error);
  }
}

/**
 * Context value type - provides setter function.
 * Individual experiment values are accessed via useExperimentValue hook.
 */
interface ExperimentsContextValue {
  setExperiment: (experimentId: ExperimentId, enabled: boolean) => void;
  remoteExperiments: Partial<Record<ExperimentId, ExperimentValue>> | null;
  reloadRemoteExperiments: () => Promise<void>;
}

const ExperimentsContext = createContext<ExperimentsContextValue | null>(null);

/**
 * Provider component for experiments.
 * Must wrap the app to enable useExperimentValue hook.
 */
export function ExperimentsProvider(props: { children: React.ReactNode }) {
  const setExperiment = useCallback((experimentId: ExperimentId, enabled: boolean) => {
    setExperimentState(experimentId, enabled);
  }, []);

  const apiState = useAPI();
  const [remoteExperiments, setRemoteExperiments] = useState<Partial<
    Record<ExperimentId, ExperimentValue>
  > | null>(null);

  const loadRemoteExperiments = useCallback(async () => {
    if (apiState.status !== "connected" || !apiState.api) {
      setRemoteExperiments(null);
      return;
    }

    try {
      const result = await apiState.api.experiments.getAll();
      setRemoteExperiments(result as Partial<Record<ExperimentId, ExperimentValue>>);
    } catch {
      setRemoteExperiments(null);
    }
  }, [apiState.status, apiState.api]);

  const reloadRemoteExperiments = useCallback(async () => {
    if (apiState.status !== "connected" || !apiState.api) {
      setRemoteExperiments(null);
      return;
    }

    try {
      await apiState.api.experiments.reload();
    } catch {
      // Best effort
    }

    await loadRemoteExperiments();
  }, [apiState.status, apiState.api, loadRemoteExperiments]);

  // On cold start, experiments.getAll can return { source: "cache", value: null } while
  // ExperimentsService refreshes from PostHog in the background. Poll a few times so the
  // renderer picks up remote variants without requiring a manual reload.
  const remotePollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remotePollAttemptRef = useRef(0);

  const clearRemotePoll = useCallback(() => {
    if (remotePollTimeoutRef.current === null) {
      return;
    }

    clearTimeout(remotePollTimeoutRef.current);
    remotePollTimeoutRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      clearRemotePoll();
    };
  }, [clearRemotePoll]);

  useEffect(() => {
    if (apiState.status !== "connected" || !apiState.api) {
      remotePollAttemptRef.current = 0;
      clearRemotePoll();
      return;
    }

    if (!remoteExperiments) {
      remotePollAttemptRef.current = 0;
      clearRemotePoll();
      return;
    }

    if (!hasPendingRemoteExperimentValues(remoteExperiments)) {
      remotePollAttemptRef.current = 0;
      clearRemotePoll();
      return;
    }

    if (remotePollTimeoutRef.current !== null) {
      return;
    }

    const attempt = remotePollAttemptRef.current;
    if (attempt >= REMOTE_EXPERIMENTS_POLL_MAX_ATTEMPTS) {
      return;
    }

    const delayMs = getRemoteExperimentsPollDelayMs(attempt);
    remotePollTimeoutRef.current = setTimeout(() => {
      remotePollTimeoutRef.current = null;
      remotePollAttemptRef.current += 1;
      void loadRemoteExperiments();
    }, delayMs);
  }, [apiState.status, apiState.api, remoteExperiments, clearRemotePoll, loadRemoteExperiments]);
  useEffect(() => {
    void loadRemoteExperiments();
  }, [loadRemoteExperiments]);

  return (
    <ExperimentsContext.Provider
      value={{ setExperiment, remoteExperiments, reloadRemoteExperiments }}
    >
      {props.children}
    </ExperimentsContext.Provider>
  );
}

/**
 * Hook to get a single experiment's enabled state with reactive updates.
 * Uses useSyncExternalStore for efficient, selective re-renders.
 * Only re-renders when THIS specific experiment changes.
 *
 * Resolution priority:
 * - If userOverridable && user has explicitly set a local value → use local
 * - If remote PostHog assignment exists → use remote
 * - Otherwise → use local (which may be default)
 *
 * @param experimentId - The experiment to subscribe to
 * @returns Whether the experiment is enabled
 */
export function useExperimentValue(experimentId: ExperimentId): boolean {
  const experiment = EXPERIMENTS[experimentId];
  const subscribe = useCallback(
    (callback: () => void) => subscribeToExperiment(experimentId, callback),
    [experimentId]
  );

  const getSnapshot = useCallback(() => getExperimentSnapshot(experimentId), [experimentId]);

  const localEnabled = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const context = useContext(ExperimentsContext);
  const remote = context?.remoteExperiments?.[experimentId];

  // User-overridable: local wins if explicitly set
  if (experiment.userOverridable && hasLocalOverride(experimentId)) {
    return localEnabled;
  }

  // Remote assignment (if available and not disabled)
  if (remote && remote.source !== "disabled" && remote.value !== null) {
    return getRemoteExperimentEnabled(remote.value);
  }

  // Fallback to local (which may be default)
  return localEnabled;
}

/**
 * Hook to read only an explicit local override for an experiment.
 *
 * Returns `undefined` when the user has not explicitly set a value in localStorage.
 * This is important for user-overridable experiments: the backend can then apply
 * the PostHog assignment instead of treating the default value as a user choice.
 */
export function useExperimentOverrideValue(experimentId: ExperimentId): boolean | undefined {
  const subscribe = useCallback(
    (callback: () => void) => subscribeToExperiment(experimentId, callback),
    [experimentId]
  );

  const getSnapshot = useCallback(
    () => getExperimentOverrideSnapshot(experimentId),
    [experimentId]
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Hook to get setter function for experiments.
 * Use this in components that need to toggle experiments (e.g., Settings).
 *
 * @returns Function to set experiment state
 */

export function useRemoteExperimentValue(experimentId: ExperimentId): ExperimentValue | null {
  const context = useContext(ExperimentsContext);
  return context?.remoteExperiments?.[experimentId] ?? null;
}
export function useSetExperiment(): (experimentId: ExperimentId, enabled: boolean) => void {
  const context = useContext(ExperimentsContext);
  if (!context) {
    throw new Error("useSetExperiment must be used within ExperimentsProvider");
  }
  return context.setExperiment;
}

/**
 * Hook to get both value and setter for an experiment.
 * Combines useExperimentValue and useSetExperiment for convenience.
 *
 * @param experimentId - The experiment to subscribe to
 * @returns [enabled, setEnabled] tuple
 */
export function useExperiment(experimentId: ExperimentId): [boolean, (enabled: boolean) => void] {
  const enabled = useExperimentValue(experimentId);
  const setExperiment = useSetExperiment();

  const setEnabled = useCallback(
    (value: boolean) => setExperiment(experimentId, value),
    [setExperiment, experimentId]
  );

  return [enabled, setEnabled];
}

/**
 * Get all experiments with their current state.
 * Reactive - re-renders when any experiment changes.
 * Use sparingly; prefer useExperimentValue for single experiments.
 */
export function useAllExperiments(): Record<ExperimentId, boolean> {
  const experiments = getExperimentList();
  const context = useContext(ExperimentsContext);
  const remoteExperiments = context?.remoteExperiments;

  // Subscribe to all experiments
  const subscribe = useCallback(
    (callback: () => void) => {
      const unsubscribes = experiments.map((exp) => subscribeToExperiment(exp.id, callback));
      return () => unsubscribes.forEach((unsub) => unsub());
    },
    [experiments]
  );

  const getSnapshot = useCallback(() => {
    const result: Partial<Record<ExperimentId, boolean>> = {};

    for (const exp of experiments) {
      const localValue = getExperimentSnapshot(exp.id);
      const remote = remoteExperiments?.[exp.id];

      // User-overridable: local wins if explicitly set
      if (exp.userOverridable && hasLocalOverride(exp.id)) {
        result[exp.id] = localValue;
        continue;
      }

      // Remote assignment (if available and not disabled)
      if (remote && remote.source !== "disabled" && remote.value !== null) {
        result[exp.id] = getRemoteExperimentEnabled(remote.value);
        continue;
      }

      // Fallback to local (which may be default)
      result[exp.id] = localValue;
    }

    return result as Record<ExperimentId, boolean>;
  }, [experiments, remoteExperiments]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
