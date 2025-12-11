/**
 * Experiments System
 *
 * Global feature flags for experimental features.
 * State is persisted in localStorage as `experiment:${experimentId}`.
 */

export const EXPERIMENT_IDS = {
  POST_COMPACTION_CONTEXT: "post-compaction-context",
} as const;

export type ExperimentId = (typeof EXPERIMENT_IDS)[keyof typeof EXPERIMENT_IDS];

export interface ExperimentDefinition {
  id: ExperimentId;
  name: string;
  description: string;
  /** Default state - false means disabled by default */
  enabledByDefault: boolean;
}

/**
 * Registry of all experiments.
 * Use Record<ExperimentId, ExperimentDefinition> to ensure exhaustive coverage.
 */
export const EXPERIMENTS: Record<ExperimentId, ExperimentDefinition> = {
  [EXPERIMENT_IDS.POST_COMPACTION_CONTEXT]: {
    id: EXPERIMENT_IDS.POST_COMPACTION_CONTEXT,
    name: "Post-Compaction Context",
    description: "Re-inject plan file and edited file diffs after compaction to preserve context",
    enabledByDefault: false,
  },
};

/**
 * Get localStorage key for an experiment.
 * Format: "experiment:{experimentId}"
 */
export function getExperimentKey(experimentId: ExperimentId): string {
  return `experiment:${experimentId}`;
}

/**
 * Get all experiment definitions as an array for iteration.
 */
export function getExperimentList(): ExperimentDefinition[] {
  return Object.values(EXPERIMENTS);
}
