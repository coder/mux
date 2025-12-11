import React, { createContext, useContext, useSyncExternalStore, useCallback } from "react";
import {
  type ExperimentId,
  EXPERIMENTS,
  getExperimentKey,
  getExperimentList,
} from "@/common/constants/experiments";
import { getStorageChangeEvent } from "@/common/constants/events";

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
 * Get current experiment state from localStorage.
 */
function getExperimentSnapshot(experimentId: ExperimentId): boolean {
  const experiment = EXPERIMENTS[experimentId];
  const key = getExperimentKey(experimentId);

  try {
    const stored = window.localStorage.getItem(key);
    if (stored === null || stored === "undefined") {
      return experiment.enabledByDefault;
    }
    return JSON.parse(stored) as boolean;
  } catch {
    return experiment.enabledByDefault;
  }
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

  return (
    <ExperimentsContext.Provider value={{ setExperiment }}>
      {props.children}
    </ExperimentsContext.Provider>
  );
}

/**
 * Hook to get a single experiment's enabled state with reactive updates.
 * Uses useSyncExternalStore for efficient, selective re-renders.
 * Only re-renders when THIS specific experiment changes.
 *
 * @param experimentId - The experiment to subscribe to
 * @returns Whether the experiment is enabled
 */
export function useExperimentValue(experimentId: ExperimentId): boolean {
  const subscribe = useCallback(
    (callback: () => void) => subscribeToExperiment(experimentId, callback),
    [experimentId]
  );

  const getSnapshot = useCallback(() => getExperimentSnapshot(experimentId), [experimentId]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Hook to get setter function for experiments.
 * Use this in components that need to toggle experiments (e.g., Settings).
 *
 * @returns Function to set experiment state
 */
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
      result[exp.id] = getExperimentSnapshot(exp.id);
    }
    return result as Record<ExperimentId, boolean>;
  }, [experiments]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
