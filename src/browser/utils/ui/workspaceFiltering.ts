import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { ProjectConfig, SectionConfig } from "@/common/types/project";

// Re-export shared section sorting utility
export { sortSectionsByLinkedList } from "@/common/utils/sections";

function flattenWorkspaceTree(
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
  // IMPORTANT: Include deterministic tie-breakers so Storybook/Chromatic snapshots can't
  // flip ordering when multiple workspaces have equal recency.
  for (const metadataList of result.values()) {
    metadataList.sort((a, b) => {
      const aTimestamp = workspaceRecency[a.id] ?? 0;
      const bTimestamp = workspaceRecency[b.id] ?? 0;
      if (aTimestamp !== bTimestamp) {
        return bTimestamp - aTimestamp;
      }

      const aCreatedAtRaw = Date.parse(a.createdAt ?? "");
      const bCreatedAtRaw = Date.parse(b.createdAt ?? "");
      const aCreatedAt = Number.isFinite(aCreatedAtRaw) ? aCreatedAtRaw : 0;
      const bCreatedAt = Number.isFinite(bCreatedAtRaw) ? bCreatedAtRaw : 0;
      if (aCreatedAt !== bCreatedAt) {
        return bCreatedAt - aCreatedAt;
      }

      if (a.name !== b.name) {
        return a.name < b.name ? -1 : 1;
      }

      if (a.id !== b.id) {
        return a.id < b.id ? -1 : 1;
      }

      return 0;
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
 * Build the storage key for a tier's expanded state.
 */
export function getTierKey(projectPath: string, tierIndex: number): string {
  return `${projectPath}:${tierIndex}`;
}

/**
 * Compute all visible workspaces across all projects in sidebar display order.
 * Respects project ordering, project expansion, and age-tier expansion.
 *
 * @param sortedProjectPaths - Project paths in display order
 * @param sortedWorkspacesByProject - Workspaces per project in display order
 * @param expandedProjects - Set of expanded project paths
 * @param workspaceRecency - Recency timestamps
 * @param expandedOldWorkspaces - Record of expanded tier states
 * @returns Array of visible workspaces in sidebar display order
 */
export function getAllVisibleWorkspaces(
  sortedProjectPaths: string[],
  sortedWorkspacesByProject: Map<string, FrontendWorkspaceMetadata[]>,
  expandedProjects: Set<string>,
  workspaceRecency: Record<string, number>,
  expandedOldWorkspaces: Record<string, boolean>
): FrontendWorkspaceMetadata[] {
  const allVisible: FrontendWorkspaceMetadata[] = [];

  for (const projectPath of sortedProjectPaths) {
    // Skip collapsed projects
    if (!expandedProjects.has(projectPath)) continue;

    const workspaces = sortedWorkspacesByProject.get(projectPath) ?? [];
    const visible = getVisibleWorkspaces(
      projectPath,
      workspaces,
      workspaceRecency,
      expandedOldWorkspaces
    );
    allVisible.push(...visible);
  }

  return allVisible;
}

/**
 * Find the next non-empty tier starting from a given index.
 * @returns The index of the next non-empty bucket, or -1 if none found.
 */
export function findNextNonEmptyTier(
  buckets: FrontendWorkspaceMetadata[][],
  startIndex: number
): number {
  for (let i = startIndex; i < buckets.length; i++) {
    if (buckets[i].length > 0) return i;
  }
  return -1;
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

/**
 * Compute which workspaces are currently visible in the sidebar.
 * Respects the expanded/collapsed state of age-based tier sections.
 *
 * @param projectPath - The project path (used to build tier keys)
 * @param workspaces - All workspaces for the project (in display order)
 * @param workspaceRecency - Recency timestamps
 * @param expandedOldWorkspaces - Record of expanded tier states (keys: "projectPath:tierIndex")
 * @returns Array of visible workspaces in display order
 */
export function getVisibleWorkspaces(
  projectPath: string,
  workspaces: FrontendWorkspaceMetadata[],
  workspaceRecency: Record<string, number>,
  expandedOldWorkspaces: Record<string, boolean>
): FrontendWorkspaceMetadata[] {
  if (workspaces.length === 0) return [];

  const { recent, buckets } = partitionWorkspacesByAge(workspaces, workspaceRecency);
  const visible: FrontendWorkspaceMetadata[] = [...recent];

  // Traverse expanded tiers in order
  let currentTier = findNextNonEmptyTier(buckets, 0);
  while (currentTier !== -1) {
    const isExpanded = expandedOldWorkspaces[getTierKey(projectPath, currentTier)] ?? false;

    if (!isExpanded) {
      // Tier is collapsed, stop traversing
      break;
    }

    // Add this tier's workspaces
    visible.push(...buckets[currentTier]);
    // Move to next non-empty tier
    currentTier = findNextNonEmptyTier(buckets, currentTier + 1);
  }

  return visible;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section-based workspace grouping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of partitioning workspaces by section.
 * - unsectioned: workspaces not assigned to any section
 * - bySectionId: map of section ID to workspaces in that section
 */
export interface SectionPartitionResult {
  unsectioned: FrontendWorkspaceMetadata[];
  bySectionId: Map<string, FrontendWorkspaceMetadata[]>;
}

/**
 * Partition workspaces by their sectionId.
 * Preserves input order within each partition.
 *
 * @param workspaces - All workspaces for the project (in display order)
 * @param sections - Section configs for the project (used to validate section IDs)
 * @returns Partitioned workspaces
 */
export function partitionWorkspacesBySection(
  workspaces: FrontendWorkspaceMetadata[],
  sections: SectionConfig[]
): SectionPartitionResult {
  const sectionIds = new Set(sections.map((s) => s.id));
  const unsectioned: FrontendWorkspaceMetadata[] = [];
  const bySectionId = new Map<string, FrontendWorkspaceMetadata[]>();

  // Initialize all sections with empty arrays to ensure consistent ordering
  for (const section of sections) {
    bySectionId.set(section.id, []);
  }

  // Build workspace lookup for parent resolution
  const byId = new Map<string, FrontendWorkspaceMetadata>();
  for (const workspace of workspaces) {
    byId.set(workspace.id, workspace);
  }

  // Resolve effective section for a workspace (inherit from parent if unset)
  const resolveSection = (workspace: FrontendWorkspaceMetadata): string | undefined => {
    if (workspace.sectionId && sectionIds.has(workspace.sectionId)) {
      return workspace.sectionId;
    }
    // Inherit from parent if child has no section
    if (workspace.parentWorkspaceId) {
      const parent = byId.get(workspace.parentWorkspaceId);
      if (parent) {
        return resolveSection(parent);
      }
    }
    return undefined;
  };

  for (const workspace of workspaces) {
    const effectiveSectionId = resolveSection(workspace);
    if (effectiveSectionId) {
      const list = bySectionId.get(effectiveSectionId)!;
      list.push(workspace);
    } else {
      unsectioned.push(workspace);
    }
  }

  return { unsectioned, bySectionId };
}

/**
 * Build the storage key for a section's expanded state.
 */
export function getSectionExpandedKey(projectPath: string, sectionId: string): string {
  return `section:${projectPath}:${sectionId}`;
}

/**
 * Build the storage key for a section's age tier expanded state.
 * This is separate from project-level tiers to allow per-section age collapse.
 */
export function getSectionTierKey(
  projectPath: string,
  sectionId: string,
  tierIndex: number
): string {
  return `section:${projectPath}:${sectionId}:tier:${tierIndex}`;
}
