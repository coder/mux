import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import type { FrontendWorkspaceMetadata, GitStatus } from "@/common/types/workspace";
import { parseGitShowBranchForStatus } from "@/common/utils/git/parseGitStatus";
import {
  GIT_STATUS_SCRIPT,
  GIT_FETCH_SCRIPT,
  parseGitStatusScriptOutput,
} from "@/common/utils/git/gitStatus";
import { useSyncExternalStore } from "react";
import { MapStore } from "./MapStore";
import { isSSHRuntime } from "@/common/types/runtime";

/**
 * External store for git status of all workspaces.
 *
 * Architecture:
 * - Lives outside React lifecycle (stable references)
 * - Polls git status every 3 seconds
 * - Manages git fetch with exponential backoff
 * - Notifies subscribers when status changes
 * - Components only re-render when their specific workspace status changes
 *
 * Migration from GitStatusContext:
 * - Eliminates provider re-renders every 3 seconds
 * - useSyncExternalStore enables selective re-renders
 * - Store manages polling logic internally (no useEffect cleanup in components)
 */

// Configuration
const GIT_STATUS_INTERVAL_MS = 3000; // 3 seconds - interactive updates
const MAX_CONCURRENT_GIT_OPS = 5;

// Fetch configuration - aggressive intervals for fresh data
const FETCH_BASE_INTERVAL_MS = 3 * 1000; // 3 seconds
const FETCH_MAX_INTERVAL_MS = 60 * 1000; // 60 seconds

interface FetchState {
  lastFetch: number;
  inProgress: boolean;
  consecutiveFailures: number;
}

export class GitStatusStore {
  private statuses = new MapStore<string, GitStatus | null>();
  private fetchCache = new Map<string, FetchState>();
  private client: RouterClient<AppRouter> | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private workspaceMetadata = new Map<string, FrontendWorkspaceMetadata>();
  private isActive = true;

  setClient(client: RouterClient<AppRouter>) {
    this.client = client;
  }
  constructor() {
    // Store is ready for workspace sync
  }

  /**
   * Subscribe to git status changes (any workspace).
   * Delegates to MapStore's subscribeAny.
   */
  subscribe = this.statuses.subscribeAny;

  /**
   * Subscribe to git status changes for a specific workspace.
   * Only notified when this workspace's status changes.
   */
  subscribeKey = (workspaceId: string, listener: () => void) => {
    return this.statuses.subscribeKey(workspaceId, listener);
  };

  /**
   * Get git status for a specific workspace.
   * Returns cached status or null if never fetched.
   */
  getStatus(workspaceId: string): GitStatus | null {
    // If workspace has never been checked, return null
    if (!this.statuses.has(workspaceId)) {
      return null;
    }

    // Return cached status (lazy computation)
    return this.statuses.get(workspaceId, () => {
      return this.statusCache.get(workspaceId) ?? null;
    });
  }

  private statusCache = new Map<string, GitStatus | null>();

  /**
   * Sync workspaces with metadata.
   * Called when workspace list changes.
   */
  syncWorkspaces(metadata: Map<string, FrontendWorkspaceMetadata>): void {
    // Reactivate if disposed by React Strict Mode (dev only)
    // In dev, Strict Mode unmounts/remounts, disposing the store but reusing the ref
    if (!this.isActive && metadata.size > 0) {
      this.isActive = true;
    }

    this.workspaceMetadata = metadata;

    // Remove statuses for deleted workspaces
    // Iterate plain map (statusCache) for membership, not reactive store
    for (const id of Array.from(this.statusCache.keys())) {
      if (!metadata.has(id)) {
        this.statusCache.delete(id);
        this.statuses.delete(id); // Also clean up reactive state
      }
    }

    // Start polling only once (not on every sync)
    if (!this.pollInterval) {
      this.startPolling();
    }
  }

  /**
   * Start polling git status.
   */
  private startPolling(): void {
    // Clear existing interval
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }

    // Run immediately
    void this.updateGitStatus();

