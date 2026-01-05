import { readPersistedState } from "./usePersistedState";
import { type ExperimentId, EXPERIMENTS, getExperimentKey } from "@/common/constants/experiments";

// Re-export reactive hooks from context for convenience
export {
  useExperiment,
  useExperimentValue,
  useExperimentOverrideValue,
  useSetExperiment,
  useAllExperiments,
} from "@/browser/contexts/ExperimentsContext";

/**
 * Non-hook version to read experiment state.
 * Use when you need a one-time read (e.g., constructing send options at send time)
 * or outside of React components.
 *
 * For reactive updates in React components, use useExperimentValue (UI gating) or
 * useExperimentOverrideValue (backend send options).
 *
 * IMPORTANT: For user-overridable experiments, returns `undefined` when no explicit
 * localStorage override exists. This signals to the backend to use the PostHog
 * assignment instead of treating the default value as a user choice.
 *
 * @param experimentId - The experiment to check
 * @returns Whether the experiment is enabled, or undefined if backend should decide
 */
export function isExperimentEnabled(experimentId: ExperimentId): boolean | undefined {
  const experiment = EXPERIMENTS[experimentId];
  const key = getExperimentKey(experimentId);

  // For user-overridable experiments: only return a value if user explicitly set one.
  // This allows the backend to use PostHog assignment when there's no override.
  if (experiment.userOverridable) {
    const stored = readPersistedState<unknown>(key, undefined);
    return typeof stored === "boolean" ? stored : undefined;
  }

  // Non-overridable: always use default (these are local-only experiments)
  const stored = readPersistedState<unknown>(key, experiment.enabledByDefault);
  return typeof stored === "boolean" ? stored : experiment.enabledByDefault;
}
