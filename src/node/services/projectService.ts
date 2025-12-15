import type { Config, ProjectConfig } from "@/node/config";
import { validateProjectPath, isGitRepository } from "@/node/utils/pathUtils";
import { listLocalBranches, detectDefaultTrunkBranch } from "@/node/git";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { Secret } from "@/common/types/secrets";
import * as fsPromises from "fs/promises";
import { log } from "@/node/services/log";
import type { BranchListResult } from "@/common/orpc/types";
import type { FileTreeNode } from "@/common/utils/git/numstatParser";
import * as path from "path";
import * as os from "os";

/**
 * List directory contents for the DirectoryPickerModal.
 * Returns a FileTreeNode where:
 * - name and path are the resolved absolute path of the requested directory
 * - children are the immediate subdirectories (not recursive)
 */
async function listDirectory(requestedPath: string): Promise<FileTreeNode> {
  // Expand ~ to home directory (path.resolve doesn't handle tilde)
  const expanded =
    requestedPath === "~" || requestedPath.startsWith("~/")
      ? requestedPath.replace("~", os.homedir())
      : requestedPath;
  const normalizedRoot = path.resolve(expanded || ".");
  const entries = await fsPromises.readdir(normalizedRoot, { withFileTypes: true });

  const children: FileTreeNode[] = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const entryPath = path.join(normalizedRoot, entry.name);
      return {
        name: entry.name,
        path: entryPath,
        isDirectory: true,
        children: [],
      };
    });

  return {
    name: normalizedRoot,
    path: normalizedRoot,
    isDirectory: true,
    children,
  };
}

export class ProjectService {
  private directoryPicker?: () => Promise<string | null>;

  constructor(private readonly config: Config) {}

  setDirectoryPicker(picker: () => Promise<string | null>) {
    this.directoryPicker = picker;
  }

  async pickDirectory(): Promise<string | null> {
    if (!this.directoryPicker) return null;
    return this.directoryPicker();
  }

  async create(
    projectPath: string
  ): Promise<Result<{ projectConfig: ProjectConfig; normalizedPath: string }>> {
    try {
      const validation = await validateProjectPath(projectPath);
      if (!validation.valid) {
        return Err(validation.error ?? "Invalid project path");
      }

      const normalizedPath = validation.expandedPath!;
      const config = this.config.loadConfigOrDefault();

      if (config.projects.has(normalizedPath)) {
        return Err("Project already exists");
      }

      const projectConfig: ProjectConfig = { workspaces: [] };
      config.projects.set(normalizedPath, projectConfig);
      await this.config.saveConfig(config);

      return Ok({ projectConfig, normalizedPath });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to create project: ${message}`);
    }
  }

  async remove(projectPath: string): Promise<Result<void>> {
    try {
      const config = this.config.loadConfigOrDefault();
      const projectConfig = config.projects.get(projectPath);

      if (!projectConfig) {
        return Err("Project not found");
      }

      if (projectConfig.workspaces.length > 0) {
        return Err(
          `Cannot remove project with active workspaces. Please remove all ${projectConfig.workspaces.length} workspace(s) first.`
        );
      }

      config.projects.delete(projectPath);
      await this.config.saveConfig(config);

      try {
        await this.config.updateProjectSecrets(projectPath, []);
      } catch (error) {
        log.error(`Failed to clean up secrets for project ${projectPath}:`, error);
      }

      return Ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to remove project: ${message}`);
    }
  }

  list(): Array<[string, ProjectConfig]> {
    try {
      const config = this.config.loadConfigOrDefault();
      return Array.from(config.projects.entries());
    } catch (error) {
      log.error("Failed to list projects:", error);
      return [];
    }
  }

  async listBranches(projectPath: string): Promise<BranchListResult> {
    if (typeof projectPath !== "string" || projectPath.trim().length === 0) {
      throw new Error("Project path is required to list branches");
    }
    try {
      const validation = await validateProjectPath(projectPath);
      if (!validation.valid) {
        throw new Error(validation.error ?? "Invalid project path");
      }
      const normalizedPath = validation.expandedPath!;

      // Non-git repos return empty branches - they're restricted to local runtime only
      if (!(await isGitRepository(normalizedPath))) {
        return { branches: [], recommendedTrunk: null };
      }

      const branches = await listLocalBranches(normalizedPath);
      const recommendedTrunk = await detectDefaultTrunkBranch(normalizedPath, branches);
      return { branches, recommendedTrunk };
    } catch (error) {
      log.error("Failed to list branches:", error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  getSecrets(projectPath: string): Secret[] {
    try {
      return this.config.getProjectSecrets(projectPath);
    } catch (error) {
      log.error("Failed to get project secrets:", error);
      return [];
    }
  }

  async listDirectory(path: string) {
    try {
      const tree = await listDirectory(path);
      return { success: true as const, data: tree };
    } catch (error) {
      return {
        success: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  async updateSecrets(projectPath: string, secrets: Secret[]): Promise<Result<void>> {
    try {
      await this.config.updateProjectSecrets(projectPath, secrets);
      return Ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to update project secrets: ${message}`);
    }
  }

  /**
   * Get idle compaction hours setting for a project.
   * Returns null if disabled or project not found.
   */
  getIdleCompactionHours(projectPath: string): number | null {
    try {
      const config = this.config.loadConfigOrDefault();
      const project = config.projects.get(projectPath);
      return project?.idleCompactionHours ?? null;
    } catch (error) {
      log.error("Failed to get idle compaction hours:", error);
      return null;
    }
  }

  /**
   * Set idle compaction hours for a project.
   * Pass null to disable idle compaction.
   */
  async setIdleCompactionHours(projectPath: string, hours: number | null): Promise<Result<void>> {
    try {
      const config = this.config.loadConfigOrDefault();
      const project = config.projects.get(projectPath);

      if (!project) {
        return Err(`Project not found: ${projectPath}`);
      }

      project.idleCompactionHours = hours;
      await this.config.saveConfig(config);
      return Ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to set idle compaction hours: ${message}`);
    }
  }
}
