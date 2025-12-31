import type { Config, ProjectConfig } from "@/node/config";
import { validateProjectPath, isGitRepository } from "@/node/utils/pathUtils";
import { listLocalBranches, detectDefaultTrunkBranch } from "@/node/git";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { Secret } from "@/common/types/secrets";
import * as fsPromises from "fs/promises";
import { execAsync } from "@/node/utils/disposableExec";
import {
  buildFileCompletionsIndex,
  EMPTY_FILE_COMPLETIONS_INDEX,
  searchFileCompletions,
  type FileCompletionsIndex,
} from "@/node/services/fileCompletionsIndex";
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

const FILE_COMPLETIONS_CACHE_TTL_MS = 10_000;

interface FileCompletionsCacheEntry {
  index: FileCompletionsIndex;
  fetchedAt: number;
  refreshing?: Promise<void>;
}

export class ProjectService {
  private readonly fileCompletionsCache = new Map<string, FileCompletionsCacheEntry>();
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

      // Empty branches means the repo is unborn (git init but no commits yet)
      // Return empty branches - frontend will show the git init banner since no branches exist
      // After user creates a commit, branches will populate
      if (branches.length === 0) {
        return { branches: [], recommendedTrunk: null };
      }

      const recommendedTrunk = await detectDefaultTrunkBranch(normalizedPath, branches);
      return { branches, recommendedTrunk };
    } catch (error) {
      log.error("Failed to list branches:", error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Initialize a git repository in the project directory.
   * Runs `git init` and creates an initial commit so branches exist.
   * Also handles "unborn" repos (git init already run but no commits yet).
   */
  async gitInit(projectPath: string): Promise<Result<void>> {
    if (typeof projectPath !== "string" || projectPath.trim().length === 0) {
      return Err("Project path is required");
    }
    try {
      const validation = await validateProjectPath(projectPath);
      if (!validation.valid) {
        return Err(validation.error ?? "Invalid project path");
      }
      const normalizedPath = validation.expandedPath!;

      const isGitRepo = await isGitRepository(normalizedPath);

      if (isGitRepo) {
        // Check if repo is "unborn" (git init but no commits yet)
        const branches = await listLocalBranches(normalizedPath);
        if (branches.length > 0) {
          return Err("Directory is already a git repository with commits");
        }
        // Repo exists but is unborn - just create the initial commit
      } else {
        // Initialize git repository with main as default branch
        using initProc = execAsync(`git -C "${normalizedPath}" init -b main`);
        await initProc.result;
      }

      // Create an initial empty commit so the branch exists and worktree/SSH can work
      // Without a commit, the repo is "unborn" and has no branches
      // Use -c flags to set identity only for this commit (don't persist to repo config)
      using commitProc = execAsync(
        `git -C "${normalizedPath}" -c user.name="mux" -c user.email="mux@localhost" commit --allow-empty -m "Initial commit"`
      );
      await commitProc.result;

      // Invalidate file completions cache since the repo state changed
      this.fileCompletionsCache.delete(normalizedPath);

      return Ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("Failed to initialize git repository:", error);
      return Err(`Failed to initialize git repository: ${message}`);
    }
  }

  async getFileCompletions(
    projectPath: string,
    query: string,
    limit?: number
  ): Promise<{ paths: string[] }> {
    const resolvedLimit = limit ?? 20;

    if (typeof projectPath !== "string" || projectPath.trim().length === 0) {
      return { paths: [] };
    }

    const validation = await validateProjectPath(projectPath);
    if (!validation.valid) {
      return { paths: [] };
    }

    const normalizedPath = validation.expandedPath!;

    let cacheEntry = this.fileCompletionsCache.get(normalizedPath);
    if (!cacheEntry) {
      cacheEntry = { index: EMPTY_FILE_COMPLETIONS_INDEX, fetchedAt: 0 };
      this.fileCompletionsCache.set(normalizedPath, cacheEntry);
    }

    const now = Date.now();
    const isStale =
      cacheEntry.fetchedAt === 0 || now - cacheEntry.fetchedAt > FILE_COMPLETIONS_CACHE_TTL_MS;

    if (isStale && !cacheEntry.refreshing) {
      cacheEntry.refreshing = (async () => {
        try {
          if (!(await isGitRepository(normalizedPath))) {
            cacheEntry.index = EMPTY_FILE_COMPLETIONS_INDEX;
            return;
          }

          using proc = execAsync(`git -C "${normalizedPath}" ls-files -co --exclude-standard`);
          const { stdout } = await proc.result;

          const files = stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            // File @mentions are whitespace-delimited (extractAtMentions uses /@(\\S+)/), so
            // suggestions containing spaces would be inserted incorrectly (e.g. "@foo bar.ts").
            .filter((filePath) => !/\s/.test(filePath));

          cacheEntry.index = buildFileCompletionsIndex(files);
        } catch (error) {
          log.debug("getFileCompletions: failed to list files", {
            projectPath: normalizedPath,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          cacheEntry.fetchedAt = Date.now();
          cacheEntry.refreshing = undefined;
        }
      })();
    }

    if (cacheEntry.fetchedAt === 0 && cacheEntry.refreshing) {
      await cacheEntry.refreshing;
    }

    return { paths: searchFileCompletions(cacheEntry.index, query, resolvedLimit) };
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

  async createDirectory(
    requestedPath: string
  ): Promise<Result<{ normalizedPath: string }, string>> {
    try {
      // Expand ~ to home directory
      const expanded =
        requestedPath === "~" || requestedPath.startsWith("~/")
          ? requestedPath.replace("~", os.homedir())
          : requestedPath;
      const normalizedPath = path.resolve(expanded);

      await fsPromises.mkdir(normalizedPath, { recursive: true });
      return Ok({ normalizedPath });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to create directory: ${message}`);
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
