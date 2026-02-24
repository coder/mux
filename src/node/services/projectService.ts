import type { Config, ProjectConfig } from "@/node/config";
import type { SectionConfig } from "@/common/types/project";
import { DEFAULT_SECTION_COLOR } from "@/common/constants/ui";
import { sortSectionsByLinkedList } from "@/common/utils/sections";
import { formatSshEndpoint } from "@/common/utils/ssh/formatSshEndpoint";
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { validateProjectPath, isGitRepository } from "@/node/utils/pathUtils";
import { listLocalBranches, detectDefaultTrunkBranch } from "@/node/git";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { Secret } from "@/common/types/secrets";
import type { Stats } from "fs";
import * as fsPromises from "fs/promises";
import { execAsync, killProcessTree } from "@/node/utils/disposableExec";
import {
  buildFileCompletionsIndex,
  EMPTY_FILE_COMPLETIONS_INDEX,
  searchFileCompletions,
  type FileCompletionsIndex,
} from "@/node/services/fileCompletionsIndex";
import { log } from "@/node/services/log";
import type { SshPromptService } from "@/node/services/sshPromptService";
import { createMediatedAskpassSession } from "@/node/runtime/openSshPromptMediation";
import {
  classifySshCloneFailure,
  summarizeCloneStderr,
  type CloneErrorCode,
} from "./sshCloneFailure";
import type { BranchListResult } from "@/common/orpc/types";
import type { ProjectRemoveErrorSchema } from "@/common/orpc/schemas/errors";
import type { FileTreeNode } from "@/common/utils/git/numstatParser";
import * as path from "path";
import { getMuxProjectsDir } from "@/common/constants/paths";
import { expandTilde } from "@/node/runtime/tildeExpansion";
import { getErrorMessage } from "@/common/utils/errors";
import { getProjectWorkspaceCounts } from "@/common/utils/projectRemoval";
import type { z } from "zod";

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

export type { CloneErrorCode } from "./sshCloneFailure";

export type CloneEvent =
  | { type: "progress"; line: string }
  | { type: "success"; projectConfig: ProjectConfig; normalizedPath: string }
  | {
      type: "error";
      code: CloneErrorCode;
      error: string;
      normalizedPath?: string | null;
    };

type ProjectRemoveError = z.infer<typeof ProjectRemoveErrorSchema>;

function isTildePrefixedPath(value: string): boolean {
  return value === "~" || value.startsWith("~/") || value.startsWith("~\\");
}

function resolvePathWithTilde(inputPath: string): string {
  const expanded = isTildePrefixedPath(inputPath) ? expandTilde(inputPath) : inputPath;
  return path.resolve(expanded);
}

