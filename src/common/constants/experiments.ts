/**
 * Experiments System
 *
 * Global feature flags for experimental features.
 * State is persisted in localStorage as `experiment:${experimentId}`.
 */

export const EXPERIMENT_IDS = {
  PROGRAMMATIC_TOOL_CALLING: "programmatic-tool-calling",
  PROGRAMMATIC_TOOL_CALLING_EXCLUSIVE: "programmatic-tool-calling-exclusive",
  CONFIGURABLE_BIND_URL: "configurable-bind-url",
  SYSTEM_1: "system-1",
  EXEC_SUBAGENT_HARD_RESTART: "exec-subagent-hard-restart",
  MUX_GOVERNOR: "mux-governor",
  MULTI_PROJECT_WORKSPACES: "multi-project-workspaces",
  AGENT_BROWSER: "agent-browser",
  PORTABLE_DESKTOP: "portable-desktop",
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
   * When set, the experiment is only toggleable on these platforms. On other platforms it
   * appears disabled with a message.
   */
  platformRestriction?: NodeJS.Platform[];
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
  [EXPERIMENT_IDS.SYSTEM_1]: {
    id: EXPERIMENT_IDS.SYSTEM_1,
    name: "System 1",
    description: "Context optimization helpers inspired by Thinking, Fast and Slow (Kahneman)",
    enabledByDefault: false,
    userOverridable: true,
    showInSettings: true,
  },
  [EXPERIMENT_IDS.EXEC_SUBAGENT_HARD_RESTART]: {
    id: EXPERIMENT_IDS.EXEC_SUBAGENT_HARD_RESTART,
    name: "Exec sub-agent hard restart",
    description: "Hard-restart exec sub-agents on context overflow",
    enabledByDefault: false,
    userOverridable: true,
    showInSettings: true,
  },
  [EXPERIMENT_IDS.MUX_GOVERNOR]: {
    id: EXPERIMENT_IDS.MUX_GOVERNOR,
    name: "Mux Governor",
    description: "Remote policy delivery for enterprise Mux Governor service",
    enabledByDefault: false,
    userOverridable: true,
    showInSettings: true,
  },
  [EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES]: {
    id: EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES,
    name: "Multi-project workspaces",
    description: "Enable workspaces that can span multiple projects instead of a single project",
    enabledByDefault: false,
    userOverridable: true,
    // Keep this visible so users can opt into the still-default-off experiment from Settings.
    showInSettings: true,
  },
  [EXPERIMENT_IDS.AGENT_BROWSER]: {
    id: EXPERIMENT_IDS.AGENT_BROWSER,
    name: "Agent Browser",
    description: "Show the Browser tab in the right sidebar for live agent-browser viewing",
    enabledByDefault: false,
    userOverridable: true,
    showInSettings: true,
  },
  [EXPERIMENT_IDS.PORTABLE_DESKTOP]: {
    id: EXPERIMENT_IDS.PORTABLE_DESKTOP,
    name: "Portable Desktop",
    description: "Enable virtual desktop sessions for GUI-based agent interactions",
    enabledByDefault: false,
    userOverridable: true,
    platformRestriction: ["linux"],
    showInSettings: true,
  },
};

function getPlatformDisplayName(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    case "win32":
      return "Windows";
    default:
      return platform;
  }
}

export function isExperimentSupportedOnPlatform(
  experiment: ExperimentDefinition | ExperimentId,
  platform: NodeJS.Platform | null | undefined
): boolean {
  const definition = typeof experiment === "string" ? EXPERIMENTS[experiment] : experiment;

  if (!definition.platformRestriction?.length || platform == null) {
    return true;
  }

  return definition.platformRestriction.includes(platform);
}

export function getExperimentPlatformRestrictionLabel(
  experiment: ExperimentDefinition | ExperimentId
): string | null {
  const definition = typeof experiment === "string" ? EXPERIMENTS[experiment] : experiment;
  const platforms = definition.platformRestriction;

  if (!platforms?.length) {
    return null;
  }

  const platformLabels = platforms.map(getPlatformDisplayName);
  if (platformLabels.length === 1) {
    return `Only available on ${platformLabels[0]}`;
  }

  if (platformLabels.length === 2) {
    return `Only available on ${platformLabels[0]} and ${platformLabels[1]}`;
  }

  const lastPlatform = platformLabels[platformLabels.length - 1];
  return `Only available on ${platformLabels.slice(0, -1).join(", ")}, and ${lastPlatform}`;
}

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
