import type { Config, ProjectConfig } from "@/node/config";
import type { SectionConfig } from "@/common/types/project";
import { DEFAULT_SECTION_COLOR } from "@/common/constants/ui";
import { sortSectionsByLinkedList } from "@/common/utils/sections";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { validateProjectPath, isGitRepository } from "@/node/utils/pathUtils";
import { listLocalBranches, detectDefaultTrunkBranch } from "@/node/git";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { Secret } from "@/common/types/secrets";
import type { Stats } from "fs";
import * as fsPromises from "fs/promises";
import { execAsync, execFileAsync } from "@/node/utils/disposableExec";
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
import { getMuxProjectsDir } from "@/common/constants/paths";
import { expandTilde } from "@/node/runtime/tildeExpansion";

/**
 * List directory contents for the DirectoryPickerModal.
 * Returns a FileTreeNode where:
 * - name and path are the resolved absolute path of the requested directory
 * - children are the immediate subdirectories (not recursive)
 */
async function listDirectory(requestedPath: string): Promise<FileTreeNode> {
  // Expand ~ to home directory (path.resolve doesn't handle tilde)
  const expanded =
    requestedPath === "~" || requestedPath.startsWith("~/") || requestedPath.startsWith("~\\")
      ? expandTilde(requestedPath)
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

interface CloneProjectParams {
  repoUrl: string;
  cloneParentDir?: string | null;
}

export type CloneEvent =
  | { type: "progress"; line: string }
  | { type: "success"; projectConfig: ProjectConfig; normalizedPath: string }
  | { type: "error"; error: string };

function isTildePrefixedPath(value: string): boolean {
  return value === "~" || value.startsWith("~/") || value.startsWith("~\\");
}

function resolvePathWithTilde(inputPath: string): string {
  const expanded = isTildePrefixedPath(inputPath) ? expandTilde(inputPath) : inputPath;
  return path.resolve(expanded);
}

function resolveCloneParentDir(
  cloneParentDir: string | null | undefined,
  defaultCloneDir: string | undefined
): string {
  const rawParentDir = cloneParentDir ?? defaultCloneDir ?? getMuxProjectsDir();
  const trimmedParentDir = rawParentDir.trim();

  if (!trimmedParentDir) {
    throw new Error("Clone destination parent directory cannot be empty");
  }

  return resolvePathWithTilde(trimmedParentDir);
}

// Strip filesystem-unsafe characters (including control chars U+0000–U+001F)
function sanitizeRepoFolderName(name: string): string {
  const unsafeCharsPattern = /[<>:"/\\|?*]/g;
  return name
    .replace(unsafeCharsPattern, "-")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
}

function deriveRepoFolderName(repoUrl: string): string {
  const trimmedRepoUrl = repoUrl.trim();
  if (!trimmedRepoUrl) {
    throw new Error("Repository URL cannot be empty");
  }

  let candidatePath = trimmedRepoUrl;

  // SSH-style shorthand: git@github.com:owner/repo.git
  const scpLikeMatch = /^[^@\s]+@[^:\s]+:(.+)$/.exec(trimmedRepoUrl);
  if (scpLikeMatch) {
    candidatePath = scpLikeMatch[1];
  } else if (/^[^/\\\s]+\/[^/\\\s]+$/.test(trimmedRepoUrl)) {
    // Owner/repo shorthand
    candidatePath = trimmedRepoUrl;
  } else {
    try {
      // https://..., ssh://..., file://...
      const parsed = new URL(trimmedRepoUrl);
      candidatePath = decodeURIComponent(parsed.pathname);
    } catch {
      // Not a URL with protocol. Treat as local path-like input.
    }
  }

  const normalizedCandidatePath = candidatePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const repoName = path.posix.basename(normalizedCandidatePath).replace(/\.git$/i, "");
  const safeFolderName = sanitizeRepoFolderName(repoName);

  if (!safeFolderName) {
    throw new Error("Could not determine destination folder name from repository URL");
  }

  return safeFolderName;
}

/**
 * Normalize a repo URL so git clone receives a valid remote.
 * Expands "owner/repo" shorthand to "https://github.com/owner/repo.git".
 * All other inputs (HTTPS URLs, SSH URLs, SCP-style, etc.) pass through unchanged.
 */
function normalizeRepoUrlForClone(repoUrl: string): string {
  // owner/repo shorthand: exactly two non-empty segments separated by a single slash,
  // where the first segment looks like a GitHub username (letters, digits, hyphens).
  // Excludes local paths like ../repo, ./foo, foo/bar/baz, and absolute paths.
  // Note: bare `foo/bar` style local relative paths are intentionally treated as GitHub
  // shorthand here because this function is only called from the Clone dialog, which is
  // specifically for remote repos. Users cloning local repos should use the "Local folder" tab.
  if (/^[a-zA-Z0-9][\w-]*\/[a-zA-Z0-9][\w.-]*$/.test(repoUrl)) {
    // Strip existing .git suffix before appending to avoid double .git (e.g. owner/repo.git → owner/repo.git.git)
    const withoutGitSuffix = repoUrl.replace(/\.git$/i, "");
    return `https://github.com/${withoutGitSuffix}.git`;
  }

  // Strip query strings and fragments only from URL-like inputs (protocol:// or git@),
  // not from local paths where # and ? may be valid filename characters.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(repoUrl) || repoUrl.startsWith("git@")) {
    return repoUrl.replace(/[?#].*$/, "");
  }

  return repoUrl;
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
      // Validate input
      if (!projectPath || projectPath.trim().length === 0) {
        return Err("Project path cannot be empty");
      }

      // Resolve the path:
      // - Bare names like "my-project" → ~/.mux/projects/my-project
      // - Paths with ~ → expand to home directory
      // - Absolute/relative paths → resolve normally
      const isBareProjectName =
        projectPath.length > 0 &&
        !projectPath.includes("/") &&
        !projectPath.includes("\\") &&
        !projectPath.startsWith("~");

      let normalizedPath: string;
      if (isBareProjectName) {
        // Bare project name - put in default projects directory
        normalizedPath = path.join(getMuxProjectsDir(), projectPath);
      } else if (
        projectPath === "~" ||
        projectPath.startsWith("~/") ||
        projectPath.startsWith("~\\")
      ) {
        // Tilde expansion - uses expandTilde to respect MUX_ROOT for ~/.mux paths
        normalizedPath = path.resolve(expandTilde(projectPath));
      } else {
        normalizedPath = path.resolve(projectPath);
      }

      let existingStat: Stats | null = null;
      try {
        existingStat = await fsPromises.stat(normalizedPath);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") {
          throw error;
        }
      }

      if (existingStat && !existingStat.isDirectory()) {
        return Err("Project path is not a directory");
      }

      const config = this.config.loadConfigOrDefault();

      if (config.projects.has(normalizedPath)) {
        return Err("Project already exists");
      }

      // Create the directory if it doesn't exist (like mkdir -p)
      await fsPromises.mkdir(normalizedPath, { recursive: true });

      const projectConfig: ProjectConfig = { workspaces: [] };
      config.projects.set(normalizedPath, projectConfig);
      await this.config.saveConfig(config);

      return Ok({ projectConfig, normalizedPath });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to create project: ${message}`);
    }
  }

  getDefaultCloneDir(): string {
    const config = this.config.loadConfigOrDefault();
    return resolveCloneParentDir(undefined, config.defaultProjectCloneDir);
  }

  async setDefaultCloneDir(dirPath: string): Promise<void> {
    const trimmed = dirPath.trim();
    await this.config.editConfig((config) => ({
      ...config,
      defaultProjectCloneDir: trimmed || undefined,
    }));
  }

  private validateAndPrepareClone(
    input: CloneProjectParams
  ): Result<{ cloneUrl: string; normalizedPath: string; cloneParentDir: string }> {
    try {
      const repoUrl = input.repoUrl.trim();
      if (!repoUrl) {
        return Err("Repository URL cannot be empty");
      }

      const config = this.config.loadConfigOrDefault();
      const cloneParentDir = resolveCloneParentDir(
        input.cloneParentDir,
        config.defaultProjectCloneDir
      );
      const repoFolderName = deriveRepoFolderName(repoUrl);
      const normalizedPath = path.join(cloneParentDir, repoFolderName);

      if (config.projects.has(normalizedPath)) {
        return Err(`Project already exists at ${normalizedPath}`);
      }

      return Ok({
        cloneUrl: normalizeRepoUrlForClone(repoUrl),
        normalizedPath,
        cloneParentDir,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(message);
    }
  }

  async *cloneWithProgress(
    input: CloneProjectParams,
    signal?: AbortSignal
  ): AsyncGenerator<CloneEvent> {
    const prepared = this.validateAndPrepareClone(input);
    if (!prepared.success) {
      yield { type: "error", error: prepared.error };
      return;
    }

    const { cloneUrl, normalizedPath, cloneParentDir } = prepared.data;
    let destinationVerifiedEmpty = false;
    let cloneSucceeded = false;

    const cleanupPartialClone = async () => {
      if (!destinationVerifiedEmpty || cloneSucceeded) {
        return;
      }

      try {
        await fsPromises.rm(normalizedPath, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors — the original error is more important.
      }
    };

    try {
      if (signal?.aborted) {
        yield { type: "error", error: "Clone cancelled" };
        return;
      }

      let cloneParentStat: Stats | null = null;
      try {
        cloneParentStat = await fsPromises.stat(cloneParentDir);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") {
          throw error;
        }
      }

      if (cloneParentStat && !cloneParentStat.isDirectory()) {
        yield { type: "error", error: "Clone destination parent directory is not a directory" };
        return;
      }

      let destinationStat: Stats | null = null;
      try {
        destinationStat = await fsPromises.stat(normalizedPath);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") {
          throw error;
        }
      }

      if (destinationStat) {
        yield { type: "error", error: `Destination already exists: ${normalizedPath}` };
        return;
      }
      destinationVerifiedEmpty = true;

      await fsPromises.mkdir(cloneParentDir, { recursive: true });

      const child = spawn("git", ["clone", "--progress", "--", cloneUrl, normalizedPath], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });

      const stderrChunks: string[] = [];
      let resolveChunk: (() => void) | null = null;
      let processEnded = false;
      let spawnError: Error | null = null;
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;

      const notifyChunk = () => {
        if (!resolveChunk) {
          return;
        }

        const resolve = resolveChunk;
        resolveChunk = null;
        resolve();
      };

      child.stderr?.on("data", (data: Buffer) => {
        stderrChunks.push(data.toString());
        notifyChunk();
      });

      child.on("error", (error) => {
        spawnError = error;
        processEnded = true;
        notifyChunk();
      });

      child.on("exit", (code, currentSignal) => {
        exitCode = code;
        exitSignal = currentSignal;
      });

      child.on("close", () => {
        processEnded = true;
        notifyChunk();
      });

      const onAbort = () => {
        if (!child.killed && child.exitCode === null && child.signalCode === null) {
          child.kill();
        }
        notifyChunk();
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      try {
        while (!processEnded) {
          if (stderrChunks.length > 0) {
            yield { type: "progress", line: stderrChunks.shift()! };
            continue;
          }

          await new Promise<void>((resolve) => {
            resolveChunk = resolve;
          });
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);

        if (!child.killed && child.exitCode === null && child.signalCode === null) {
          child.kill();
        }
      }

      while (stderrChunks.length > 0) {
        yield { type: "progress", line: stderrChunks.shift()! };
      }

      if (spawnError) {
        throw spawnError;
      }

      if (signal?.aborted) {
        await cleanupPartialClone();
        yield { type: "error", error: "Clone cancelled" };
        return;
      }

      if (exitCode !== 0 || exitSignal !== null) {
        await cleanupPartialClone();
        const errorMessage =
          exitSignal !== null
            ? `Clone failed: process terminated by signal ${exitSignal}`
            : `Clone failed with exit code ${exitCode ?? "unknown"}`;
        yield { type: "error", error: errorMessage };
        return;
      }

      cloneSucceeded = true;

      const projectConfig: ProjectConfig = { workspaces: [] };
      await this.config.editConfig((freshConfig) => {
        if (freshConfig.projects.has(normalizedPath)) {
          return freshConfig;
        }
        const updatedProjects = new Map(freshConfig.projects);
        updatedProjects.set(normalizedPath, projectConfig);
        return { ...freshConfig, projects: updatedProjects };
      });

      yield { type: "success", projectConfig, normalizedPath };
    } catch (error) {
      await cleanupPartialClone();
      const message = error instanceof Error ? error.message : String(error);
      yield { type: "error", error: `Failed to clone repository: ${message}` };
    }
  }

  async clone(
    input: CloneProjectParams
  ): Promise<Result<{ projectConfig: ProjectConfig; normalizedPath: string }>> {
    const prepared = this.validateAndPrepareClone(input);
    if (!prepared.success) {
      return Err(prepared.error);
    }

    const { cloneUrl, normalizedPath, cloneParentDir } = prepared.data;

    // Track whether we confirmed the destination didn't exist before cloning,
    // so we only clean up directories we created (not concurrent clones).
    let destinationVerifiedEmpty = false;
    let cloneSucceeded = false;

    try {
      let cloneParentStat: Stats | null = null;
      try {
        cloneParentStat = await fsPromises.stat(cloneParentDir);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") {
          throw error;
        }
      }

      if (cloneParentStat && !cloneParentStat.isDirectory()) {
        return Err("Clone destination parent directory is not a directory");
      }

      let destinationStat: Stats | null = null;
      try {
        destinationStat = await fsPromises.stat(normalizedPath);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") {
          throw error;
        }
      }

      if (destinationStat) {
        return Err(`Destination already exists: ${normalizedPath}`);
      }
      destinationVerifiedEmpty = true;

      await fsPromises.mkdir(cloneParentDir, { recursive: true });

      // Use -- to terminate options so user-supplied URLs starting with "-" are
      // never interpreted as git flags.
      using cloneProc = execFileAsync("git", ["clone", "--", cloneUrl, normalizedPath], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      await cloneProc.result;
      cloneSucceeded = true;

      // Use editConfig to do an atomic read-modify-write, avoiding overwriting
      // unrelated config changes that may have occurred during the clone.
      // Re-check inside the callback to avoid overwriting a project entry that
      // was concurrently added by another process/window during clone.
      const projectConfig: ProjectConfig = { workspaces: [] };
      await this.config.editConfig((freshConfig) => {
        if (freshConfig.projects.has(normalizedPath)) {
          return freshConfig; // Already registered — don't overwrite
        }
        const updatedProjects = new Map(freshConfig.projects);
        updatedProjects.set(normalizedPath, projectConfig);
        return { ...freshConfig, projects: updatedProjects };
      });

      return Ok({ projectConfig, normalizedPath });
    } catch (error) {
      // Best-effort cleanup of partial clone directory so the user can retry
      // without hitting "Destination already exists". Only clean up if:
      // 1. We verified the path didn't exist before cloning (so we own it)
      // 2. The clone itself failed (not a post-clone config save error)
      if (destinationVerifiedEmpty && !cloneSucceeded) {
        try {
          await fsPromises.rm(normalizedPath, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors — the original error is more important.
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to clone repository: ${message}`);
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
        requestedPath === "~" || requestedPath.startsWith("~/") || requestedPath.startsWith("~\\")
          ? expandTilde(requestedPath)
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
