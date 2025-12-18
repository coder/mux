import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { ProjectConfig } from "@/common/types/project";

/**
 * Age thresholds for workspace filtering, in ascending order.
 * Each tier hides workspaces older than the specified duration.
 */
export const AGE_THRESHOLDS_DAYS = [1, 7, 30] as const;
export type AgeThresholdDays = (typeof AGE_THRESHOLDS_DAYS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Workspace metadata extended with computed nesting depth */
export interface WorkspaceWithNesting extends FrontendWorkspaceMetadata {
  /** Nesting depth (0 = top-level, 1 = direct child, etc.) */
  nestingDepth: number;
}

/**
 * Sort workspaces so children appear immediately after their parent.
 * Maintains recency order within each level.
 */
export function sortWithNesting(
  metadataList: FrontendWorkspaceMetadata[],
  workspaceRecency: Record<string, number>
): WorkspaceWithNesting[] {
  // Build parent→children map
  const childrenByParent = new Map<string, FrontendWorkspaceMetadata[]>();
  const topLevel: FrontendWorkspaceMetadata[] = [];

  for (const ws of metadataList) {
    const parentId = ws.parentWorkspaceId;
    if (parentId) {
      const siblings = childrenByParent.get(parentId) ?? [];
      siblings.push(ws);
      childrenByParent.set(parentId, siblings);
    } else {
      topLevel.push(ws);
    }
  }

  // Sort by recency (most recent first)
  const sortByRecency = (a: FrontendWorkspaceMetadata, b: FrontendWorkspaceMetadata) => {
    const aTs = workspaceRecency[a.id] ?? 0;
    const bTs = workspaceRecency[b.id] ?? 0;
    return bTs - aTs;
  };

  topLevel.sort(sortByRecency);
  for (const children of childrenByParent.values()) {
    children.sort(sortByRecency);
  }

  // Flatten: parent, then children recursively
  const result: WorkspaceWithNesting[] = [];

  const visit = (ws: FrontendWorkspaceMetadata, depth: number) => {
    result.push({ ...ws, nestingDepth: depth });
    const children = childrenByParent.get(ws.id) ?? [];
    for (const child of children) {
      visit(child, depth + 1);
    }
  };

  for (const ws of topLevel) {
    visit(ws, 0);
  }

  return result;
}

/**
 * Build a map of project paths to sorted workspace metadata lists.
 * Includes both persisted workspaces (from config) and pending workspaces
 * (status: "creating") that haven't been saved yet.
 *
 * Workspaces are sorted by recency (most recent first), with child workspaces
 * (agent tasks) appearing directly below their parent with indentation.
 */
export function buildSortedWorkspacesByProject(
  projects: Map<string, ProjectConfig>,
  workspaceMetadata: Map<string, FrontendWorkspaceMetadata>,
  workspaceRecency: Record<string, number>
): Map<string, WorkspaceWithNesting[]> {
  const result = new Map<string, WorkspaceWithNesting[]>();
  const includedIds = new Set<string>();

  // First pass: collect workspaces from persisted config
  const collectedByProject = new Map<string, FrontendWorkspaceMetadata[]>();
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
    collectedByProject.set(projectPath, metadataList);
  }

  // Second pass: add pending workspaces (status: "creating") not yet in config
  for (const [id, metadata] of workspaceMetadata) {
    if (metadata.status === "creating" && !includedIds.has(id)) {
      const projectWorkspaces = collectedByProject.get(metadata.projectPath) ?? [];
      projectWorkspaces.push(metadata);
      collectedByProject.set(metadata.projectPath, projectWorkspaces);
    }
  }

  // Sort with nesting for each project
  for (const [projectPath, metadataList] of collectedByProject) {
    result.set(projectPath, sortWithNesting(metadataList, workspaceRecency));
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
export interface AgePartitionResult<T extends FrontendWorkspaceMetadata = WorkspaceWithNesting> {
  recent: T[];
  buckets: T[][];
}

/**
 * Partition workspaces into age-based buckets.
 * Always shows at least one workspace in the recent section (the most recent one).
 */
export function partitionWorkspacesByAge<T extends FrontendWorkspaceMetadata>(
  workspaces: T[],
  workspaceRecency: Record<string, number>
): AgePartitionResult<T> {
  if (workspaces.length === 0) {
    return { recent: [], buckets: AGE_THRESHOLDS_DAYS.map(() => []) };
  }

  const now = Date.now();
  const thresholdMs = AGE_THRESHOLDS_DAYS.map((d) => d * DAY_MS);

  const recent: T[] = [];
  const buckets: T[][] = AGE_THRESHOLDS_DAYS.map(() => []);

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
