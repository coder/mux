import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { ProjectConfig } from "@/common/types/project";

export function flattenWorkspaceTree(
  workspaces: FrontendWorkspaceMetadata[]
): FrontendWorkspaceMetadata[] {
  if (workspaces.length === 0) return [];

  const byId = new Map<string, FrontendWorkspaceMetadata>();
  for (const workspace of workspaces) {
    byId.set(workspace.id, workspace);
  }

  const childrenByParent = new Map<string, FrontendWorkspaceMetadata[]>();
  const roots: FrontendWorkspaceMetadata[] = [];

  // Preserve input order for both roots and siblings by iterating in-order.
  for (const workspace of workspaces) {
    const parentId = workspace.parentWorkspaceId;
    if (parentId && byId.has(parentId)) {
      const children = childrenByParent.get(parentId) ?? [];
      children.push(workspace);
      childrenByParent.set(parentId, children);
    } else {
      roots.push(workspace);
    }
  }

  const result: FrontendWorkspaceMetadata[] = [];
  const visited = new Set<string>();

  const visit = (workspace: FrontendWorkspaceMetadata, depth: number) => {
    if (visited.has(workspace.id)) return;
    visited.add(workspace.id);

    // Cap depth defensively to avoid pathological cycles/graphs.
    if (depth > 32) {
      result.push(workspace);
      return;
    }

    result.push(workspace);
    const children = childrenByParent.get(workspace.id);
    if (children) {
      for (const child of children) {
        visit(child, depth + 1);
      }
    }
  };

  for (const root of roots) {
    visit(root, 0);
  }

  // Fallback: ensure we include any remaining nodes (cycles, missing parents, etc.).
  for (const workspace of workspaces) {
    if (!visited.has(workspace.id)) {
      visit(workspace, 0);
    }
  }

  return result;
}

export function computeWorkspaceDepthMap(
  workspaces: FrontendWorkspaceMetadata[]
): Record<string, number> {
  const byId = new Map<string, FrontendWorkspaceMetadata>();
  for (const workspace of workspaces) {
    byId.set(workspace.id, workspace);
  }

  const depths = new Map<string, number>();
  const visiting = new Set<string>();

  const computeDepth = (workspaceId: string): number => {
    const existing = depths.get(workspaceId);
    if (existing !== undefined) return existing;

    if (visiting.has(workspaceId)) {
      // Cycle detected - treat as root.
      return 0;
    }

    visiting.add(workspaceId);
    const workspace = byId.get(workspaceId);
    const parentId = workspace?.parentWorkspaceId;
    const depth = parentId && byId.has(parentId) ? Math.min(computeDepth(parentId) + 1, 32) : 0;
    visiting.delete(workspaceId);

    depths.set(workspaceId, depth);
    return depth;
  };

  for (const workspace of workspaces) {
    computeDepth(workspace.id);
  }

  return Object.fromEntries(depths);
}

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

  // Sort each project's workspaces by recency (sort mutates in place)
  for (const metadataList of result.values()) {
    metadataList.sort((a, b) => {
      const aTimestamp = workspaceRecency[a.id] ?? 0;
      const bTimestamp = workspaceRecency[b.id] ?? 0;
      return bTimestamp - aTimestamp;
    });
  }

  // Ensure child workspaces appear directly below their parents.
  for (const [projectPath, metadataList] of result) {
    result.set(projectPath, flattenWorkspaceTree(metadataList));
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

  const now = Date.now();
  const thresholdMs = AGE_THRESHOLDS_DAYS.map((d) => d * DAY_MS);

  const recent: FrontendWorkspaceMetadata[] = [];
  const buckets: FrontendWorkspaceMetadata[][] = AGE_THRESHOLDS_DAYS.map(() => []);

  for (const workspace of workspaces) {
    const recencyTimestamp = workspaceRecency[workspace.id] ?? 0;
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
