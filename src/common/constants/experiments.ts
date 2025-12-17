/**
 * Experiments System
 *
 * Global feature flags for experimental features.
 * State is persisted in localStorage as `experiment:${experimentId}`.
 */

export const EXPERIMENT_IDS = {
  POST_COMPACTION_CONTEXT: "post-compaction-context",
  PROGRAMMATIC_TOOL_CALLING: "programmatic-tool-calling",
} as const;

export type ExperimentId = (typeof EXPERIMENT_IDS)[keyof typeof EXPERIMENT_IDS];

export interface ExperimentDefinition {
  id: ExperimentId;
  name: string;
  description: string;
  /** Default state - false means disabled by default */
  enabledByDefault: boolean;
  /**
   * When true, user can override remote PostHog assignment via Settings toggle.
   * When false (default), remote assignment is authoritative.
   */
  userOverridable?: boolean;
  /**
   * When false, experiment is hidden from Settings → Experiments.
   * Defaults to true. Use false for invisible A/B tests.
   */
  showInSettings?: boolean;
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
    userOverridable: true, // User can opt-out via Settings
    showInSettings: true,
  },
  [EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING]: {
    id: EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING,
    name: "Programmatic Tool Calling",
    description: "Enable code_execution tool for multi-tool workflows in a sandboxed JS runtime",
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
