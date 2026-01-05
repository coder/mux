/**
 * Experiments System
 *
 * Global feature flags for experimental features.
 * State is persisted in localStorage as `experiment:${experimentId}`.
 */

export const EXPERIMENT_IDS = {
  POST_COMPACTION_CONTEXT: "post-compaction-context",
  PROGRAMMATIC_TOOL_CALLING: "programmatic-tool-calling",
  PROGRAMMATIC_TOOL_CALLING_EXCLUSIVE: "programmatic-tool-calling-exclusive",
  CONFIGURABLE_BIND_URL: "configurable-bind-url",
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
    userOverridable: true,
    showInSettings: true,
  },
  [EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING_EXCLUSIVE]: {
    id: EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING_EXCLUSIVE,
    name: "PTC Exclusive Mode",
    description: "Replace all tools with code_execution (forces PTC usage)",
    enabledByDefault: false,
    userOverridable: true,
    showInSettings: true,
  },
  [EXPERIMENT_IDS.CONFIGURABLE_BIND_URL]: {
    id: EXPERIMENT_IDS.CONFIGURABLE_BIND_URL,
    name: "Expose API server on LAN/VPN",
    description:
      "Allow mux to listen on a non-localhost address so other devices on your LAN/VPN can connect. Anyone on your network with the auth token can access your mux API. HTTP only; use only on trusted networks (Tailscale recommended).",
    enabledByDefault: false,
    userOverridable: true,
    showInSettings: true,
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
