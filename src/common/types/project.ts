/**
 * Project and workspace configuration types.
 * Kept lightweight for preload script usage.
 */

import type { z } from "zod";
import type {
  ProjectConfigSchema,
  SectionConfigSchema,
  WorkspaceConfigSchema,
} from "../orpc/schemas";
import type { TaskSettings, SubagentAiDefaults } from "./tasks";
import type { LayoutPresetsConfig } from "./uiLayouts";
import type { AgentAiDefaults } from "./agentAiDefaults";

export type Workspace = z.infer<typeof WorkspaceConfigSchema>;

export type SectionConfig = z.infer<typeof SectionConfigSchema>;

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export type FeatureFlagOverride = "default" | "on" | "off";

/**
 * Update channel preference for Electron desktop app.
 * Keep in sync with `UpdateChannelSchema` in `src/common/orpc/schemas/api.ts`.
 */
export type UpdateChannel = "stable" | "nightly";

export interface ProjectsConfig {
  projects: Map<string, ProjectConfig>;
  /**
   * Update channel preference for Electron desktop app. Defaults to "stable".
   */
  updateChannel?: UpdateChannel;
  /**
   * Bind host/interface for the desktop HTTP/WS API server.
   *
   * When unset, mux binds to 127.0.0.1 (localhost only).
   * When set to 0.0.0.0 or ::, mux can be reachable from other devices on your LAN/VPN.
   */
  apiServerBindHost?: string;
  /**
   * Port for the desktop HTTP/WS API server.
   *
   * When unset, mux binds to port 0 (random available port).
   */
  apiServerPort?: number;
  /**
   * When true, the desktop HTTP server also serves the mux web UI at /.
   *
   * This enables other devices (LAN/VPN) to open mux in a browser.
   */
  apiServerServeWebUi?: boolean;
  /**
   * Advertise the API server on the local network via mDNS/Bonjour (DNS-SD).
   *
   * When unset, mux uses "auto" behavior (advertise only when apiServerBindHost is non-loopback).
   */
  mdnsAdvertisementEnabled?: boolean;
  /** Optional mDNS DNS-SD service instance name override. */
  mdnsServiceName?: string;
  /** SSH hostname/alias for this machine (used for editor deep links in browser mode) */
  serverSshHost?: string;
  /**
   * Optional GitHub username allowed to authenticate server/browser mode via Device Flow.
   *
   * When unset, GitHub login is disabled and token-only auth remains in effect.
   */
  serverAuthGithubOwner?: string;
  /**
   * Default parent directory for new projects (cloning and bare-name creation).
   *
   * When unset, falls back to getMuxProjectsDir() (~/.mux/projects).
   */
  defaultProjectDir?: string;
  /** IDs of splash screens that have been viewed */
  viewedSplashScreens?: string[];
  /** Cross-client feature flag overrides (shared via ~/.mux/config.json). */
  featureFlagOverrides?: Record<string, FeatureFlagOverride>;
  /** Global task settings (agent sub-workspaces, queue limits, nesting depth) */
  taskSettings?: TaskSettings;
  /** UI layout presets + hotkeys (shared via ~/.mux/config.json). */
  layoutPresets?: LayoutPresetsConfig;
  /**
   * Mux Gateway routing preferences (shared via ~/.mux/config.json).
   * Mirrors browser localStorage so switching server ports doesn't reset the UI.
   */
  muxGatewayEnabled?: boolean;
  muxGatewayModels?: string[];

  /**
   * Default model used for new workspaces (shared via ~/.mux/config.json).
   * Mirrors the browser localStorage cache (DEFAULT_MODEL_KEY).
   */
  defaultModel?: string;
  /**
   * Hidden model IDs (shared via ~/.mux/config.json).
   * Mirrors the browser localStorage cache (HIDDEN_MODELS_KEY).
   */
  hiddenModels?: string[];
  /**
   * Preferred model for compaction requests (shared via ~/.mux/config.json).
   * Mirrors the browser localStorage cache (PREFERRED_COMPACTION_MODEL_KEY).
   */
  preferredCompactionModel?: string;

  /** Default model + thinking overrides per agentId (applies to UI agents and subagents). */
  agentAiDefaults?: AgentAiDefaults;
  /** @deprecated Legacy per-subagent default model + thinking overrides. */
  subagentAiDefaults?: SubagentAiDefaults;
  /** Use built-in SSH2 library instead of system OpenSSH for remote connections (non-Windows only) */
  useSSH2Transport?: boolean;

  /** Mux Governor server URL (normalized origin, no trailing slash) */
  muxGovernorUrl?: string;
  /** Mux Governor OAuth access token (secret - never return to UI) */
  muxGovernorToken?: string;

  /**
   * When true (default), archiving a Mux workspace will stop its dedicated mux-created Coder
   * workspace first, and unarchiving will attempt to start it again.
   *
   * Stored as `false` only (undefined behaves as true) to keep config.json minimal.
   */
  stopCoderWorkspaceOnArchive?: boolean;

  /**
   * Override the default shell for local integrated terminals.
   *
   * When set, all local terminals (not SSH/Docker/Devcontainer) spawn this shell
   * instead of auto-detecting from $SHELL or platform defaults.
   *
   * Accepts an absolute path (e.g. "/usr/bin/fish") or a command name (e.g. "fish").
   */
  terminalDefaultShell?: string;
}
