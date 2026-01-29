import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as jsonc from "jsonc-parser";
import writeFileAtomic from "write-file-atomic";
import { log } from "@/node/services/log";
import { SectionConfigSchema, WorkspaceConfigSchema } from "@/common/orpc/schemas";
import type { StartupNotice } from "@/common/orpc/types";
import type { WorkspaceMetadata, FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { Secret, SecretsConfig } from "@/common/types/secrets";
import type {
  Workspace,
  ProjectConfig,
  ProjectsConfig,
  FeatureFlagOverride,
} from "@/common/types/project";
import {
  DEFAULT_TASK_SETTINGS,
  normalizeSubagentAiDefaults,
  normalizeTaskSettings,
} from "@/common/types/tasks";
import { isLayoutPresetsConfigEmpty, normalizeLayoutPresetsConfig } from "@/common/types/uiLayouts";
import { normalizeAgentAiDefaults } from "@/common/types/agentAiDefaults";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { isIncompatibleRuntimeConfig } from "@/common/utils/runtimeCompatibility";
import { getMuxHome } from "@/common/constants/paths";
import { PlatformPaths } from "@/common/utils/paths";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";
import { getContainerName as getDockerContainerName } from "@/node/runtime/DockerRuntime";

// Re-export project types from dedicated types file (for preload usage)
export type { Workspace, ProjectConfig, ProjectsConfig };

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

function parseOptionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseOptionalEnvBoolean(value: unknown): boolean | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }

  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }

  return undefined;
}
function parseOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((item): item is string => typeof item === "string");
}
function parseOptionalPort(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return undefined;
  }

  if (value < 0 || value > 65535) {
    return undefined;
  }

  return value;
}
export type ProvidersConfig = Record<string, ProviderConfig>;

const SANITIZATION_DETAIL_LIMIT = 6;

export interface SanitizationSummary {
  workspaceListsReset: number;
  workspacesDropped: number;
  pathsRepaired: number;
  orphanParentsCleared: number;
  cycleParentsCleared: number;
  cyclesBroken: number;
  sectionsDropped: number;
  fieldsNormalized: number;
  projectsTouched: number;
  details: string[];
  detailsOverflow: number;
}

export interface SanitizationResult {
  config: ProjectsConfig;
  summary: SanitizationSummary;
}

/**
 * Config - Centralized configuration management
 *
 * Encapsulates all config paths and operations, making them dependency-injectable
 * and testable. Pass a custom rootDir for tests to avoid polluting ~/.mux
 */
export class Config {
  readonly rootDir: string;
  readonly sessionsDir: string;
  readonly srcDir: string;
  private readonly configFile: string;
  private readonly providersFile: string;
  private readonly secretsFile: string;
  private pendingStartupNotices: StartupNotice[] = [];

  constructor(rootDir?: string) {
    this.rootDir = rootDir ?? getMuxHome();
    this.sessionsDir = path.join(this.rootDir, "sessions");
    this.srcDir = path.join(this.rootDir, "src");
    this.configFile = path.join(this.rootDir, "config.json");
    this.providersFile = path.join(this.rootDir, "providers.jsonc");
    this.secretsFile = path.join(this.rootDir, "secrets.json");
  }

  loadConfigOrDefault(): ProjectsConfig {
    try {
      if (fs.existsSync(this.configFile)) {
        const data = fs.readFileSync(this.configFile, "utf-8");
        const parsed = JSON.parse(data) as {
          projects?: unknown;
          apiServerBindHost?: unknown;
          apiServerPort?: unknown;
          apiServerServeWebUi?: unknown;
          mdnsAdvertisementEnabled?: unknown;
          mdnsServiceName?: unknown;
          serverSshHost?: string;
          viewedSplashScreens?: string[];
          featureFlagOverrides?: Record<string, "default" | "on" | "off">;
          layoutPresets?: unknown;
          taskSettings?: unknown;
          muxGatewayEnabled?: unknown;
          muxGatewayModels?: unknown;
          agentAiDefaults?: unknown;
          subagentAiDefaults?: unknown;
          useSSH2Transport?: unknown;
        };

        // Config is stored as array of [path, config] pairs
        if (parsed.projects && Array.isArray(parsed.projects)) {
          const rawPairs = parsed.projects as Array<[string, ProjectConfig]>;
          // Migrate: normalize project paths by stripping trailing slashes
          // This fixes configs created with paths like "/home/user/project/"
          // Also filter out any malformed entries (null/undefined paths)
          const normalizedPairs = rawPairs
            .filter(([projectPath]) => {
              if (!projectPath || typeof projectPath !== "string") {
                log.warn("Filtering out project with invalid path", { projectPath });
                return false;
              }
              return true;
            })
            .map(([projectPath, projectConfig]) => {
              return [stripTrailingSlashes(projectPath), projectConfig] as [string, ProjectConfig];
            });
          const projectsMap = new Map<string, ProjectConfig>(normalizedPairs);

          const taskSettings = normalizeTaskSettings(parsed.taskSettings);

          const muxGatewayEnabled = parseOptionalBoolean(parsed.muxGatewayEnabled);
          const muxGatewayModels = parseOptionalStringArray(parsed.muxGatewayModels);
          const legacySubagentAiDefaults = normalizeSubagentAiDefaults(parsed.subagentAiDefaults);

          const agentAiDefaults =
            parsed.agentAiDefaults !== undefined
              ? normalizeAgentAiDefaults(parsed.agentAiDefaults)
              : normalizeAgentAiDefaults(legacySubagentAiDefaults);

          const layoutPresetsRaw = normalizeLayoutPresetsConfig(parsed.layoutPresets);
          const layoutPresets = isLayoutPresetsConfigEmpty(layoutPresetsRaw)
            ? undefined
            : layoutPresetsRaw;

          return {
            projects: projectsMap,
            apiServerBindHost: parseOptionalNonEmptyString(parsed.apiServerBindHost),
            apiServerServeWebUi: parseOptionalBoolean(parsed.apiServerServeWebUi)
              ? true
              : undefined,
            apiServerPort: parseOptionalPort(parsed.apiServerPort),
            mdnsAdvertisementEnabled: parseOptionalBoolean(parsed.mdnsAdvertisementEnabled),
            mdnsServiceName: parseOptionalNonEmptyString(parsed.mdnsServiceName),
            serverSshHost: parsed.serverSshHost,
            viewedSplashScreens: parsed.viewedSplashScreens,
            layoutPresets,
            taskSettings,
            muxGatewayEnabled,
            muxGatewayModels,
            agentAiDefaults,
            // Legacy fields are still parsed and returned for downgrade compatibility.
            subagentAiDefaults: legacySubagentAiDefaults,
            featureFlagOverrides: parsed.featureFlagOverrides,
            useSSH2Transport: parseOptionalBoolean(parsed.useSSH2Transport),
          };
        }
      }
    } catch (error) {
      log.error("Error loading config:", error);
    }

    // Return default config
    return {
      projects: new Map(),
      taskSettings: DEFAULT_TASK_SETTINGS,
      agentAiDefaults: {},
      subagentAiDefaults: {},
    };
  }

