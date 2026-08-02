import { readPersistedState } from "./usePersistedState";
import {
  type ExperimentId,
  EXPERIMENTS,
  getExperimentKey,
  isExperimentSupportedOnPlatform,
} from "@/common/constants/experiments";

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
 * For user-overridable experiments, returns `undefined` when no explicit localStorage
 * override exists, so send options can distinguish "user chose off" from "user never chose".
 */
export function isExperimentEnabled(experimentId: ExperimentId): boolean | undefined {
  const experiment = EXPERIMENTS[experimentId];
  if (!isExperimentSupportedOnPlatform(experimentId, window.api?.platform)) {
    return false;
  }

  const key = getExperimentKey(experimentId);

  if (experiment.userOverridable) {
    const stored = readPersistedState<unknown>(key, undefined);
    return typeof stored === "boolean" ? stored : undefined;
  }

  // Non-overridable: always use default (these are local-only experiments)
  const stored = readPersistedState<unknown>(key, experiment.enabledByDefault);
  return typeof stored === "boolean" ? stored : experiment.enabledByDefault;
}
