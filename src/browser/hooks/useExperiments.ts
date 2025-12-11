import { readPersistedState } from "./usePersistedState";
import { type ExperimentId, EXPERIMENTS, getExperimentKey } from "@/common/constants/experiments";

// Re-export reactive hooks from context for convenience
export {
  useExperiment,
  useExperimentValue,
  useSetExperiment,
  useAllExperiments,
} from "@/browser/contexts/ExperimentsContext";

/**
 * Non-hook version to read experiment state.
 * Use when you need a one-time read (e.g., constructing send options at send time)
 * or outside of React components.
 *
 * For reactive updates in React components, use useExperimentValue instead.
 *
 * @param experimentId - The experiment to check
 * @returns Whether the experiment is enabled
 */
export function isExperimentEnabled(experimentId: ExperimentId): boolean {
  const experiment = EXPERIMENTS[experimentId];
  return readPersistedState<boolean>(getExperimentKey(experimentId), experiment.enabledByDefault);
}