function resolveProjectParentDir(
  parentDir: string | null | undefined,
  defaultProjectDir: string | undefined
): string {
  const rawParentDir = parentDir ?? defaultProjectDir ?? getMuxProjectsDir();
  const trimmedParentDir = rawParentDir.trim();

  if (!trimmedParentDir) {
    throw new Error("Project parent directory cannot be empty");
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

const GITHUB_SHORTHAND_PATTERN = /^[a-zA-Z0-9][\w-]*\/[a-zA-Z0-9][\w.-]*$/;

function hasLikelySshCredentials(): boolean {
  const sshAgentSocket = process.env.SSH_AUTH_SOCK;
  // Be conservative: only prefer git@github.com shorthand when the session has an active
  // SSH agent. The mere presence of local key files does not imply GitHub SSH access.
  return typeof sshAgentSocket === "string" && sshAgentSocket.trim().length > 0;
}

/**
 * Normalize a repo URL so git clone receives a valid remote.
 * Expands "owner/repo" shorthand to either SSH or HTTPS based on likely local credentials.
 * All other inputs (HTTPS URLs, SSH URLs, SCP-style, etc.) pass through unchanged.
 */
function normalizeRepoUrlForClone(repoUrl: string): string {
  const trimmedRepoUrl = repoUrl.trim();
  const shorthandCandidate = trimmedRepoUrl.replace(/[\\/]+$/, "");

  // owner/repo shorthand: exactly two non-empty segments separated by a single slash,
  // where the first segment looks like a GitHub username (letters, digits, hyphens).
  // Excludes local paths like ../repo, ./foo, foo/bar/baz, and absolute paths.
  // Note: bare `foo/bar` style local relative paths are intentionally treated as GitHub
  // shorthand here because this function is only called from the Clone dialog, which is
  // specifically for remote repos. Users cloning local repos should use the "Local folder" tab.
  if (GITHUB_SHORTHAND_PATTERN.test(shorthandCandidate)) {
    // Strip existing .git suffix before appending to avoid double .git (e.g. owner/repo.git → owner/repo.git.git)
    const withoutGitSuffix = shorthandCandidate.replace(/\.git$/i, "");

    // Prefer SSH for shorthand only when the current session has an active SSH agent.
    // This avoids assuming GitHub access from unrelated key files on disk.
    if (hasLikelySshCredentials()) {
      return `git@github.com:${withoutGitSuffix}.git`;
    }

    return `https://github.com/${withoutGitSuffix}.git`;
  }

  // Strip query strings and fragments only from URL-like inputs (protocol:// or git@),
  // not from local paths where # and ? may be valid filename characters.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmedRepoUrl) || trimmedRepoUrl.startsWith("git@")) {
    return trimmedRepoUrl.replace(/[?#].*$/, "");
  }

  return trimmedRepoUrl;
}

function parseScpStyleSshUrl(url: string): { host: string } | undefined {
  const trimmedUrl = url.trim();

  // Keep Windows drive-letter paths (e.g. C:\repo) out of SCP-style SSH matching.
  if (/^[a-zA-Z]:[\\/]/.test(trimmedUrl)) {
    return undefined;
  }

  // Protocol URLs (https://, ssh://, etc.) are handled separately.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmedUrl)) {
    return undefined;
  }

  // SCP-style clone URL: [user@]host:path
  const scpLikeMatch = /^(?:[a-zA-Z0-9._-]+@)?(\[[^\]]+\]|[^:/\s][^:/\s]*):(.+)$/.exec(trimmedUrl);
  if (!scpLikeMatch) {
    return undefined;
  }

  return { host: scpLikeMatch[1] };
}

/** Protocol schemes that Git routes through SSH transport. */
const SSH_PROTOCOL_SCHEMES = new Set(["ssh:", "git+ssh:", "ssh+git:"]);

type CloneTransport =
  | { kind: "ssh"; hostname: string; port: number }
  | { kind: "ssh-scp"; hostname: string; port: number }
  | { kind: "non-ssh" };

/**
 * Canonical clone-URL transport classifier.
 * Every SSH-related decision in the clone flow (askpass enablement, prompt
 * deduplication) should consume this parser so protocol support cannot drift.
 */
function parseCloneTransport(rawUrl: string): CloneTransport {
  const trimmedUrl = rawUrl.trim();

  // SCP-style: [user@]host:path (always SSH, port 22)
  const parsedScpLikeUrl = parseScpStyleSshUrl(trimmedUrl);
  if (parsedScpLikeUrl) {
    return { kind: "ssh-scp", hostname: parsedScpLikeUrl.host, port: 22 };
  }

  // Protocol URLs: ssh://, git+ssh://, ssh+git://
  try {
    const parsed = new URL(trimmedUrl);
    if (SSH_PROTOCOL_SCHEMES.has(parsed.protocol.toLowerCase()) && parsed.hostname) {
      const parsedPort = Number.parseInt(parsed.port, 10);
      const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 22;
      return { kind: "ssh", hostname: parsed.hostname, port };
    }
  } catch {
    // Not a valid protocol URL; treat as non-SSH.
  }

  return { kind: "non-ssh" };
}

/** Detect whether a clone URL will use SSH transport. */
function isSshCloneUrl(url: string): boolean {
  return parseCloneTransport(url).kind !== "non-ssh";
}

function deriveSshClonePromptDedupeKey(cloneUrl: string): string | undefined {
  const transport = parseCloneTransport(cloneUrl);
  if (transport.kind === "non-ssh") {
    return undefined;
  }

  return formatSshEndpoint(transport.hostname, transport.port);
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
  private readonly sshPromptService: SshPromptService | undefined;

  constructor(
    private readonly config: Config,
    sshPromptService?: SshPromptService
  ) {
    this.sshPromptService = sshPromptService;
  }

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

      const config = this.config.loadConfigOrDefault();
      let normalizedPath: string;
      if (isBareProjectName) {
        // Bare project name - put in default projects directory
        const parentDir = resolveProjectParentDir(undefined, config.defaultProjectDir);
        normalizedPath = path.join(parentDir, projectPath);
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
      const message = getErrorMessage(error);
      return Err(`Failed to create project: ${message}`);
    }
  }

  getDefaultProjectDir(): string {
    const config = this.config.loadConfigOrDefault();
    return resolveProjectParentDir(undefined, config.defaultProjectDir);
  }

  async setDefaultProjectDir(dirPath: string): Promise<void> {
    const trimmed = dirPath.trim();
    await this.config.editConfig((config) => ({
      ...config,
      defaultProjectDir: trimmed || undefined,
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
      const cloneParentDir = resolveProjectParentDir(
        input.cloneParentDir,
        config.defaultProjectDir
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
      const message = getErrorMessage(error);
      return Err(message);
    }
  }

  async *cloneWithProgress(
    input: CloneProjectParams,
    signal?: AbortSignal
  ): AsyncGenerator<CloneEvent> {
    const prepared = this.validateAndPrepareClone(input);
    if (!prepared.success) {
      yield { type: "error", code: "clone_failed", error: prepared.error };
      return;
    }

    const { cloneUrl, normalizedPath, cloneParentDir } = prepared.data;
    const cloneWorkPath = `${normalizedPath}.mux-clone-${randomBytes(6).toString("hex")}`;
    let cloneSucceeded = false;
    // Preserve full stderr so failed clones can surface git's fatal message instead of only exit code 128.
    let collectedStderr = "";
    let askpass: Awaited<ReturnType<typeof createMediatedAskpassSession>> | undefined;

    const cleanupPartialClone = async () => {
      if (cloneSucceeded) {
        return;
      }

      try {
        // Only clean up the temp clone path we created so we never delete
        // a destination directory that another process created concurrently.
        await fsPromises.rm(cloneWorkPath, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors — the original error is more important.
      }
    };

    try {
      if (signal?.aborted) {
        yield { type: "error", code: "clone_failed", error: "Clone cancelled" };
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
        yield {
          type: "error",
          code: "clone_failed",
          error: "Clone destination parent directory is not a directory",
        };
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
        if (destinationStat.isDirectory()) {
          yield {
            type: "error",
            code: "destination_exists",
            error: `Destination already exists: ${normalizedPath}`,
            normalizedPath,
          };
        } else {
          yield {
            type: "error",
            code: "clone_failed",
            error: `Destination already exists: ${normalizedPath}`,
          };
        }
        return;
      }

      await fsPromises.mkdir(cloneParentDir, { recursive: true });

      // Set up SSH askpass mediation for SSH clone URLs.
      // This allows clone to surface host-key and credential prompts through the
      // same in-app dialog used by SSH runtime probes.
      askpass =
        isSshCloneUrl(cloneUrl) && this.sshPromptService
          ? await createMediatedAskpassSession({
              sshPromptService: this.sshPromptService,
              promptPolicy: { allowHostKey: true, allowCredential: true },
              // Deduplicate host-key prompts by SSH endpoint identity (host:port),
              // not by full repo path, so concurrent clones to the same host coalesce.
              dedupeKey: deriveSshClonePromptDedupeKey(cloneUrl),
              getStderrContext: () => collectedStderr,
            })
          : undefined;

      const child = spawn("git", ["clone", "--progress", "--", cloneUrl, cloneWorkPath], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(askpass?.env ?? {}) },
        // Detached children become process-group leaders on Unix so we can
        // reliably terminate clone helpers (ssh, shells) as a full tree.
        detached: process.platform !== "win32",
      });

      const stderrChunks: string[] = [];
      let resolveChunk: (() => void) | null = null;
      let processEnded = false;
      let resolveProcessExit: (() => void) | null = null;
      const processExitPromise = new Promise<void>((resolve) => {
        resolveProcessExit = resolve;
      });
      let spawnErrorMessage: string | null = null;

      const summarizeStderr = (): string | null => summarizeCloneStderr(collectedStderr);

      const notifyChunk = () => {
        if (!resolveChunk) {
          return;
        }

        if (!processEnded && stderrChunks.length === 0) {
          return;
        }

        const resolve = resolveChunk;
        resolveChunk = null;
        resolve();
      };

      const markProcessEnded = () => {
        if (processEnded) {
          return;
        }

        processEnded = true;
        notifyChunk();

        if (resolveProcessExit) {
          const resolve = resolveProcessExit;
          resolveProcessExit = null;
          resolve();
        }
      };

      child.stderr?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stderrChunks.push(chunk);
        collectedStderr += chunk;
        notifyChunk();
      });

      child.on("error", (error: Error) => {
        spawnErrorMessage = error.message;
        markProcessEnded();
      });

      child.on("close", () => {
        markProcessEnded();
      });

      if (child.exitCode !== null || child.signalCode !== null) {
        markProcessEnded();
      }

      const terminateCloneProcess = () => {
        if (child.killed || child.exitCode !== null || child.signalCode !== null) {
          return;
        }

        if (typeof child.pid === "number" && child.pid > 0) {
          killProcessTree(child.pid);
          return;
        }

        try {
          child.kill();
        } catch {
          // Ignore ESRCH races if process exits between checks.
        }
      };

      const onAbort = () => {
        terminateCloneProcess();
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
            notifyChunk();
          });
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
        terminateCloneProcess();
        await processExitPromise;
      }

      while (stderrChunks.length > 0) {
        yield { type: "progress", line: stderrChunks.shift()! };
      }

      if (spawnErrorMessage != null) {
        await cleanupPartialClone();
        const errorMessage = summarizeStderr() ?? spawnErrorMessage;
        yield { type: "error", code: "clone_failed", error: errorMessage };
        return;
      }

      if (signal?.aborted) {
        await cleanupPartialClone();
        yield { type: "error", code: "clone_failed", error: "Clone cancelled" };
        return;
      }

      const exitCode = child.exitCode;
      const exitSignal = child.signalCode;

      if (exitCode !== 0 || exitSignal != null) {
        await cleanupPartialClone();
        const errorMessage =
          summarizeStderr() ??
          (exitSignal != null
            ? `Clone failed: process terminated by signal ${String(exitSignal)}`
            : `Clone failed with exit code ${exitCode ?? "unknown"}`);
        yield {
          type: "error",
          code: classifySshCloneFailure({
            stderr: collectedStderr,
            promptOutcome: askpass?.getLastPromptOutcome() ?? null,
          }),
          error: errorMessage,
        };
        return;
      }

      if (signal?.aborted) {
        await cleanupPartialClone();
        yield { type: "error", code: "clone_failed", error: "Clone cancelled" };
        return;
      }

      try {
        await fsPromises.rename(cloneWorkPath, normalizedPath);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === "EEXIST" || err.code === "ENOTEMPTY") {
          await cleanupPartialClone();

          let existingDestinationStat: Stats | null = null;
          try {
            existingDestinationStat = await fsPromises.stat(normalizedPath);
          } catch (statError) {
            const statErr = statError as NodeJS.ErrnoException;
            if (statErr.code !== "ENOENT") {
              throw statError;
            }
          }

          if (existingDestinationStat?.isDirectory()) {
            yield {
              type: "error",
              code: "destination_exists",
              error: `Destination already exists: ${normalizedPath}`,
              normalizedPath,
            };
          } else {
            yield {
              type: "error",
              code: "clone_failed",
              error: `Destination already exists: ${normalizedPath}`,
            };
          }
          return;
        }
        throw error;
      }

      if (signal?.aborted) {
        // Abort won the race after rename but before config mutation.
        // Remove the newly materialized destination so cancellation remains authoritative.
        try {
          await fsPromises.rm(normalizedPath, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup only.
        }
        yield { type: "error", code: "clone_failed", error: "Clone cancelled" };
        return;
      }

      const projectConfig: ProjectConfig = { workspaces: [] };
      await this.config.editConfig((freshConfig) => {
        if (freshConfig.projects.has(normalizedPath)) {
          return freshConfig;
        }
        const updatedProjects = new Map(freshConfig.projects);
        updatedProjects.set(normalizedPath, projectConfig);
        return { ...freshConfig, projects: updatedProjects };
      });

      if (!this.config.loadConfigOrDefault().projects.has(normalizedPath)) {
        // Config.saveConfig logs-and-continues on write failures, so verify persistence
        // explicitly before reporting success.
        try {
          await fsPromises.rm(normalizedPath, { recursive: true, force: true });
        } catch {
          // Best-effort rollback only.
        }
        yield {
          type: "error",
          code: "clone_failed",
          error: "Failed to persist cloned project configuration",
        };
        return;
      }

      cloneSucceeded = true;
      yield { type: "success", projectConfig, normalizedPath };
    } catch (error) {
      const message = getErrorMessage(error);
      yield {
        type: "error",
        code: "clone_failed",
        error: `Failed to clone repository: ${message}`,
      };
    } finally {
      askpass?.cleanup();
      await cleanupPartialClone();
    }
  }

  async clone(
    input: CloneProjectParams
  ): Promise<Result<{ projectConfig: ProjectConfig; normalizedPath: string }>> {
    for await (const event of this.cloneWithProgress(input)) {
      if (event.type === "success") {
        return Ok({ projectConfig: event.projectConfig, normalizedPath: event.normalizedPath });
      }

      if (event.type === "error") {
        return Err(event.error);
      }
    }

    return Err("Clone did not return a completion event");
  }

  async remove(projectPath: string): Promise<Result<void, ProjectRemoveError>> {
    try {
      const config = this.config.loadConfigOrDefault();
      const projectConfig = config.projects.get(projectPath);

      if (!projectConfig) {
        return Err({ type: "project_not_found" as const });
      }

      const counts = getProjectWorkspaceCounts(projectConfig.workspaces);
      if (counts.activeCount + counts.archivedCount > 0) {
        return Err({ type: "workspace_blockers" as const, ...counts });
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
      const message = getErrorMessage(error);
      return Err({ type: "unknown" as const, message: `Failed to remove project: ${message}` });
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
      const message = getErrorMessage(error);
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
            error: getErrorMessage(error),
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
        error: getErrorMessage(error),
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
      const message = getErrorMessage(error);
      return Err(`Failed to create directory: ${message}`);
    }
  }

  async updateSecrets(projectPath: string, secrets: Secret[]): Promise<Result<void>> {
    try {
      await this.config.updateProjectSecrets(projectPath, secrets);
      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
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
      const message = getErrorMessage(error);
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
      const message = getErrorMessage(error);
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
      const message = getErrorMessage(error);
      return Err(`Failed to update section: ${message}`);
    }
  }

  /**
   * Remove a section and unsection any workspaces assigned to it.
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

      const workspacesInSection = project.workspaces.filter((w) => w.sectionId === sectionId);

      // Unsection all workspaces in this section
      for (const workspace of workspacesInSection) {
        workspace.sectionId = undefined;
      }

      // Remove the section
      project.sections = sections.filter((s) => s.id !== sectionId);
      await this.config.saveConfig(config);
      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
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
      const message = getErrorMessage(error);
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
      const message = getErrorMessage(error);
      return Err(`Failed to assign workspace to section: ${message}`);
    }
  }
}