    // Poll at configured interval
    this.pollInterval = setInterval(() => {
      void this.updateGitStatus();
    }, GIT_STATUS_INTERVAL_MS);
  }

  /**
   * Stop polling git status.
   */
  private stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Update git status for all workspaces.
   */
  private async updateGitStatus(): Promise<void> {
    if (this.workspaceMetadata.size === 0 || !this.isActive) {
      return;
    }

    // Only poll workspaces that have active subscribers
    const workspaces = Array.from(this.workspaceMetadata.values()).filter((ws) =>
      this.statuses.hasKeySubscribers(ws.id)
    );

    if (workspaces.length === 0) {
      return;
    }

    // Try to fetch workspaces that need it (background, non-blocking)
    const workspacesMap = new Map(workspaces.map((ws) => [ws.id, ws]));
    this.tryFetchWorkspaces(workspacesMap);

    // Query git status for each workspace
    // Rate limit: Process in batches to prevent bash process explosion
    const results: Array<[string, GitStatus | null]> = [];

    for (let i = 0; i < workspaces.length; i += MAX_CONCURRENT_GIT_OPS) {
      if (!this.isActive) break; // Stop if disposed

      const batch = workspaces.slice(i, i + MAX_CONCURRENT_GIT_OPS);
      const batchPromises = batch.map((metadata) => this.checkWorkspaceStatus(metadata));

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    if (!this.isActive) return; // Don't update state if disposed

    // Update statuses - bump version if changed
    for (const [workspaceId, newStatus] of results) {
      const oldStatus = this.statusCache.get(workspaceId) ?? null;

      // Check if status actually changed (cheap for simple objects)
      if (!this.areStatusesEqual(oldStatus, newStatus)) {
        // Only update cache on successful status check (preserve old status on failure)
        // This prevents UI flicker when git operations timeout or fail transiently
        if (newStatus !== null) {
          this.statusCache.set(workspaceId, newStatus);
          this.statuses.bump(workspaceId); // Invalidate cache + notify
        }
        // On failure (newStatus === null): keep old status, don't bump (no re-render)
      }
    }
  }

  /**
   * Compare two git statuses for equality.
   * Returns true if they're effectively the same.
   */
  private areStatusesEqual(a: GitStatus | null, b: GitStatus | null): boolean {
    if (a === null && b === null) return true;
    if (a === null || b === null) return false;

    return a.ahead === b.ahead && a.behind === b.behind && a.dirty === b.dirty;
  }

  /**
   * Check git status for a single workspace.
   */
  private async checkWorkspaceStatus(
    metadata: FrontendWorkspaceMetadata
  ): Promise<[string, GitStatus | null]> {
    // Defensive: Return null if client is unavailable
    if (!this.client) {
      return [metadata.id, null];
    }

    try {
      const result = await this.client.workspace.executeBash({
        workspaceId: metadata.id,
        script: GIT_STATUS_SCRIPT,
        options: {
          timeout_secs: 5,
          niceness: 19,
        },
      });

      if (!result.success) {
        console.debug(`[gitStatus] IPC failed for ${metadata.id}:`, result.error);
        return [metadata.id, null];
      }

      if (!result.data.success) {
        // Don't log output overflow errors at all (common in large repos, handled gracefully)
        if (
          !result.data.error?.includes("OUTPUT TRUNCATED") &&
          !result.data.error?.includes("OUTPUT OVERFLOW")
        ) {
          console.debug(`[gitStatus] Script failed for ${metadata.id}:`, result.data.error);
        }
        return [metadata.id, null];
      }

      // Parse the output using centralized function
      const parsed = parseGitStatusScriptOutput(result.data.output);

      if (!parsed) {
        console.debug(`[gitStatus] Could not parse output for ${metadata.id}`);
        return [metadata.id, null];
      }

      const { showBranchOutput, dirtyCount } = parsed;
      const dirty = dirtyCount > 0;

      // Parse ahead/behind from show-branch output
      const parsedStatus = parseGitShowBranchForStatus(showBranchOutput);

      if (!parsedStatus) {
        return [metadata.id, null];
      }

      return [metadata.id, { ...parsedStatus, dirty }];
    } catch (err) {
      // Silently fail - git status failures shouldn't crash the UI
      console.debug(`[gitStatus] Exception for ${metadata.id}:`, err);
      return [metadata.id, null];
    }
  }

  /**
   * Get a unique fetch key for a workspace.
   * For local workspaces: project name (shared git repo)
   * For SSH workspaces: workspace ID (each has its own git repo)
   */
  private getFetchKey(metadata: FrontendWorkspaceMetadata): string {
    const isSSH = isSSHRuntime(metadata.runtimeConfig);
    return isSSH ? metadata.id : metadata.projectName;
  }

  /**
   * Try to fetch workspaces that need it most urgently.
   * For SSH workspaces: each workspace has its own repo, so fetch each one.
   * For local workspaces: workspaces share a repo, so fetch once per project.
   */
  private tryFetchWorkspaces(workspaces: Map<string, FrontendWorkspaceMetadata>): void {
    // Find the workspace that needs fetching most urgently
    let targetFetchKey: string | null = null;
    let targetWorkspaceId: string | null = null;
    let oldestTime = Date.now();

    for (const metadata of workspaces.values()) {
      const fetchKey = this.getFetchKey(metadata);

      if (this.shouldFetch(fetchKey)) {
        const cache = this.fetchCache.get(fetchKey);
        const lastFetch = cache?.lastFetch ?? 0;

        if (lastFetch < oldestTime) {
          oldestTime = lastFetch;
          targetFetchKey = fetchKey;
          targetWorkspaceId = metadata.id;
        }
      }
    }

    if (targetFetchKey && targetWorkspaceId) {
      // Fetch in background (don't await - don't block status checks)
      void this.fetchWorkspace(targetFetchKey, targetWorkspaceId);
    }
  }

  /**
   * Check if a workspace/project should be fetched.
   */
  private shouldFetch(fetchKey: string): boolean {
    const cached = this.fetchCache.get(fetchKey);
    if (!cached) return true;
    if (cached.inProgress) return false;

    // Calculate delay with exponential backoff: 3s, 6s, 12s, 24s, 48s, 60s (max)
    const delay = Math.min(
      FETCH_BASE_INTERVAL_MS * Math.pow(2, cached.consecutiveFailures),
      FETCH_MAX_INTERVAL_MS
    );
    return Date.now() - cached.lastFetch > delay;
  }

  /**
   * Fetch updates for a workspace.
   * For local workspaces: fetches the shared project repo.
   * For SSH workspaces: fetches the workspace's individual repo.
   */
  private async fetchWorkspace(fetchKey: string, workspaceId: string): Promise<void> {
    // Defensive: Return early if client is unavailable
    if (!this.client) {
      return;
    }

    const cache = this.fetchCache.get(fetchKey) ?? {
      lastFetch: 0,
      inProgress: false,
      consecutiveFailures: 0,
    };

    if (cache.inProgress) return;

    // Mark as in progress
    this.fetchCache.set(fetchKey, { ...cache, inProgress: true });

    try {
      const result = await this.client.workspace.executeBash({
        workspaceId,
        script: GIT_FETCH_SCRIPT,
        options: {
          timeout_secs: 30,
          niceness: 19,
        },
      });

      if (!result.success) {
        throw new Error(result.error);
      }

      if (!result.data.success) {
        throw new Error(result.data.error || "Unknown error");
      }

      // Success - reset failure counter
      console.debug(`[fetch] Success for ${fetchKey}`);
      this.fetchCache.set(fetchKey, {
        lastFetch: Date.now(),
        inProgress: false,
        consecutiveFailures: 0,
      });
    } catch (error) {
      // All errors logged to console, never shown to user
      console.debug(`[fetch] Failed for ${fetchKey}:`, error);

      const newFailures = cache.consecutiveFailures + 1;
      const nextDelay = Math.min(
        FETCH_BASE_INTERVAL_MS * Math.pow(2, newFailures),
        FETCH_MAX_INTERVAL_MS
      );

      console.debug(
        `[fetch] Will retry ${fetchKey} after ${Math.round(nextDelay / 1000)}s ` +
          `(failure #${newFailures})`
      );

      this.fetchCache.set(fetchKey, {
        lastFetch: Date.now(),
        inProgress: false,
        consecutiveFailures: newFailures,
      });
    }
  }

  /**
   * Cleanup resources.
   */
  dispose(): void {
    this.isActive = false;
    this.stopPolling();
    this.statuses.clear();
    this.fetchCache.clear();
  }
}

// ============================================================================
// React Integration with useSyncExternalStore
// ============================================================================

// Singleton store instance
let gitStoreInstance: GitStatusStore | null = null;

/**
 * Get or create the singleton GitStatusStore instance.
 */
function getGitStoreInstance(): GitStatusStore {
  gitStoreInstance ??= new GitStatusStore();
  return gitStoreInstance;
}

/**
 * Hook to get git status for a specific workspace.
 * Only re-renders when THIS workspace's status changes.
 *
 * Uses per-key subscription for surgical updates - only notified when
 * this specific workspace's git status changes.
 */
export function useGitStatus(workspaceId: string): GitStatus | null {
  const store = getGitStoreInstance();

  return useSyncExternalStore(
    (listener) => store.subscribeKey(workspaceId, listener),
    () => store.getStatus(workspaceId)
  );
}

/**
 * Hook to access the raw store for imperative operations.
 */
export function useGitStatusStoreRaw(): GitStatusStore {
  return getGitStoreInstance();
}
