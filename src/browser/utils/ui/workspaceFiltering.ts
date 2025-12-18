import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { ProjectConfig } from "@/common/types/project";

/**
 * Age thresholds for workspace filtering, in ascending order.
 * Each tier hides workspaces older than the specified duration.
 */
export const AGE_THRESHOLDS_DAYS = [1, 7, 30] as const;
export type AgeThresholdDays = (typeof AGE_THRESHOLDS_DAYS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build a map of project paths to sorted workspace metadata lists.
 * Includes both persisted workspaces (from config) and pending workspaces
 * (status: "creating") that haven't been saved yet.
 *
 * Workspaces are sorted by recency (most recent first).
 */
export function buildSortedWorkspacesByProject(
  projects: Map<string, ProjectConfig>,
  workspaceMetadata: Map<string, FrontendWorkspaceMetadata>,
  workspaceRecency: Record<string, number>
): Map<string, FrontendWorkspaceMetadata[]> {
  const result = new Map<string, FrontendWorkspaceMetadata[]>();
  const includedIds = new Set<string>();

  // First pass: include workspaces from persisted config
  for (const [projectPath, config] of projects) {
    const metadataList: FrontendWorkspaceMetadata[] = [];
    for (const ws of config.workspaces) {
      if (!ws.id) continue;
      const meta = workspaceMetadata.get(ws.id);
      if (meta) {
        metadataList.push(meta);
        includedIds.add(ws.id);
      }
    }
    result.set(projectPath, metadataList);
  }

  // Second pass: add pending workspaces (status: "creating") not yet in config
  for (const [id, metadata] of workspaceMetadata) {
    if (metadata.status === "creating" && !includedIds.has(id)) {
      const projectWorkspaces = result.get(metadata.projectPath) ?? [];
      projectWorkspaces.push(metadata);
      result.set(metadata.projectPath, projectWorkspaces);
    }
  }

  // Sort each project's workspaces by recency (sort mutates in place), then
  // flatten parent/child workspaces so sub-workspaces render directly beneath their parent.
  for (const [projectPath, metadataList] of result.entries()) {
    metadataList.sort((a, b) => {
      const aTimestamp = workspaceRecency[a.id] ?? 0;
      const bTimestamp = workspaceRecency[b.id] ?? 0;
      return bTimestamp - aTimestamp;
    });

    const metadataById = new Map(metadataList.map((m) => [m.id, m] as const));
    const childrenByParent = new Map<string, FrontendWorkspaceMetadata[]>();

    for (const workspace of metadataList) {
      const parentId = workspace.parentWorkspaceId;
      if (!parentId || !metadataById.has(parentId)) {
        continue;
      }
      const list = childrenByParent.get(parentId) ?? [];
      list.push(workspace);
      childrenByParent.set(parentId, list);
    }

    const roots = metadataList.filter((workspace) => {
      const parentId = workspace.parentWorkspaceId;
      return !parentId || !metadataById.has(parentId);
    });

    const flattened: FrontendWorkspaceMetadata[] = [];
    const seen = new Set<string>();

    const visit = (workspace: FrontendWorkspaceMetadata, depth = 0) => {
      if (seen.has(workspace.id)) {
        return;
      }

      // Safety valve against cycles.
      if (depth > 100) {
        return;
      }

      seen.add(workspace.id);
      flattened.push(workspace);

      const children = childrenByParent.get(workspace.id);
      if (!children) {
        return;
      }

      for (const child of children) {
        visit(child, depth + 1);
      }
    };

    for (const root of roots) {
      visit(root);
    }

    // If we had cycles or missing parents, ensure we still render every workspace.
    for (const workspace of metadataList) {
      visit(workspace);
    }

    result.set(projectPath, flattened);
  }

  return result;
}

/**
 * Format a day count for display.
 * Returns a human-readable string like "1 day", "7 days", etc.
 */
export function formatDaysThreshold(days: number): string {
  return days === 1 ? "1 day" : `${days} days`;
}

/**
 * Result of partitioning workspaces by age thresholds.
 * - recent: workspaces newer than the first threshold (1 day)
 * - buckets: array of workspaces for each threshold tier
 *   - buckets[0]: older than 1 day but newer than 7 days
 *   - buckets[1]: older than 7 days but newer than 30 days
 *   - buckets[2]: older than 30 days
 */
export interface AgePartitionResult {
  recent: FrontendWorkspaceMetadata[];
  buckets: FrontendWorkspaceMetadata[][];
}

/**
 * Partition workspaces into age-based buckets.
 * Always shows at least one workspace in the recent section (the most recent one).
 */
export function partitionWorkspacesByAge(
  workspaces: FrontendWorkspaceMetadata[],
  workspaceRecency: Record<string, number>
): AgePartitionResult {
  if (workspaces.length === 0) {
    return { recent: [], buckets: AGE_THRESHOLDS_DAYS.map(() => []) };
  }

  const metadataById = new Map(workspaces.map((w) => [w.id, w] as const));
  const effectiveRecencyCache = new Map<string, number>();

  const getEffectiveRecencyTimestamp = (workspaceId: string, depth = 0): number => {
    const cached = effectiveRecencyCache.get(workspaceId);
    if (cached !== undefined) {
      return cached;
    }

    // Safety valve against cycles.
    if (depth > 100) {
      const fallback = workspaceRecency[workspaceId] ?? 0;
      effectiveRecencyCache.set(workspaceId, fallback);
      return fallback;
    }

    const workspace = metadataById.get(workspaceId);
    const parentId = workspace?.parentWorkspaceId;
    if (parentId && metadataById.has(parentId)) {
      const parentTs = getEffectiveRecencyTimestamp(parentId, depth + 1);
      effectiveRecencyCache.set(workspaceId, parentTs);
      return parentTs;
    }

    const ts = workspaceRecency[workspaceId] ?? 0;
    effectiveRecencyCache.set(workspaceId, ts);
    return ts;
  };
  const now = Date.now();
  const thresholdMs = AGE_THRESHOLDS_DAYS.map((d) => d * DAY_MS);

  const recent: FrontendWorkspaceMetadata[] = [];
  const buckets: FrontendWorkspaceMetadata[][] = AGE_THRESHOLDS_DAYS.map(() => []);

  for (const workspace of workspaces) {
    const recencyTimestamp = getEffectiveRecencyTimestamp(workspace.id);
    const age = now - recencyTimestamp;

    if (age < thresholdMs[0]) {
      recent.push(workspace);
    } else {
      // Find which bucket this workspace belongs to
      // buckets[i] contains workspaces older than threshold[i] but newer than threshold[i+1]
      let placed = false;
      for (let i = 0; i < thresholdMs.length - 1; i++) {
        if (age >= thresholdMs[i] && age < thresholdMs[i + 1]) {
          buckets[i].push(workspace);
          placed = true;
          break;
        }
      }
      // Older than the last threshold
      if (!placed) {
        buckets[buckets.length - 1].push(workspace);
      }
    }
  }

  // Always show at least one workspace - move the most recent from first non-empty bucket
  if (recent.length === 0) {
    for (const bucket of buckets) {
      if (bucket.length > 0) {
        recent.push(bucket.shift()!);
        break;
      }
    }
  }

  return { recent, buckets };
}
