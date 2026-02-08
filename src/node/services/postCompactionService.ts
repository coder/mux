import assert from "assert";
import * as path from "path";
import fsPromises from "fs/promises";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import { createRuntimeForWorkspace } from "@/node/runtime/runtimeHelpers";
import { getPlanFilePath, getLegacyPlanFilePath } from "@/common/utils/planStorage";
import { shellQuote } from "@/node/runtime/backgroundCommands";
import { extractEditedFilePaths } from "@/common/utils/messages/extractEditedFiles";
import { fileExists } from "@/node/utils/runtime/fileExists";
import { expandTilde, expandTildeForSSH } from "@/node/runtime/tildeExpansion";
import { isSSHRuntime, isDockerRuntime } from "@/common/types/runtime";
import type { PostCompactionExclusions } from "@/common/types/attachment";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { Config } from "@/node/config";
import type { HistoryService } from "@/node/services/historyService";
import type { AgentSession } from "@/node/services/agentSession";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";

const POST_COMPACTION_METADATA_REFRESH_DEBOUNCE_MS = 100;

/**
 * Manages post-compaction state: plan files, tracked file paths, exclusions,
 * and debounced metadata emission.
 */
export class PostCompactionService {
  private readonly postCompactionRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly config: Config,
    private readonly historyService: HistoryService,
    private readonly sessions: Map<string, AgentSession>,
    private readonly getInfo: (
      workspaceId: string
    ) => Promise<FrontendWorkspaceMetadata | null | undefined>
  ) {}

  schedulePostCompactionMetadataRefresh(workspaceId: string): void {
    assert(typeof workspaceId === "string", "workspaceId must be a string");
    const trimmed = workspaceId.trim();
    assert(trimmed.length > 0, "workspaceId must not be empty");

    const existing = this.postCompactionRefreshTimers.get(trimmed);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.postCompactionRefreshTimers.delete(trimmed);
      void this.emitPostCompactionMetadata(trimmed);
    }, POST_COMPACTION_METADATA_REFRESH_DEBOUNCE_MS);

    this.postCompactionRefreshTimers.set(trimmed, timer);
  }

  cancelPendingRefresh(workspaceId: string): void {
    const trimmed = workspaceId.trim();
    const refreshTimer = this.postCompactionRefreshTimers.get(trimmed);
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      this.postCompactionRefreshTimers.delete(trimmed);
    }
  }

  private async emitPostCompactionMetadata(workspaceId: string): Promise<void> {
    try {
      const session = this.sessions.get(workspaceId);
      if (!session) {
        return;
      }

      const metadata = await this.getInfo(workspaceId);
      if (!metadata) {
        return;
      }

      const postCompaction = await this.getPostCompactionState(workspaceId);
      const enrichedMetadata = { ...metadata, postCompaction };
      session.emitMetadata(enrichedMetadata);
    } catch (error) {
      // Workspace runtime unavailable (e.g., SSH unreachable) - skip emitting post-compaction state.
      log.debug("Failed to emit post-compaction metadata", { workspaceId, error });
    }
  }

  private async getPersistedPostCompactionDiffPaths(workspaceId: string): Promise<string[] | null> {
    const postCompactionPath = path.join(
      this.config.getSessionDir(workspaceId),
      "post-compaction.json"
    );

    try {
      const raw = await fsPromises.readFile(postCompactionPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      const diffsRaw = (parsed as { diffs?: unknown }).diffs;
      if (!Array.isArray(diffsRaw)) {
        return null;
      }

      const result: string[] = [];
      for (const diff of diffsRaw) {
        if (!diff || typeof diff !== "object") continue;
        const p = (diff as { path?: unknown }).path;
        if (typeof p !== "string") continue;
        const trimmed = p.trim();
        if (trimmed.length === 0) continue;
        result.push(trimmed);
      }

      return result;
    } catch {
      return null;
    }
  }

  /**
   * Get post-compaction context state for a workspace.
   * Returns info about what will be injected after compaction.
   * Prefers cached paths from pending compaction, falls back to history extraction.
   */
  async getPostCompactionState(workspaceId: string): Promise<{
    planPath: string | null;
    trackedFilePaths: string[];
    excludedItems: string[];
  }> {
    // Get workspace metadata to create runtime for plan file check
    const metadata = await this.getInfo(workspaceId);
    if (!metadata) {
      // Can't get metadata, return empty state
      const exclusions = await this.getPostCompactionExclusions(workspaceId);
      return { planPath: null, trackedFilePaths: [], excludedItems: exclusions.excludedItems };
    }

    const runtime = createRuntimeForWorkspace(metadata);
    const muxHome = runtime.getMuxHome();
    const planPath = getPlanFilePath(metadata.name, metadata.projectName, muxHome);
    // For local/SSH: expand tilde for comparison with message history paths
    // For Docker: paths are already absolute (/var/mux/...), no expansion needed
    const expandedPlanPath = muxHome.startsWith("~") ? expandTilde(planPath) : planPath;
    // Legacy plan path (stored by workspace ID) for filtering
    const legacyPlanPath = getLegacyPlanFilePath(workspaceId);
    const expandedLegacyPlanPath = expandTilde(legacyPlanPath);

    // Check both new and legacy plan paths, prefer new path
    const newPlanExists = await fileExists(runtime, planPath);
    const legacyPlanExists = !newPlanExists && (await fileExists(runtime, legacyPlanPath));
    // Resolve plan path via runtime to get correct absolute path for deep links.
    // Local: expands ~ to local home. SSH: expands ~ on remote host.
    const activePlanPath = newPlanExists
      ? await runtime.resolvePath(planPath)
      : legacyPlanExists
        ? await runtime.resolvePath(legacyPlanPath)
        : null;

    // Load exclusions
    const exclusions = await this.getPostCompactionExclusions(workspaceId);

    // Helper to check if a path is a plan file (new or legacy format)
    const isPlanPath = (p: string) =>
      p === planPath ||
      p === expandedPlanPath ||
      p === legacyPlanPath ||
      p === expandedLegacyPlanPath;

    // If session has pending compaction attachments, use cached paths
    // (history is cleared after compaction, but cache survives)
    const session = this.sessions.get(workspaceId);
    const pendingPaths = session?.getPendingTrackedFilePaths();
    if (pendingPaths) {
      // Filter out both new and legacy plan file paths
      const trackedFilePaths = pendingPaths.filter((p) => !isPlanPath(p));
      return {
        planPath: activePlanPath,
        trackedFilePaths,
        excludedItems: exclusions.excludedItems,
      };
    }

    // Fallback (crash-safe): if a post-compaction snapshot exists on disk, use it.
    const persistedPaths = await this.getPersistedPostCompactionDiffPaths(workspaceId);
    if (persistedPaths !== null) {
      const trackedFilePaths = persistedPaths.filter((p) => !isPlanPath(p));
      return {
        planPath: activePlanPath,
        trackedFilePaths,
        excludedItems: exclusions.excludedItems,
      };
    }

    // Fallback: compute tracked files from message history (survives reloads)
    const historyResult = await this.historyService.getHistory(workspaceId);
    const messages = historyResult.success ? historyResult.data : [];
    const allPaths = extractEditedFilePaths(messages);

    // Exclude plan file from tracked files since it has its own section
    // Filter out both new and legacy plan file paths
    const trackedFilePaths = allPaths.filter((p) => !isPlanPath(p));
    return {
      planPath: activePlanPath,
      trackedFilePaths,
      excludedItems: exclusions.excludedItems,
    };
  }

  /**
   * Get post-compaction exclusions for a workspace.
   * Returns empty exclusions if file doesn't exist.
   */
  async getPostCompactionExclusions(workspaceId: string): Promise<PostCompactionExclusions> {
    const exclusionsPath = path.join(this.config.getSessionDir(workspaceId), "exclusions.json");
    try {
      const data = await fsPromises.readFile(exclusionsPath, "utf-8");
      return JSON.parse(data) as PostCompactionExclusions;
    } catch {
      return { excludedItems: [] };
    }
  }

  /**
   * Set whether an item is excluded from post-compaction context.
   * Item IDs: "plan" for plan file, "file:<path>" for tracked files.
   */
  async setPostCompactionExclusion(
    workspaceId: string,
    itemId: string,
    excluded: boolean
  ): Promise<Result<void>> {
    try {
      const exclusions = await this.getPostCompactionExclusions(workspaceId);
      const set = new Set(exclusions.excludedItems);

      if (excluded) {
        set.add(itemId);
      } else {
        set.delete(itemId);
      }

      const sessionDir = this.config.getSessionDir(workspaceId);
      await fsPromises.mkdir(sessionDir, { recursive: true });
      const exclusionsPath = path.join(sessionDir, "exclusions.json");
      await fsPromises.writeFile(
        exclusionsPath,
        JSON.stringify({ excludedItems: [...set] }, null, 2)
      );
      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to set exclusion: ${message}`);
    }
  }

  /**
   * Delete plan files for a workspace (both new and legacy paths).
   */
  async deletePlanFilesForWorkspace(
    workspaceId: string,
    metadata: FrontendWorkspaceMetadata
  ): Promise<void> {
    // Create runtime to get correct muxHome (Docker uses /var/mux, others use ~/.mux)
    const runtime = createRuntimeForWorkspace(metadata);
    const muxHome = runtime.getMuxHome();
    const planPath = getPlanFilePath(metadata.name, metadata.projectName, muxHome);
    const legacyPlanPath = getLegacyPlanFilePath(workspaceId);

    const isDocker = isDockerRuntime(metadata.runtimeConfig);
    const isSSH = isSSHRuntime(metadata.runtimeConfig);

    // For Docker: paths are already absolute (/var/mux/...), just quote
    // For SSH: use $HOME expansion so the runtime shell resolves to the runtime home directory
    // For local: expand tilde locally since shellQuote prevents shell expansion
    const quotedPlanPath = isDocker
      ? shellQuote(planPath)
      : isSSH
        ? expandTildeForSSH(planPath)
        : shellQuote(expandTilde(planPath));
    // For legacy path: SSH/Docker use $HOME expansion, local expands tilde
    const quotedLegacyPlanPath =
      isDocker || isSSH
        ? expandTildeForSSH(legacyPlanPath)
        : shellQuote(expandTilde(legacyPlanPath));

    if (isDocker || isSSH) {
      try {
        // Use exec to delete files since runtime doesn't have a deleteFile method.
        // Use runtime workspace path (not host projectPath) for Docker containers.
        const workspacePath = runtime.getWorkspacePath(metadata.projectPath, metadata.name);
        const execStream = await runtime.exec(`rm -f ${quotedPlanPath} ${quotedLegacyPlanPath}`, {
          cwd: workspacePath,
          timeout: 10,
        });

        try {
          await execStream.stdin.close();
        } catch {
          // Ignore stdin-close errors (e.g. already closed).
        }

        await execStream.exitCode.catch(() => {
          // Best-effort: ignore failures.
        });
      } catch {
        // Plan files don't exist or can't be deleted - ignore
      }

      return;
    }

    // Local runtimes: delete directly on the local filesystem.
    const planPathAbs = expandTilde(planPath);
    const legacyPlanPathAbs = expandTilde(legacyPlanPath);

    await Promise.allSettled([
      fsPromises.rm(planPathAbs, { force: true }),
      fsPromises.rm(legacyPlanPathAbs, { force: true }),
    ]);
  }

  dispose(): void {
    for (const timer of this.postCompactionRefreshTimers.values()) {
      clearTimeout(timer);
    }
    this.postCompactionRefreshTimers.clear();
  }
}
