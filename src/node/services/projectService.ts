import type { Config, ProjectConfig } from "@/node/config";
import type { SectionConfig } from "@/common/types/project";
import { DEFAULT_SECTION_COLOR } from "@/common/constants/ui";
import { sortSectionsByLinkedList } from "@/common/utils/sections";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { randomBytes } from "crypto";
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Section Management
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * List all sections for a project, sorted by linked-list order.
   */
  listSections(projectPath: string): SectionConfig[] {
    try {
      const config = this.config.loadConfigOrDefault();
      const project = config.projects.get(projectPath);
      if (!project) return [];
      return sortSectionsByLinkedList(project.sections ?? []);
    } catch (error) {
      log.error("Failed to list sections:", error);
      return [];
    }
  }

  /**
   * Create a new section in a project.
   */
  async createSection(
    projectPath: string,
    name: string,
    color?: string
  ): Promise<Result<SectionConfig>> {
    try {
      const config = this.config.loadConfigOrDefault();
      const project = config.projects.get(projectPath);

      if (!project) {
        return Err(`Project not found: ${projectPath}`);
      }

      const sections = project.sections ?? [];

      const section: SectionConfig = {
        id: randomBytes(4).toString("hex"),
        name,
        color: color ?? DEFAULT_SECTION_COLOR,
        nextId: null, // new section is last
      };

      // Find current tail (nextId is null/undefined) and point it to new section
      const sorted = sortSectionsByLinkedList(sections);
      if (sorted.length > 0) {
        const tail = sorted[sorted.length - 1];
        tail.nextId = section.id;
      }

      project.sections = [...sections, section];
      await this.config.saveConfig(config);
      return Ok(section);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to create section: ${message}`);
    }
  }

  /**
   * Update section name and/or color.
   */
  async updateSection(
    projectPath: string,
    sectionId: string,
    updates: { name?: string; color?: string }
  ): Promise<Result<void>> {
    try {
      const config = this.config.loadConfigOrDefault();
      const project = config.projects.get(projectPath);

      if (!project) {
        return Err(`Project not found: ${projectPath}`);
      }

      const sections = project.sections ?? [];
      const sectionIndex = sections.findIndex((s) => s.id === sectionId);

      if (sectionIndex === -1) {
        return Err(`Section not found: ${sectionId}`);
      }

      const section = sections[sectionIndex];
      if (updates.name !== undefined) section.name = updates.name;
      if (updates.color !== undefined) section.color = updates.color;

      await this.config.saveConfig(config);
      return Ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to update section: ${message}`);
    }
  }

  /**
   * Remove a section. Only archived workspaces can remain in the section;
   * active workspaces block removal. Archived workspaces become unsectioned.
   */
  async removeSection(projectPath: string, sectionId: string): Promise<Result<void>> {
    try {
      const config = this.config.loadConfigOrDefault();
      const project = config.projects.get(projectPath);

      if (!project) {
        return Err(`Project not found: ${projectPath}`);
      }

      const sections = project.sections ?? [];
      const sectionIndex = sections.findIndex((s) => s.id === sectionId);

      if (sectionIndex === -1) {
        return Err(`Section not found: ${sectionId}`);
      }

      // Check for active (non-archived) workspaces in this section
      const workspacesInSection = project.workspaces.filter((w) => w.sectionId === sectionId);
      const activeWorkspaces = workspacesInSection.filter(
        (w) => !isWorkspaceArchived(w.archivedAt, w.unarchivedAt)
      );

      if (activeWorkspaces.length > 0) {
        return Err(
          `Cannot remove section: ${activeWorkspaces.length} active workspace(s) still assigned. ` +
            `Archive or move workspaces first.`
        );
      }

      // Remove sectionId from archived workspaces in this section
      for (const workspace of workspacesInSection) {
        workspace.sectionId = undefined;
      }

      // Remove the section
      project.sections = sections.filter((s) => s.id !== sectionId);
      await this.config.saveConfig(config);
      return Ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to remove section: ${message}`);
    }
  }

  /**
   * Reorder sections by providing the full ordered list of section IDs.
   */
  async reorderSections(projectPath: string, sectionIds: string[]): Promise<Result<void>> {
    try {
      const config = this.config.loadConfigOrDefault();
      const project = config.projects.get(projectPath);

      if (!project) {
        return Err(`Project not found: ${projectPath}`);
      }

      const sections = project.sections ?? [];
      const sectionMap = new Map(sections.map((s) => [s.id, s]));

      // Validate all IDs exist
      for (const id of sectionIds) {
        if (!sectionMap.has(id)) {
          return Err(`Section not found: ${id}`);
        }
      }

      // Update nextId pointers based on array order
      for (let i = 0; i < sectionIds.length; i++) {
        const section = sectionMap.get(sectionIds[i])!;
        section.nextId = i < sectionIds.length - 1 ? sectionIds[i + 1] : null;
      }

      await this.config.saveConfig(config);
      return Ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to reorder sections: ${message}`);
    }
  }

  /**
   * Assign a workspace to a section (or remove from section with null).
   */
  async assignWorkspaceToSection(
    projectPath: string,
    workspaceId: string,
    sectionId: string | null
  ): Promise<Result<void>> {
    try {
      const config = this.config.loadConfigOrDefault();
      const project = config.projects.get(projectPath);

      if (!project) {
        return Err(`Project not found: ${projectPath}`);
      }

      // Validate section exists if not null
      if (sectionId !== null) {
        const sections = project.sections ?? [];
        if (!sections.some((s) => s.id === sectionId)) {
          return Err(`Section not found: ${sectionId}`);
        }
      }

      // Find and update workspace
      const workspace = project.workspaces.find((w) => w.id === workspaceId);
      if (!workspace) {
        return Err(`Workspace not found: ${workspaceId}`);
      }

      workspace.sectionId = sectionId ?? undefined;
      await this.config.saveConfig(config);
      return Ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to assign workspace to section: ${message}`);
    }
  }
}
