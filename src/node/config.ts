import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as jsonc from "jsonc-parser";
import writeFileAtomic from "write-file-atomic";
import { log } from "@/node/services/log";
import type { WorkspaceMetadata, FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { Secret, SecretsConfig } from "@/common/types/secrets";
import type { Workspace, ProjectConfig, ProjectsConfig } from "@/common/types/project";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { isIncompatibleRuntimeConfig } from "@/common/utils/runtimeCompatibility";
import { getMuxHome } from "@/common/constants/paths";
import { PlatformPaths } from "@/common/utils/paths";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";

// Re-export project types from dedicated types file (for preload usage)
export type { Workspace, ProjectConfig, ProjectsConfig };

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export type ProvidersConfig = Record<string, ProviderConfig>;

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
          serverSshHost?: string;
          viewedSplashScreens?: string[];
        };

        // Config is stored as array of [path, config] pairs
        if (parsed.projects && Array.isArray(parsed.projects)) {
          const rawPairs = parsed.projects as Array<[string, ProjectConfig]>;
          // Migrate: normalize project paths by stripping trailing slashes
          // This fixes configs created with paths like "/home/user/project/"
          const normalizedPairs = rawPairs.map(([projectPath, projectConfig]) => {
            return [stripTrailingSlashes(projectPath), projectConfig] as [string, ProjectConfig];
          });
          const projectsMap = new Map<string, ProjectConfig>(normalizedPairs);
          return {
            projects: projectsMap,
            serverSshHost: parsed.serverSshHost,
            viewedSplashScreens: parsed.viewedSplashScreens,
          };
        }
      }
    } catch (error) {
      log.error("Error loading config:", error);
    }

    // Return default config
    return {
      projects: new Map(),
    };
  }

  async saveConfig(config: ProjectsConfig): Promise<void> {
    try {
      if (!fs.existsSync(this.rootDir)) {
        fs.mkdirSync(this.rootDir, { recursive: true });
      }

      const data: {
        projects: Array<[string, ProjectConfig]>;
        serverSshHost?: string;
        viewedSplashScreens?: string[];
      } = {
        projects: Array.from(config.projects.entries()),
      };
      if (config.serverSshHost) {
        data.serverSshHost = config.serverSshHost;
      }
      if (config.viewedSplashScreens) {
        data.viewedSplashScreens = config.viewedSplashScreens;
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
          return { workspacePath: workspace.path, projectPath };
        }

        // LEGACY FORMAT: Fall back to metadata.json and legacy ID for unmigrated workspaces
        if (!workspace.id) {
          // Extract workspace basename (could be stable ID or legacy name)
          const workspaceBasename =
            workspace.path.split("/").pop() ?? workspace.path.split("\\").pop() ?? "unknown";

          // Try loading metadata with basename as ID (works for old workspaces)
          const metadataPath = path.join(this.getSessionDir(workspaceBasename), "metadata.json");
          if (fs.existsSync(metadataPath)) {
            try {
              const data = fs.readFileSync(metadataPath, "utf-8");
              const metadata = JSON.parse(data) as WorkspaceMetadata;
              if (metadata.id === workspaceId) {
                return { workspacePath: workspace.path, projectPath };
              }
            } catch {
              // Ignore parse errors, try legacy ID
            }
          }

          // Try legacy ID format as last resort
          const legacyId = this.generateLegacyId(projectPath, workspace.path);
          if (legacyId === workspaceId) {
            return { workspacePath: workspace.path, projectPath };
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
      const projectName = this.getProjectName(projectPath);

      for (const workspace of projectConfig.workspaces) {
        // Extract workspace basename from path (could be stable ID or legacy name)
        const workspaceBasename =
          workspace.path.split("/").pop() ?? workspace.path.split("\\").pop() ?? "unknown";

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
            };

            // Migrate missing createdAt to config for next load
            if (!workspace.createdAt) {
              workspace.createdAt = metadata.createdAt;
              configModified = true;
            }

            // Migrate missing runtimeConfig to config for next load
            if (!workspace.runtimeConfig) {
              workspace.runtimeConfig = metadata.runtimeConfig;
              configModified = true;
            }

            workspaceMetadata.push(this.addPathsToMetadata(metadata, workspace.path, projectPath));
            continue; // Skip metadata file lookup
          }

          // LEGACY FORMAT: Fall back to reading metadata.json
          // Try legacy ID format first (project-workspace) - used by E2E tests and old workspaces
          const legacyId = this.generateLegacyId(projectPath, workspace.path);
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
            metadata.aiSettings ??= workspace.aiSettings;

            // Migrate to config for next load
            workspace.id = metadata.id;
            workspace.name = metadata.name;
            workspace.createdAt = metadata.createdAt;
            workspace.runtimeConfig = metadata.runtimeConfig;
            configModified = true;

            workspaceMetadata.push(this.addPathsToMetadata(metadata, workspace.path, projectPath));
            metadataFound = true;
          }

          // No metadata found anywhere - create basic metadata
          if (!metadataFound) {
            const legacyId = this.generateLegacyId(projectPath, workspace.path);
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
            };

            // Save to config for next load
            workspace.id = metadata.id;
            workspace.name = metadata.name;
            workspace.createdAt = metadata.createdAt;
            workspace.runtimeConfig = metadata.runtimeConfig;
            configModified = true;

            workspaceMetadata.push(this.addPathsToMetadata(metadata, workspace.path, projectPath));
          }
        } catch (error) {
          log.error(`Failed to load/migrate workspace metadata:`, error);
          // Fallback to basic metadata if migration fails
          const legacyId = this.generateLegacyId(projectPath, workspace.path);
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
          };
          workspaceMetadata.push(this.addPathsToMetadata(metadata, workspace.path, projectPath));
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
  async addWorkspace(projectPath: string, metadata: WorkspaceMetadata): Promise<void> {
    await this.editConfig((config) => {
      let project = config.projects.get(projectPath);

      if (!project) {
        project = { workspaces: [] };
        config.projects.set(projectPath, project);
      }

      // Check if workspace already exists (by ID)
      const existingIndex = project.workspaces.findIndex((w) => w.id === metadata.id);

      // Compute workspace path - this is only for legacy config migration
      // New code should use Runtime.getWorkspacePath() directly
      const projectName = this.getProjectName(projectPath);
      const workspacePath = path.join(this.srcDir, projectName, metadata.name);
      const workspaceEntry: Workspace = {
        path: workspacePath,
        id: metadata.id,
        name: metadata.name,
        createdAt: metadata.createdAt,
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
    updates: Partial<Pick<WorkspaceMetadata, "name">>
  ): Promise<void> {
    await this.editConfig((config) => {
      for (const [_projectPath, projectConfig] of config.projects) {
        const workspace = projectConfig.workspaces.find((w) => w.id === workspaceId);
        if (workspace) {
          if (updates.name !== undefined) workspace.name = updates.name;
          return config;
        }
      }
      throw new Error(`Workspace ${workspaceId} not found in config`);
    });
  }

  /**
   * Get MCP overrides for a workspace.
   * Returns undefined if workspace not found or no overrides set.
   */
  getWorkspaceMCPOverrides(workspaceId: string): Workspace["mcp"] | undefined {
    const config = this.loadConfigOrDefault();
    for (const [_projectPath, projectConfig] of config.projects) {
      const workspace = projectConfig.workspaces.find((w) => w.id === workspaceId);
      if (workspace) {
        return workspace.mcp;
      }
    }
    return undefined;
  }

  /**
   * Set MCP overrides for a workspace.
   * @throws Error if workspace not found
   */
  async setWorkspaceMCPOverrides(workspaceId: string, overrides: Workspace["mcp"]): Promise<void> {
    await this.editConfig((config) => {
      for (const [_projectPath, projectConfig] of config.projects) {
        const workspace = projectConfig.workspaces.find((w) => w.id === workspaceId);
        if (workspace) {
          // Normalize: remove empty arrays to keep config clean
          const normalized = overrides
            ? {
                disabledServers:
                  overrides.disabledServers && overrides.disabledServers.length > 0
                    ? [...new Set(overrides.disabledServers)] // De-duplicate
                    : undefined,
                enabledServers:
                  overrides.enabledServers && overrides.enabledServers.length > 0
                    ? [...new Set(overrides.enabledServers)] // De-duplicate
                    : undefined,
                toolAllowlist:
                  overrides.toolAllowlist && Object.keys(overrides.toolAllowlist).length > 0
                    ? overrides.toolAllowlist
                    : undefined,
              }
            : undefined;

          // Remove mcp field entirely if no overrides
          if (
            !normalized?.disabledServers &&
            !normalized?.enabledServers &&
            !normalized?.toolAllowlist
          ) {
            delete workspace.mcp;
          } else {
            workspace.mcp = normalized;
          }
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

// Default instance for application use
export const defaultConfig = new Config();
