import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import type { FrontendWorkspaceMetadata, GitStatus } from "@/common/types/workspace";
import {
  generateGitStatusScript,
  GIT_FETCH_SCRIPT,
  parseGitStatusScriptOutput,
} from "@/common/utils/git/gitStatus";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { STORAGE_KEYS, WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { useSyncExternalStore } from "react";
import { MapStore } from "./MapStore";
import { isSSHRuntime } from "@/common/types/runtime";
import { RefreshController } from "@/browser/utils/RefreshController";

/**
 * External store for git status of all workspaces.
 *
 * Architecture:
 * - Lives outside React lifecycle (stable references)
 * - Event-driven updates (no polling):
 *   - Initial subscription triggers immediate fetch
 *   - File-modifying tools trigger debounced refresh (3s)
 *   - Window focus triggers refresh for visible workspaces
 *   - Explicit invalidation (branch switch, etc.)
 * - Manages git fetch with exponential backoff
 * - Notifies subscribers when status changes
 * - Components only re-render when their specific workspace status changes
 *
 * Uses RefreshController for debouncing, focus handling, and in-flight guards.
 */

// Configuration
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
  private immediateUpdateQueued = false;
  private workspaceMetadata = new Map<string, FrontendWorkspaceMetadata>();
  private isActive = true;

  // File modification subscription
  private fileModifyUnsubscribe: (() => void) | null = null;

  // RefreshController handles debouncing, focus/visibility, and in-flight guards
  private readonly refreshController: RefreshController;

  // Per-workspace refreshing state for UI shimmer effects
  private refreshingWorkspaces = new MapStore<string, boolean>();

  setClient(client: RouterClient<AppRouter>) {
    this.client = client;
  }

  constructor() {
    // Create refresh controller with proactive focus refresh (catches external git changes)
    this.refreshController = new RefreshController({
      onRefresh: () => this.updateGitStatus(),
      debounceMs: 3000, // Same as TOOL_REFRESH_DEBOUNCE_MS in ReviewPanel
      refreshOnFocus: true, // Proactively refresh on focus to catch external changes
      focusDebounceMs: 500, // Prevent spam from rapid alt-tabbing
    });
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
    const unsubscribe = this.statuses.subscribeKey(workspaceId, listener);

    // If a component subscribes after initial load, kick an immediate update
    // so the UI doesn't wait. Uses microtask to batch multiple subscriptions.
    // Routes through RefreshController to respect in-flight guards.
    if (!this.immediateUpdateQueued && this.isActive && this.client) {
      this.immediateUpdateQueued = true;
      queueMicrotask(() => {
        this.immediateUpdateQueued = false;
        this.refreshController.requestImmediate();
      });
    }

    return unsubscribe;
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

  /**
   * Invalidate status for a workspace, triggering immediate refresh.
   * Call after operations that change git state (e.g., branch switch).
   *
   * Note: Old status is preserved during refresh to avoid UI flash.
   * Components can use isWorkspaceRefreshing() to show a shimmer effect.
   */
  invalidateWorkspace(workspaceId: string): void {
    // Increment generation to mark any in-flight status checks as stale
    const currentGen = this.invalidationGeneration.get(workspaceId) ?? 0;
    this.invalidationGeneration.set(workspaceId, currentGen + 1);
    // Mark workspace as refreshing (for shimmer effect)
    this.setWorkspaceRefreshing(workspaceId, true);
    // Trigger immediate refresh (routes through RefreshController for in-flight guard)
    this.refreshController.requestImmediate();
  }

  /**
   * Set the refreshing state for a workspace and notify subscribers.
   */
  private setWorkspaceRefreshing(workspaceId: string, refreshing: boolean): void {
    this.refreshingWorkspaces.bump(workspaceId);
    // Store the actual value in a simple map (MapStore is for notifications)
    this.refreshingWorkspacesCache.set(workspaceId, refreshing);
  }

  private refreshingWorkspacesCache = new Map<string, boolean>();

  /**
   * Check if a workspace is currently refreshing.
   */
  isWorkspaceRefreshing(workspaceId: string): boolean {
    return this.refreshingWorkspacesCache.get(workspaceId) ?? false;
  }

  /**
   * Check if any git status fetch is currently in-flight.
   * Use this to ensure no background fetch can race with operations that change git state.
   */
  isAnyRefreshInFlight(): boolean {
    return this.refreshController.isRefreshing;
  }

  /**
   * Subscribe to refreshing state changes for a specific workspace.
   */
  subscribeRefreshingKey = (workspaceId: string, listener: () => void) => {
    return this.refreshingWorkspaces.subscribeKey(workspaceId, listener);
  };

  private statusCache = new Map<string, GitStatus | null>();
  // Generation counter to detect and ignore stale status updates after invalidation.
  // Incremented on invalidate; status updates check generation to avoid race conditions.
  private invalidationGeneration = new Map<string, number>();

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
        this.invalidationGeneration.delete(id);
        this.statuses.delete(id); // Also clean up reactive state
      }
    }

    // Bind focus/visibility listeners once (catches external git changes)
    this.refreshController.bindListeners();

    // Initial fetch for all workspaces (routes through RefreshController)
    this.refreshController.requestImmediate();
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

    // Capture current generation for each workspace to detect stale results
    const generationSnapshot = new Map<string, number>();
    for (const ws of workspaces) {
      generationSnapshot.set(ws.id, this.invalidationGeneration.get(ws.id) ?? 0);
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
      // Skip stale results: if generation changed since we started, the result is outdated
      const snapshotGen = generationSnapshot.get(workspaceId) ?? 0;
      const currentGen = this.invalidationGeneration.get(workspaceId) ?? 0;
      if (snapshotGen !== currentGen) {
        // Status was invalidated during check - discard this stale result
        continue;
      }

      // Clear refreshing state now that we have a result
      if (this.refreshingWorkspacesCache.get(workspaceId)) {
        this.setWorkspaceRefreshing(workspaceId, false);
      }

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

    return (
      a.ahead === b.ahead &&
      a.behind === b.behind &&
      a.dirty === b.dirty &&
      a.outgoingAdditions === b.outgoingAdditions &&
      a.outgoingDeletions === b.outgoingDeletions &&
      a.incomingAdditions === b.incomingAdditions &&
      a.incomingDeletions === b.incomingDeletions
    );
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
      // Use the same diff base as the review panel (per-workspace override,
      // falling back to the project default).
      const projectDefaultBase = readPersistedState<string>(
        STORAGE_KEYS.reviewDefaultBase(metadata.projectPath),
        WORKSPACE_DEFAULTS.reviewBase
      );
      const baseRef = readPersistedState<string>(
        STORAGE_KEYS.reviewDiffBase(metadata.id),
        projectDefaultBase
      );

      // Generate script with the configured base ref
      const script = generateGitStatusScript(baseRef);

      const result = await this.client.workspace.executeBash({
        workspaceId: metadata.id,
        script,
        options: { timeout_secs: 5 },
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

      if (result.data.note?.includes("OUTPUT OVERFLOW")) {
        return [metadata.id, null];
      }

      // Parse the output using centralized function
      const parsed = parseGitStatusScriptOutput(result.data.output);

      if (!parsed) {
        console.debug(`[gitStatus] Could not parse output for ${metadata.id}`);
        return [metadata.id, null];
      }

      const {
        ahead,
        behind,
        dirtyCount,
        outgoingAdditions,
        outgoingDeletions,
        incomingAdditions,
        incomingDeletions,
      } = parsed;
      const dirty = dirtyCount > 0;

      return [
        metadata.id,
        {
          ahead,
          behind,
          dirty,
          outgoingAdditions,
          outgoingDeletions,
          incomingAdditions,
          incomingDeletions,
        },
      ];
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
        options: { timeout_secs: 30 },
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
    this.statuses.clear();
    this.refreshingWorkspaces.clear();
    this.refreshingWorkspacesCache.clear();
    this.fetchCache.clear();
    this.fileModifyUnsubscribe?.();
    this.fileModifyUnsubscribe = null;
    this.refreshController.dispose();
  }

  /**
   * Subscribe to file-modifying tool completions from WorkspaceStore.
   * Triggers debounced git status refresh when files change.
   * Idempotent: only subscribes once, subsequent calls are no-ops.
   */
  subscribeToFileModifications(
    subscribeAny: (listener: (workspaceId: string) => void) => () => void
  ): void {
    // Only subscribe once - subsequent calls are no-ops
    if (this.fileModifyUnsubscribe) {
      return;
    }

    this.fileModifyUnsubscribe = subscribeAny((workspaceId) => {
      // Only schedule if workspace has subscribers (same optimization as before)
      if (!this.statuses.hasKeySubscribers(workspaceId)) {
        return;
      }

      // RefreshController handles debouncing, focus gating, and in-flight guards
      this.refreshController.schedule();
    });
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
 * Hook to check if a workspace's git status is currently being refreshed.
 * Use this to show shimmer/loading effects while preserving old status.
 */
export function useGitStatusRefreshing(workspaceId: string): boolean {
  const store = getGitStoreInstance();

  return useSyncExternalStore(
    (listener) => store.subscribeRefreshingKey(workspaceId, listener),
    () => store.isWorkspaceRefreshing(workspaceId)
  );
}

/**
 * Hook to access the raw store for imperative operations.
 */
export function useGitStatusStoreRaw(): GitStatusStore {
  return getGitStoreInstance();
}

/**
 * Invalidate git status for a workspace, triggering an immediate refresh.
 * Call this after operations that change git state (e.g., branch switch).
 */
export function invalidateGitStatus(workspaceId: string): void {
  const store = getGitStoreInstance();
  store.invalidateWorkspace(workspaceId);
}