  async saveConfig(config: ProjectsConfig): Promise<void> {
    try {
      if (!fs.existsSync(this.rootDir)) {
        fs.mkdirSync(this.rootDir, { recursive: true });
      }

      const data: {
        projects: Array<[string, ProjectConfig]>;
        apiServerBindHost?: string;
        apiServerPort?: number;
        apiServerServeWebUi?: boolean;
        mdnsAdvertisementEnabled?: boolean;
        mdnsServiceName?: string;
        serverSshHost?: string;
        viewedSplashScreens?: string[];
        layoutPresets?: ProjectsConfig["layoutPresets"];
        featureFlagOverrides?: ProjectsConfig["featureFlagOverrides"];
        taskSettings?: ProjectsConfig["taskSettings"];
        muxGatewayEnabled?: ProjectsConfig["muxGatewayEnabled"];
        muxGatewayModels?: ProjectsConfig["muxGatewayModels"];
        agentAiDefaults?: ProjectsConfig["agentAiDefaults"];
        subagentAiDefaults?: ProjectsConfig["subagentAiDefaults"];
        useSSH2Transport?: boolean;
      } = {
        projects: Array.from(config.projects.entries()),
        taskSettings: config.taskSettings ?? DEFAULT_TASK_SETTINGS,
      };

      const muxGatewayEnabled = parseOptionalBoolean(config.muxGatewayEnabled);
      if (muxGatewayEnabled !== undefined) {
        data.muxGatewayEnabled = muxGatewayEnabled;
      }

      const muxGatewayModels = parseOptionalStringArray(config.muxGatewayModels);
      if (muxGatewayModels !== undefined) {
        data.muxGatewayModels = muxGatewayModels;
      }
      const apiServerBindHost = parseOptionalNonEmptyString(config.apiServerBindHost);
      if (apiServerBindHost) {
        data.apiServerBindHost = apiServerBindHost;
      }

      const apiServerServeWebUi = parseOptionalBoolean(config.apiServerServeWebUi);
      if (apiServerServeWebUi) {
        data.apiServerServeWebUi = true;
      }

      const apiServerPort = parseOptionalPort(config.apiServerPort);
      if (apiServerPort !== undefined) {
        data.apiServerPort = apiServerPort;
      }

      const mdnsAdvertisementEnabled = parseOptionalBoolean(config.mdnsAdvertisementEnabled);
      if (mdnsAdvertisementEnabled !== undefined) {
        data.mdnsAdvertisementEnabled = mdnsAdvertisementEnabled;
      }

      const mdnsServiceName = parseOptionalNonEmptyString(config.mdnsServiceName);
      if (mdnsServiceName) {
        data.mdnsServiceName = mdnsServiceName;
      }

      if (config.serverSshHost) {
        data.serverSshHost = config.serverSshHost;
      }
      if (config.featureFlagOverrides) {
        data.featureFlagOverrides = config.featureFlagOverrides;
      }
      if (config.layoutPresets) {
        const normalized = normalizeLayoutPresetsConfig(config.layoutPresets);
        if (!isLayoutPresetsConfigEmpty(normalized)) {
          data.layoutPresets = normalized;
        }
      }
      if (config.viewedSplashScreens) {
        data.viewedSplashScreens = config.viewedSplashScreens;
      }
      if (config.agentAiDefaults && Object.keys(config.agentAiDefaults).length > 0) {
        data.agentAiDefaults = config.agentAiDefaults;

        const legacySubagent: Record<string, unknown> = {};
        for (const [id, entry] of Object.entries(config.agentAiDefaults)) {
          if (id === "plan" || id === "exec" || id === "compact") continue;
          legacySubagent[id] = entry;
        }
        if (Object.keys(legacySubagent).length > 0) {
          data.subagentAiDefaults = legacySubagent as ProjectsConfig["subagentAiDefaults"];
        }
      } else {
        // Legacy only.
        if (config.subagentAiDefaults && Object.keys(config.subagentAiDefaults).length > 0) {
          data.subagentAiDefaults = config.subagentAiDefaults;
        }
      }

      if (config.useSSH2Transport !== undefined) {
        data.useSSH2Transport = config.useSSH2Transport;
      }

      await writeFileAtomic(this.configFile, JSON.stringify(data, null, 2), "utf-8");
    } catch (error) {
      log.error("Error saving config:", error);
    }
  }

  /**
   * Edit config atomically using a transformation function
   * @param fn Function that takes current config and returns modified config
   */
  async editConfig(fn: (config: ProjectsConfig) => ProjectsConfig): Promise<void> {
    const config = this.loadConfigOrDefault();
    const newConfig = fn(config);
    await this.saveConfig(newConfig);
  }

  consumeStartupNotices(): StartupNotice[] {
    const notices = [...this.pendingStartupNotices];
    this.pendingStartupNotices = [];
    return notices;
  }

  async sanitizePersistedConfig(): Promise<void> {
    try {
      const config = this.loadConfigOrDefault();
      const result = sanitizeProjectsConfig(config);
      if (!hasSanitizationChanges(result.summary)) {
        return;
      }

      await this.saveConfig(result.config);

      const notice = buildConfigSanitizationNotice(result.summary);
      if (notice) {
        // Surface auto-repairs to avoid silent data loss when config.json is sanitized on startup.
        this.pendingStartupNotices.push(notice);
      }

      log.warn("Sanitized mux config.json at startup", {
        workspaceListsReset: result.summary.workspaceListsReset,
        workspacesDropped: result.summary.workspacesDropped,
        pathsRepaired: result.summary.pathsRepaired,
        orphanParentsCleared: result.summary.orphanParentsCleared,
        cycleParentsCleared: result.summary.cycleParentsCleared,
        cyclesBroken: result.summary.cyclesBroken,
        sectionsDropped: result.summary.sectionsDropped,
        fieldsNormalized: result.summary.fieldsNormalized,
        projectsTouched: result.summary.projectsTouched,
      });
    } catch (error) {
      log.warn("sanitizePersistedConfig failed; continuing", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Cross-client feature flag overrides (shared via ~/.mux/config.json).
   */
  getFeatureFlagOverride(flagKey: string): FeatureFlagOverride {
    const config = this.loadConfigOrDefault();
    const override = config.featureFlagOverrides?.[flagKey];
    if (override === "on" || override === "off" || override === "default") {
      return override;
    }
    return "default";
  }

  async setFeatureFlagOverride(flagKey: string, override: FeatureFlagOverride): Promise<void> {
    await this.editConfig((config) => {
      const next = { ...(config.featureFlagOverrides ?? {}) };
      if (override === "default") {
        delete next[flagKey];
      } else {
        next[flagKey] = override;
      }

      config.featureFlagOverrides = Object.keys(next).length > 0 ? next : undefined;
      return config;
    });
  }

  /**
   * mDNS advertisement enablement.
   *
   * - true: attempt to advertise (will warn if the API server is loopback-only)
   * - false: never advertise
   * - undefined: "auto" (advertise only when the API server is LAN-reachable)
   */
  getMdnsAdvertisementEnabled(): boolean | undefined {
    const envOverride = parseOptionalEnvBoolean(process.env.MUX_MDNS_ADVERTISE);
    if (envOverride !== undefined) {
      return envOverride;
    }

    const config = this.loadConfigOrDefault();
    return config.mdnsAdvertisementEnabled;
  }

  /** Optional DNS-SD service instance name override. */
  getMdnsServiceName(): string | undefined {
    const envName = parseOptionalNonEmptyString(process.env.MUX_MDNS_SERVICE_NAME);
    if (envName) {
      return envName;
    }

    const config = this.loadConfigOrDefault();
    return config.mdnsServiceName;
  }

  /**
   * Get the configured SSH hostname for this server (used for editor deep links in browser mode).
   */
  getServerSshHost(): string | undefined {
    const config = this.loadConfigOrDefault();
    return config.serverSshHost;
  }

  private getProjectName(projectPath: string): string {
    return PlatformPaths.getProjectName(projectPath);
  }

  /**
   * Generate a stable unique workspace ID.
   * Uses 10 random hex characters for readability while maintaining uniqueness.
   *
   * Example: "a1b2c3d4e5"
   */
  generateStableId(): string {
    // Generate 5 random bytes and convert to 10 hex chars
    return crypto.randomBytes(5).toString("hex");
  }

  /**
   * DEPRECATED: Generate legacy workspace ID from project and workspace paths.
   * This method is used only for legacy workspace migration to look up old workspaces.
   * New workspaces use generateStableId() which returns a random stable ID.
   *
   * DO NOT use this method or its format to construct workspace IDs anywhere in the codebase.
   * Workspace IDs are backend implementation details and must only come from backend operations.
   */
  generateLegacyId(projectPath: string, workspacePath: string): string {
    const projectBasename = this.getProjectName(projectPath);
    const workspaceBasename = PlatformPaths.basename(workspacePath);
    return `${projectBasename}-${workspaceBasename}`;
  }

  /**
   * Get the workspace directory path for a given directory name.
   * The directory name is the workspace name (branch name).
   */

  /**
   * Add paths to WorkspaceMetadata to create FrontendWorkspaceMetadata.
   * Helper to avoid duplicating path computation logic.
   */
  private addPathsToMetadata(
    metadata: WorkspaceMetadata,
    workspacePath: string,
    _projectPath: string
  ): FrontendWorkspaceMetadata {
    const result: FrontendWorkspaceMetadata = {
      ...metadata,
      namedWorkspacePath: workspacePath,
    };

    // Check for incompatible runtime configs (from newer mux versions)
    if (isIncompatibleRuntimeConfig(metadata.runtimeConfig)) {
      result.incompatibleRuntime =
        "This workspace was created with a newer version of mux. " +
        "Please upgrade mux to use this workspace.";
    }

    return result;
  }

  /**
   * Find a workspace path and project path by workspace ID
   * @returns Object with workspace and project paths, or null if not found
   */
  findWorkspace(workspaceId: string): { workspacePath: string; projectPath: string } | null {
    const config = this.loadConfigOrDefault();

    for (const [projectPath, project] of config.projects) {
      for (const workspace of project.workspaces) {
        // NEW FORMAT: Check config first (primary source of truth after migration)
        if (workspace.id === workspaceId) {
          if (typeof workspace.path !== "string" || workspace.path.trim().length === 0) {
            log.warn("Skipping workspace with invalid path in config", {
              projectPath,
              workspaceId,
            });
            continue;
          }
          return { workspacePath: workspace.path, projectPath };
        }

        // LEGACY FORMAT: Fall back to metadata.json and legacy ID for unmigrated workspaces
        if (!workspace.id) {
          if (typeof workspace.path !== "string") {
            log.warn("Skipping workspace with invalid path in config", {
              projectPath,
              workspaceId,
            });
            continue;
          }

          const workspacePath = workspace.path.trim();
          if (!workspacePath) {
            log.warn("Skipping workspace with invalid path in config", {
              projectPath,
              workspaceId,
            });
            continue;
          }

          // Extract workspace basename (could be stable ID or legacy name)
          const workspaceBasename =
            workspacePath.split("/").pop() ?? workspacePath.split("\\").pop() ?? "unknown";

          // Try loading metadata with basename as ID (works for old workspaces)
          const metadataPath = path.join(this.getSessionDir(workspaceBasename), "metadata.json");
          if (fs.existsSync(metadataPath)) {
            try {
              const data = fs.readFileSync(metadataPath, "utf-8");
              const metadata = JSON.parse(data) as WorkspaceMetadata;
              if (metadata.id === workspaceId) {
                return { workspacePath, projectPath };
              }
            } catch {
              // Ignore parse errors, try legacy ID
            }
          }

          // Try legacy ID format as last resort
          const legacyId = this.generateLegacyId(projectPath, workspacePath);
          if (legacyId === workspaceId) {
            return { workspacePath, projectPath };
          }
        }
      }
    }

    return null;
  }

  /**
   * Workspace Path Architecture:
   *
   * Workspace paths are computed on-demand from projectPath + workspace name using
   * config.getWorkspacePath(projectPath, directoryName). This ensures a single source of truth.
   *
   * - Worktree directory name: uses workspace.name (the branch name)
   * - Workspace ID: stable random identifier for identity and sessions (not used for directories)
   *
   * Backend: Uses getWorkspacePath(metadata.projectPath, metadata.name) for workspace directory paths
   * Frontend: Gets enriched metadata with paths via IPC (FrontendWorkspaceMetadata)
   *
   * WorkspaceMetadata.workspacePath is deprecated and will be removed. Use computed
   * paths from getWorkspacePath() or getWorkspacePaths() instead.
   */

  /**
   * Get the session directory for a specific workspace
   */
  getSessionDir(workspaceId: string): string {
    return path.join(this.sessionsDir, workspaceId);
  }

  /**
   * Get all workspace metadata by loading config and metadata files.
   *
   * Returns FrontendWorkspaceMetadata with paths already computed.
   * This eliminates the need for separate "enrichment" - paths are computed
   * once during the loop when we already have all the necessary data.
   *
   * NEW BEHAVIOR: Config is the primary source of truth
   * - If workspace has id/name/createdAt in config, use those directly
   * - If workspace only has path, fall back to reading metadata.json
   * - Migrate old workspaces by copying metadata from files to config
   *
   * This centralizes workspace metadata in config.json and eliminates the need
   * for scattered metadata.json files (kept for backward compat with older versions).
   *
   * GUARANTEE: Every workspace returned will have a createdAt timestamp.
   * If missing from config or legacy metadata, a new timestamp is assigned and
   * saved to config for subsequent loads.
   */
  async getAllWorkspaceMetadata(): Promise<FrontendWorkspaceMetadata[]> {
    const config = this.loadConfigOrDefault();
    const workspaceMetadata: FrontendWorkspaceMetadata[] = [];
    let configModified = false;

    for (const [projectPath, projectConfig] of config.projects) {
      // Validate project path is not empty (defensive check for corrupted config)
      if (!projectPath) {
        log.warn("Skipping project with empty path in config", {
          workspaceCount: projectConfig.workspaces?.length ?? 0,
        });
        continue;
      }

      const projectName = this.getProjectName(projectPath);

      for (const workspace of projectConfig.workspaces) {
        if (typeof workspace.path !== "string" || workspace.path.trim().length === 0) {
          log.warn("Skipping workspace with invalid path in config", {
            projectPath,
            workspaceId: workspace.id,
          });
          continue;
        }

        const workspacePath = workspace.path.trim();
        // Extract workspace basename from path (could be stable ID or legacy name)
        const workspaceBasename =
          workspacePath.split("/").pop() ?? workspacePath.split("\\").pop() ?? "unknown";

        try {
          // NEW FORMAT: If workspace has metadata in config, use it directly
          if (workspace.id && workspace.name) {
            const metadata: WorkspaceMetadata = {
              id: workspace.id,
              name: workspace.name,
              title: workspace.title,
              projectName,
              projectPath,
              // GUARANTEE: All workspaces must have createdAt (assign now if missing)
              createdAt: workspace.createdAt ?? new Date().toISOString(),
              // GUARANTEE: All workspaces must have runtimeConfig (apply default if missing)
              runtimeConfig: workspace.runtimeConfig ?? DEFAULT_RUNTIME_CONFIG,
              aiSettings: workspace.aiSettings,
              aiSettingsByAgent:
                workspace.aiSettingsByAgent ??
                (workspace.aiSettings
                  ? {
                      plan: workspace.aiSettings,
                      exec: workspace.aiSettings,
                    }
                  : undefined),
              parentWorkspaceId: workspace.parentWorkspaceId,
              agentType: workspace.agentType,
              taskStatus: workspace.taskStatus,
              reportedAt: workspace.reportedAt,
              taskModelString: workspace.taskModelString,
              taskThinkingLevel: workspace.taskThinkingLevel,
              taskPrompt: workspace.taskPrompt,
              taskTrunkBranch: workspace.taskTrunkBranch,
              archivedAt: workspace.archivedAt,
              unarchivedAt: workspace.unarchivedAt,
              sectionId: workspace.sectionId,
            };

            // Migrate missing createdAt to config for next load
            if (!workspace.createdAt) {
              workspace.createdAt = metadata.createdAt;
              configModified = true;
            }

            // Migrate missing runtimeConfig to config for next load
            if (!workspace.aiSettingsByAgent) {
              const derived = workspace.aiSettings
                ? {
                    plan: workspace.aiSettings,
                    exec: workspace.aiSettings,
                  }
                : undefined;
              if (derived) {
                workspace.aiSettingsByAgent = derived;
                configModified = true;
              }
            }

            if (!workspace.runtimeConfig) {
              workspace.runtimeConfig = metadata.runtimeConfig;
              configModified = true;
            }

            // Populate containerName for Docker workspaces (computed from project path and workspace name)
            if (
              metadata.runtimeConfig?.type === "docker" &&
              !metadata.runtimeConfig.containerName
            ) {
              metadata.runtimeConfig = {
                ...metadata.runtimeConfig,
                containerName: getDockerContainerName(projectPath, metadata.name),
              };
            }

            workspaceMetadata.push(this.addPathsToMetadata(metadata, workspacePath, projectPath));
            continue; // Skip metadata file lookup
          }

          // LEGACY FORMAT: Fall back to reading metadata.json
          // Try legacy ID format first (project-workspace) - used by E2E tests and old workspaces
          const legacyId = this.generateLegacyId(projectPath, workspacePath);
          const metadataPath = path.join(this.getSessionDir(legacyId), "metadata.json");
          let metadataFound = false;

          if (fs.existsSync(metadataPath)) {
            const data = fs.readFileSync(metadataPath, "utf-8");
            const metadata = JSON.parse(data) as WorkspaceMetadata;

            // Ensure required fields are present
            if (!metadata.name) metadata.name = workspaceBasename;
            if (!metadata.projectPath) metadata.projectPath = projectPath;
            if (!metadata.projectName) metadata.projectName = projectName;

            // GUARANTEE: All workspaces must have createdAt
            metadata.createdAt ??= new Date().toISOString();

            // GUARANTEE: All workspaces must have runtimeConfig
            metadata.runtimeConfig ??= DEFAULT_RUNTIME_CONFIG;

            // Preserve any config-only fields that may not exist in legacy metadata.json
            metadata.aiSettingsByAgent ??=
              workspace.aiSettingsByAgent ??
              (workspace.aiSettings
                ? {
                    plan: workspace.aiSettings,
                    exec: workspace.aiSettings,
                  }
                : undefined);
            metadata.aiSettings ??= workspace.aiSettings;

            // Preserve tree/task metadata when present in config (metadata.json won't have it)
            metadata.parentWorkspaceId ??= workspace.parentWorkspaceId;
            metadata.agentType ??= workspace.agentType;
            metadata.taskStatus ??= workspace.taskStatus;
            metadata.reportedAt ??= workspace.reportedAt;
            metadata.taskModelString ??= workspace.taskModelString;
            metadata.taskThinkingLevel ??= workspace.taskThinkingLevel;
            metadata.taskPrompt ??= workspace.taskPrompt;
            metadata.taskTrunkBranch ??= workspace.taskTrunkBranch;
            // Preserve archived timestamps from config
            metadata.archivedAt ??= workspace.archivedAt;
            metadata.unarchivedAt ??= workspace.unarchivedAt;
            // Preserve section assignment from config
            metadata.sectionId ??= workspace.sectionId;
            if (!workspace.aiSettingsByAgent && metadata.aiSettingsByAgent) {
              workspace.aiSettingsByAgent = metadata.aiSettingsByAgent;
              configModified = true;
            }

            // Migrate to config for next load
            workspace.id = metadata.id;
            workspace.name = metadata.name;
            workspace.createdAt = metadata.createdAt;
            workspace.runtimeConfig = metadata.runtimeConfig;
            configModified = true;

            workspaceMetadata.push(this.addPathsToMetadata(metadata, workspacePath, projectPath));
            metadataFound = true;
          }

          // No metadata found anywhere - create basic metadata
          if (!metadataFound) {
            const legacyId = this.generateLegacyId(projectPath, workspacePath);
            const metadata: WorkspaceMetadata = {
              id: legacyId,
              name: workspaceBasename,
              projectName,
              projectPath,
              // GUARANTEE: All workspaces must have createdAt
              createdAt: new Date().toISOString(),
              // GUARANTEE: All workspaces must have runtimeConfig
              runtimeConfig: DEFAULT_RUNTIME_CONFIG,
              aiSettings: workspace.aiSettings,
              aiSettingsByAgent:
                workspace.aiSettingsByAgent ??
                (workspace.aiSettings
                  ? {
                      plan: workspace.aiSettings,
                      exec: workspace.aiSettings,
                    }
                  : undefined),
              parentWorkspaceId: workspace.parentWorkspaceId,
              agentType: workspace.agentType,
              taskStatus: workspace.taskStatus,
              reportedAt: workspace.reportedAt,
              taskModelString: workspace.taskModelString,
              taskThinkingLevel: workspace.taskThinkingLevel,
              taskPrompt: workspace.taskPrompt,
              taskTrunkBranch: workspace.taskTrunkBranch,
              archivedAt: workspace.archivedAt,
              unarchivedAt: workspace.unarchivedAt,
              sectionId: workspace.sectionId,
            };

            // Save to config for next load
            workspace.id = metadata.id;
            workspace.name = metadata.name;
            workspace.createdAt = metadata.createdAt;
            workspace.runtimeConfig = metadata.runtimeConfig;
            configModified = true;

            workspaceMetadata.push(this.addPathsToMetadata(metadata, workspacePath, projectPath));
          }
        } catch (error) {
          log.error(`Failed to load/migrate workspace metadata:`, error);
          // Fallback to basic metadata if migration fails
          const legacyId = this.generateLegacyId(projectPath, workspacePath);
          const metadata: WorkspaceMetadata = {
            id: legacyId,
            name: workspaceBasename,
            projectName,
            projectPath,
            // GUARANTEE: All workspaces must have createdAt (even in error cases)
            createdAt: new Date().toISOString(),
            // GUARANTEE: All workspaces must have runtimeConfig (even in error cases)
            runtimeConfig: DEFAULT_RUNTIME_CONFIG,
            aiSettings: workspace.aiSettings,
            aiSettingsByAgent:
              workspace.aiSettingsByAgent ??
              (workspace.aiSettings
                ? {
                    plan: workspace.aiSettings,
                    exec: workspace.aiSettings,
                  }
                : undefined),
            parentWorkspaceId: workspace.parentWorkspaceId,
            agentType: workspace.agentType,
            taskStatus: workspace.taskStatus,
            reportedAt: workspace.reportedAt,
            taskModelString: workspace.taskModelString,
            taskThinkingLevel: workspace.taskThinkingLevel,
            taskPrompt: workspace.taskPrompt,
            taskTrunkBranch: workspace.taskTrunkBranch,
            sectionId: workspace.sectionId,
          };
          workspaceMetadata.push(this.addPathsToMetadata(metadata, workspacePath, projectPath));
        }
      }
    }

    // Save config if we migrated any workspaces
    if (configModified) {
      await this.saveConfig(config);
    }

    return workspaceMetadata;
  }

  /**
   * Add a workspace to config.json (single source of truth for workspace metadata).
   * Creates project entry if it doesn't exist.
   *
   * @param projectPath Absolute path to the project
   * @param metadata Workspace metadata to save
   */
  async addWorkspace(
    projectPath: string,
    metadata: WorkspaceMetadata & { namedWorkspacePath?: string }
  ): Promise<void> {
    await this.editConfig((config) => {
      let project = config.projects.get(projectPath);

      if (!project) {
        project = { workspaces: [] };
        config.projects.set(projectPath, project);
      }

      // Check if workspace already exists (by ID)
      const existingIndex = project.workspaces.findIndex((w) => w.id === metadata.id);

      // Use provided namedWorkspacePath if available (runtime-aware),
      // otherwise fall back to worktree-style path for legacy compatibility
      const projectName = this.getProjectName(projectPath);
      const workspacePath =
        metadata.namedWorkspacePath ?? path.join(this.srcDir, projectName, metadata.name);
      const workspaceEntry: Workspace = {
        path: workspacePath,
        id: metadata.id,
        name: metadata.name,
        createdAt: metadata.createdAt,
        runtimeConfig: metadata.runtimeConfig,
      };

      if (existingIndex >= 0) {
        // Update existing workspace
        project.workspaces[existingIndex] = workspaceEntry;
      } else {
        // Add new workspace
        project.workspaces.push(workspaceEntry);
      }

      return config;
    });
  }

  /**
   * Remove a workspace from config.json
   *
   * @param workspaceId ID of the workspace to remove
   */
  async removeWorkspace(workspaceId: string): Promise<void> {
    await this.editConfig((config) => {
      let workspaceFound = false;

      for (const [_projectPath, project] of config.projects) {
        const index = project.workspaces.findIndex((w) => w.id === workspaceId);
        if (index !== -1) {
          project.workspaces.splice(index, 1);
          workspaceFound = true;
          // We don't break here in case duplicates exist (though they shouldn't)
        }
      }

      if (!workspaceFound) {
        log.warn(`Workspace ${workspaceId} not found in config during removal`);
      }

      return config;
    });
  }

  /**
   * Update workspace metadata fields (e.g., regenerate missing title/branch)
   * Used to fix incomplete metadata after errors or restarts
   */
  async updateWorkspaceMetadata(
    workspaceId: string,
    updates: Partial<Pick<WorkspaceMetadata, "name" | "runtimeConfig">>
  ): Promise<void> {
    await this.editConfig((config) => {
      for (const [_projectPath, projectConfig] of config.projects) {
        const workspace = projectConfig.workspaces.find((w) => w.id === workspaceId);
        if (workspace) {
          if (updates.name !== undefined) workspace.name = updates.name;
          if (updates.runtimeConfig !== undefined) workspace.runtimeConfig = updates.runtimeConfig;
          return config;
        }
      }
      throw new Error(`Workspace ${workspaceId} not found in config`);
    });
  }

  /**
   * Load providers configuration from JSONC file
   * Supports comments in JSONC format
   */
  loadProvidersConfig(): ProvidersConfig | null {
    try {
      if (fs.existsSync(this.providersFile)) {
        const data = fs.readFileSync(this.providersFile, "utf-8");
        return jsonc.parse(data) as ProvidersConfig;
      }
    } catch (error) {
      log.error("Error loading providers config:", error);
    }

    return null;
  }

  /**
   * Save providers configuration to JSONC file
   * @param config The providers configuration to save
   */
  saveProvidersConfig(config: ProvidersConfig): void {
    try {
      if (!fs.existsSync(this.rootDir)) {
        fs.mkdirSync(this.rootDir, { recursive: true });
      }

      // Format with 2-space indentation for readability
      const jsonString = JSON.stringify(config, null, 2);

      // Add a comment header to the file
      const contentWithComments = `// Providers configuration for mux
// Configure your AI providers here
// Example:
// {
//   "anthropic": {
//     "apiKey": "sk-ant-..."
//   },
//   "openai": {
//     "apiKey": "sk-..."
//   },
//   "xai": {
//     "apiKey": "sk-xai-..."
//   },
//   "ollama": {
//     "baseUrl": "http://localhost:11434/api"  // Optional - only needed for remote/custom URL
//   }
// }
${jsonString}`;

      fs.writeFileSync(this.providersFile, contentWithComments);
    } catch (error) {
      log.error("Error saving providers config:", error);
      throw error; // Re-throw to let caller handle
    }
  }

  /**
   * Load secrets configuration from JSON file
   * Returns empty config if file doesn't exist
   */
  loadSecretsConfig(): SecretsConfig {
    try {
      if (fs.existsSync(this.secretsFile)) {
        const data = fs.readFileSync(this.secretsFile, "utf-8");
        return JSON.parse(data) as SecretsConfig;
      }
    } catch (error) {
      log.error("Error loading secrets config:", error);
    }

    return {};
  }

  /**
   * Save secrets configuration to JSON file
   * @param config The secrets configuration to save
   */
  async saveSecretsConfig(config: SecretsConfig): Promise<void> {
    try {
      if (!fs.existsSync(this.rootDir)) {
        fs.mkdirSync(this.rootDir, { recursive: true });
      }

      await writeFileAtomic(this.secretsFile, JSON.stringify(config, null, 2), "utf-8");
    } catch (error) {
      log.error("Error saving secrets config:", error);
      throw error;
    }
  }

  /**
   * Get secrets for a specific project
   * @param projectPath The path to the project
   * @returns Array of secrets for the project, or empty array if none
   */
  getProjectSecrets(projectPath: string): Secret[] {
    const config = this.loadSecretsConfig();
    return config[projectPath] ?? [];
  }

  /**
   * Update secrets for a specific project
   * @param projectPath The path to the project
   * @param secrets The secrets to save for the project
   */
  async updateProjectSecrets(projectPath: string, secrets: Secret[]): Promise<void> {
    const config = this.loadSecretsConfig();
    config[projectPath] = secrets;
    await this.saveSecretsConfig(config);
  }
}

function createSanitizationSummary(): SanitizationSummary {
  return {
    workspaceListsReset: 0,
    workspacesDropped: 0,
    pathsRepaired: 0,
    orphanParentsCleared: 0,
    cycleParentsCleared: 0,
    cyclesBroken: 0,
    sectionsDropped: 0,
    fieldsNormalized: 0,
    projectsTouched: 0,
    details: [],
    detailsOverflow: 0,
  };
}

function addSanitizationDetail(summary: SanitizationSummary, detail: string): void {
  if (summary.details.length < SANITIZATION_DETAIL_LIMIT) {
    summary.details.push(detail);
    return;
  }

  summary.detailsOverflow += 1;
}

function formatWorkspaceLabel(workspace: Workspace, projectPath: string): string {
  const workspacePath = typeof workspace.path === "string" ? workspace.path : "";
  const pathLabel = workspacePath ? path.basename(workspacePath) : "unknown workspace";
  const name = workspace.title ?? workspace.name ?? workspace.id ?? pathLabel;
  const projectLabel = path.basename(projectPath) || projectPath;
  return `${name} (${projectLabel})`;
}

function formatCount(count: number, label: string): string {
  if (count === 1) {
    return `${count} ${label}`;
  }
  return `${count} ${label}s`;
}

function hasSanitizationChanges(summary: SanitizationSummary): boolean {
  return (
    summary.workspaceListsReset > 0 ||
    summary.workspacesDropped > 0 ||
    summary.pathsRepaired > 0 ||
    summary.orphanParentsCleared > 0 ||
    summary.cycleParentsCleared > 0 ||
    summary.cyclesBroken > 0 ||
    summary.sectionsDropped > 0 ||
    summary.fieldsNormalized > 0 ||
    summary.projectsTouched > 0
  );
}

function buildConfigSanitizationNotice(summary: SanitizationSummary): StartupNotice | null {
  if (!hasSanitizationChanges(summary)) {
    return null;
  }

  const changes: string[] = [];
  if (summary.workspacesDropped > 0) {
    changes.push(formatCount(summary.workspacesDropped, "workspace removed"));
  }
  if (summary.pathsRepaired > 0) {
    changes.push(formatCount(summary.pathsRepaired, "path repaired"));
  }
  if (summary.orphanParentsCleared > 0) {
    changes.push(formatCount(summary.orphanParentsCleared, "orphan parent cleared"));
  }
  if (summary.cycleParentsCleared > 0) {
    changes.push(formatCount(summary.cycleParentsCleared, "cycle link cleared"));
  }
  if (summary.sectionsDropped > 0) {
    changes.push(formatCount(summary.sectionsDropped, "invalid section removed"));
  }
  if (summary.fieldsNormalized > 0 && changes.length === 0) {
    changes.push(formatCount(summary.fieldsNormalized, "field normalized"));
  }

  const message =
    changes.length > 0
      ? `Mux repaired config.json on startup: ${changes.join(", ")}.`
      : "Mux repaired config.json on startup.";

  const details =
    summary.detailsOverflow > 0
      ? [
          ...summary.details,
          `and ${summary.detailsOverflow} more change${summary.detailsOverflow === 1 ? "" : "s"}.`,
        ]
      : summary.details;

  const level: StartupNotice["level"] =
    summary.workspacesDropped > 0 || summary.cycleParentsCleared > 0 ? "warning" : "info";

  return {
    id: `config-sanitized-${Date.now()}`,
    level,
    title: "Mux repaired your config.json",
    message,
    details: details.length > 0 ? details : undefined,
  };
}

type WorkspaceStringField = "id" | "name" | "title" | "parentWorkspaceId" | "sectionId";

export function sanitizeProjectsConfig(config: ProjectsConfig): SanitizationResult {
  const summary = createSanitizationSummary();

  for (const [projectPath, project] of config.projects) {
    let projectTouched = false;
    const projectLabel = path.basename(projectPath) || projectPath;

    if (!Array.isArray(project.workspaces)) {
      summary.workspaceListsReset += 1;
      project.workspaces = [];
      projectTouched = true;
    }

    const rawWorkspaces = Array.isArray(project.workspaces)
      ? (project.workspaces as unknown[])
      : [];
    const sanitizedWorkspaces: Workspace[] = [];

    const normalizeWorkspaceField = (workspace: Workspace, field: WorkspaceStringField) => {
      const value = workspace[field];
      if (typeof value !== "string") return;
      const trimmed = value.trim();
      const nextValue = trimmed.length > 0 ? trimmed : undefined;
      if (nextValue !== value) {
        workspace[field] = nextValue;
        summary.fieldsNormalized += 1;
        projectTouched = true;
      }
    };

    for (const candidate of rawWorkspaces) {
      if (!candidate || typeof candidate !== "object") {
        summary.workspacesDropped += 1;
        projectTouched = true;
        addSanitizationDetail(summary, `Dropped malformed workspace entry in ${projectLabel}.`);
        continue;
      }

      const workspace = candidate as Workspace;

      if (typeof workspace.path === "string") {
        const trimmedPath = workspace.path.trim();
        if (trimmedPath !== workspace.path) {
          workspace.path = trimmedPath;
          summary.fieldsNormalized += 1;
          projectTouched = true;
        }
      }

      normalizeWorkspaceField(workspace, "id");
      normalizeWorkspaceField(workspace, "name");
      normalizeWorkspaceField(workspace, "title");
      normalizeWorkspaceField(workspace, "parentWorkspaceId");
      normalizeWorkspaceField(workspace, "sectionId");

      const hasValidPath =
        typeof workspace.path === "string" &&
        workspace.path.trim().length > 0 &&
        path.isAbsolute(workspace.path);

      if (!hasValidPath) {
        const fallbackName = typeof workspace.name === "string" ? workspace.name.trim() : undefined;
        if (fallbackName) {
          workspace.path = path.join(projectPath, fallbackName);
          summary.pathsRepaired += 1;
          projectTouched = true;
          addSanitizationDetail(
            summary,
            `Repaired path for workspace ${formatWorkspaceLabel(workspace, projectPath)}.`
          );
        }
      }

      const hasRepairedPath =
        typeof workspace.path === "string" &&
        workspace.path.trim().length > 0 &&
        path.isAbsolute(workspace.path);
      if (!hasRepairedPath) {
        summary.workspacesDropped += 1;
        projectTouched = true;
        addSanitizationDetail(
          summary,
          `Dropped workspace ${formatWorkspaceLabel(workspace, projectPath)} due to invalid path.`
        );
        continue;
      }

      if (!WorkspaceConfigSchema.safeParse(workspace).success) {
        summary.workspacesDropped += 1;
        projectTouched = true;
        addSanitizationDetail(
          summary,
          `Dropped invalid workspace entry ${formatWorkspaceLabel(workspace, projectPath)}.`
        );
        continue;
      }

      sanitizedWorkspaces.push(workspace);
    }

    project.workspaces = sanitizedWorkspaces;

    if (Array.isArray(project.sections)) {
      const rawSections = project.sections as unknown[];
      const sanitizedSections: NonNullable<ProjectConfig["sections"]> = [];
      for (const section of rawSections) {
        if (SectionConfigSchema.safeParse(section).success) {
          sanitizedSections.push(section as NonNullable<ProjectConfig["sections"]>[number]);
        } else {
          summary.sectionsDropped += 1;
          projectTouched = true;
          addSanitizationDetail(summary, `Dropped invalid section in ${projectLabel}.`);
        }
      }

      if (sanitizedSections.length !== rawSections.length) {
        project.sections = sanitizedSections.length > 0 ? sanitizedSections : undefined;
      }
    } else if (project.sections !== undefined) {
      summary.sectionsDropped += 1;
      projectTouched = true;
      project.sections = undefined;
      addSanitizationDetail(summary, `Dropped invalid section data in ${projectLabel}.`);
    }

    const byId = new Map<string, Workspace>();
    for (const workspace of project.workspaces) {
      if (typeof workspace.id !== "string") continue;
      const trimmedId = workspace.id.trim();
      if (!trimmedId) continue;
      if (trimmedId !== workspace.id) {
        workspace.id = trimmedId;
        summary.fieldsNormalized += 1;
        projectTouched = true;
      }
      byId.set(trimmedId, workspace);
    }

    for (const workspace of project.workspaces) {
      if (typeof workspace.parentWorkspaceId !== "string") continue;
      const parentId = workspace.parentWorkspaceId.trim();
      if (!parentId || !byId.has(parentId)) {
        workspace.parentWorkspaceId = undefined;
        summary.orphanParentsCleared += 1;
        projectTouched = true;
        addSanitizationDetail(
          summary,
          `Cleared missing parent for workspace ${formatWorkspaceLabel(workspace, projectPath)}.`
        );
      } else if (parentId !== workspace.parentWorkspaceId) {
        workspace.parentWorkspaceId = parentId;
        summary.fieldsNormalized += 1;
        projectTouched = true;
      }
    }

    const processed = new Set<string>();
    for (const id of byId.keys()) {
      if (processed.has(id)) continue;
      const chain: string[] = [];
      const indexById = new Map<string, number>();
      let current: string | undefined = id;
      while (current) {
        if (processed.has(current)) break;
        const existingIndex = indexById.get(current);
        if (existingIndex !== undefined) {
          const cycleIds = chain.slice(existingIndex);
          if (cycleIds.length > 0) {
            summary.cyclesBroken += 1;
            summary.cycleParentsCleared += cycleIds.length;
            for (const cycleId of cycleIds) {
              const node = byId.get(cycleId);
              if (node) {
                node.parentWorkspaceId = undefined;
              }
            }
            projectTouched = true;
            addSanitizationDetail(
              summary,
              `Broke parent cycle among ${cycleIds.length} workspace${
                cycleIds.length === 1 ? "" : "s"
              } in ${projectLabel}.`
            );
          }
          break;
        }

        indexById.set(current, chain.length);
        chain.push(current);
        const parentId: string | undefined = byId.get(current)?.parentWorkspaceId;
        if (typeof parentId !== "string" || !byId.has(parentId)) break;
        current = parentId;
      }

      for (const visitedId of chain) {
        processed.add(visitedId);
      }
    }

    if (projectTouched) {
      summary.projectsTouched += 1;
    }
  }

  return { config, summary };
}

// Default instance for application use
export const defaultConfig = new Config();
