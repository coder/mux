import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { ProjectConfig, SectionConfig } from "@/common/types/project";
import { hasCompletedAgentReport } from "@/common/utils/agentTaskCompletion";
import { assert } from "@/common/utils/assert";

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
  // Active sub-workspaces only render when their full parent chain is active.
  for (const workspace of workspaces) {
    const parentId = workspace.parentWorkspaceId;
    if (parentId == null) {
      roots.push(workspace);
      continue;
    }

    if (!byId.has(parentId)) {
      continue;
    }

    const children = childrenByParent.get(parentId) ?? [];
    children.push(workspace);
    childrenByParent.set(parentId, children);
  }

  const result: FrontendWorkspaceMetadata[] = [];
  const visited = new Set<string>();
  const stack = roots.slice().reverse();

  while (stack.length > 0) {
    const workspace = stack.pop();
    assert(workspace != null, "flattenWorkspaceTree: stack entries must exist while traversing");

    if (visited.has(workspace.id)) {
      continue;
    }
    visited.add(workspace.id);
    result.push(workspace);

    const children = childrenByParent.get(workspace.id);
    if (!children) {
      continue;
    }

    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }

  for (const workspace of workspaces) {
    if (visited.has(workspace.id)) {
      continue;
    }

    assert(
      workspace.parentWorkspaceId != null,
      "flattenWorkspaceTree: unvisited root workspaces should have been traversed"
    );
    // Intentionally drop orphaned/cyclic descendants instead of promoting them to roots.
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

export interface AgentRowRenderMeta {
  depth: number;
  rowKind: "primary" | "subagent";
  connectorPosition: "single" | "middle" | "last";
  // Sub-agent trunks should render as a single continuous line, so each row
  // receives explicit geometry/animation flags derived from its visible sibling
  // order and the lowest running child in that sibling group.
  connectorStartsAtParent: boolean;
  sharedTrunkActiveThroughRow: boolean;
  sharedTrunkActiveBelowRow: boolean;
  // Nested sub-agents need ancestor continuation columns whenever an ancestor
  // branch has visible lower siblings, so connector rendering receives one trunk
  // descriptor per continuing ancestor depth.
  ancestorTrunks: ReadonlyArray<{ depth: number; active: boolean }>;
  hasHiddenCompletedChildren: boolean;
  visibleCompletedChildrenCount: number;
}

/**
 * Hide completed child tasks by default unless their parent is expanded.
 * Child visibility is inherited from ancestors so hidden parents also hide descendants.
 */
export function filterVisibleAgentRows(
  flattenedWorkspaces: FrontendWorkspaceMetadata[],
  expandedParentIds: ReadonlySet<string> = new Set()
): FrontendWorkspaceMetadata[] {
  if (flattenedWorkspaces.length === 0) {
    return [];
  }

  const byId = new Map<string, FrontendWorkspaceMetadata>();
  for (const workspace of flattenedWorkspaces) {
    byId.set(workspace.id, workspace);
  }

  const visibilityById = new Map<string, boolean>();
  const visiting = new Set<string>();

  const isVisible = (workspace: FrontendWorkspaceMetadata): boolean => {
    const cached = visibilityById.get(workspace.id);
    if (cached !== undefined) {
      return cached;
    }

    if (visiting.has(workspace.id)) {
      // Defensive cycle handling: keep nodes visible instead of accidentally hiding them forever.
      return true;
    }

    visiting.add(workspace.id);

    const parentId = workspace.parentWorkspaceId;
    if (!parentId) {
      visiting.delete(workspace.id);
      visibilityById.set(workspace.id, true);
      return true;
    }

    const parent = byId.get(parentId);
    if (!parent) {
      visiting.delete(workspace.id);
      visibilityById.set(workspace.id, true);
      return true;
    }

    const parentVisible = isVisible(parent);
    const isCompletedChildTask = hasCompletedAgentReport(workspace);
    const shouldHideCompletedChild = isCompletedChildTask && !expandedParentIds.has(parentId);
    const visible = parentVisible && !shouldHideCompletedChild;

    visiting.delete(workspace.id);
    visibilityById.set(workspace.id, visible);
    return visible;
  };

  return flattenedWorkspaces.filter((workspace) => isVisible(workspace));
}

/**
 * Build render metadata for visible rows in a flattened workspace tree.
 */
export function computeAgentRowRenderMeta(
  flattenedWorkspaces: FrontendWorkspaceMetadata[],
  depthByWorkspaceId: Record<string, number>,
  expandedParentIds: ReadonlySet<string> = new Set()
): Map<string, AgentRowRenderMeta> {
  const visibleRows = filterVisibleAgentRows(flattenedWorkspaces, expandedParentIds);
  const visibleWorkspaceIds = new Set(visibleRows.map((workspace) => workspace.id));

  const visibleChildrenByParent = new Map<string, FrontendWorkspaceMetadata[]>();
  const completedChildrenByParent = new Map<string, FrontendWorkspaceMetadata[]>();
  const visibleWorkspaceById = new Map<string, FrontendWorkspaceMetadata>();

  for (const workspace of visibleRows) {
    visibleWorkspaceById.set(workspace.id, workspace);

    const parentId = workspace.parentWorkspaceId;
    if (!parentId) {
      continue;
    }

    const siblings = visibleChildrenByParent.get(parentId) ?? [];
    siblings.push(workspace);
    visibleChildrenByParent.set(parentId, siblings);
  }

  for (const workspace of flattenedWorkspaces) {
    if (!workspace.parentWorkspaceId || !hasCompletedAgentReport(workspace)) {
      continue;
    }

    const completedChildren = completedChildrenByParent.get(workspace.parentWorkspaceId) ?? [];
    completedChildren.push(workspace);
    completedChildrenByParent.set(workspace.parentWorkspaceId, completedChildren);
  }

  const metadataByWorkspaceId = new Map<string, AgentRowRenderMeta>();

  for (const workspace of visibleRows) {
    const rowKind = workspace.parentWorkspaceId ? "subagent" : "primary";

    let connectorPosition: AgentRowRenderMeta["connectorPosition"] = "single";
    let connectorStartsAtParent = false;
    let sharedTrunkActiveThroughRow = false;
    let sharedTrunkActiveBelowRow = false;
    let ancestorTrunks: AgentRowRenderMeta["ancestorTrunks"] = [];

    if (workspace.parentWorkspaceId) {
      const siblings = visibleChildrenByParent.get(workspace.parentWorkspaceId) ?? [];
      const siblingIndex = siblings.findIndex((sibling) => sibling.id === workspace.id);
      if (siblings.length > 1) {
        connectorPosition = siblings[siblings.length - 1]?.id === workspace.id ? "last" : "middle";
      }

      if (siblingIndex >= 0) {
        connectorStartsAtParent = siblingIndex === 0;

        let lastRunningSiblingIndex = -1;
        for (let index = siblings.length - 1; index >= 0; index -= 1) {
          if (siblings[index]?.taskStatus === "running") {
            lastRunningSiblingIndex = index;
            break;
          }
        }

        // Animate one shared trunk from the parent down through the lowest
        // running child, even when intermediate children are not running.
        if (lastRunningSiblingIndex >= 0) {
          sharedTrunkActiveThroughRow = siblingIndex <= lastRunningSiblingIndex;
          sharedTrunkActiveBelowRow = siblingIndex < lastRunningSiblingIndex;
        }
      }

      const continuingAncestorTrunks: Array<{ depth: number; active: boolean }> = [];
      const visitedAncestorIds = new Set<string>();
      let ancestorId: string | undefined = workspace.parentWorkspaceId;
      while (ancestorId && !visitedAncestorIds.has(ancestorId)) {
        visitedAncestorIds.add(ancestorId);

        const ancestorMeta = metadataByWorkspaceId.get(ancestorId);
        const ancestorDepth = depthByWorkspaceId[ancestorId] ?? 0;
        if (ancestorDepth > 0 && ancestorMeta?.connectorPosition === "middle") {
          continuingAncestorTrunks.push({
            depth: ancestorDepth,
            active: ancestorMeta.sharedTrunkActiveBelowRow,
          });
        }

        const ancestorWorkspace = visibleWorkspaceById.get(ancestorId);
        if (!ancestorWorkspace) {
          break;
        }
        ancestorId = ancestorWorkspace.parentWorkspaceId;
      }

      continuingAncestorTrunks.sort((left, right) => left.depth - right.depth);
      ancestorTrunks = continuingAncestorTrunks;
    }

    const completedChildren = completedChildrenByParent.get(workspace.id) ?? [];
    let visibleCompletedChildrenCount = 0;
    for (const child of completedChildren) {
      if (visibleWorkspaceIds.has(child.id)) {
        visibleCompletedChildrenCount += 1;
      }
    }

    metadataByWorkspaceId.set(workspace.id, {
      depth: depthByWorkspaceId[workspace.id] ?? 0,
      rowKind,
      connectorPosition,
      connectorStartsAtParent,
      sharedTrunkActiveThroughRow,
      sharedTrunkActiveBelowRow,
      ancestorTrunks,
      hasHiddenCompletedChildren: visibleCompletedChildrenCount < completedChildren.length,
      visibleCompletedChildrenCount,
    });
  }

  return metadataByWorkspaceId;
}

/**
 * Age thresholds for workspace filtering, in ascending order.
 * Each tier hides workspaces older than the specified duration.
 */
export const AGE_THRESHOLDS_DAYS = [1, 7, 30] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build a map of project paths to sorted workspace metadata lists.
 * Includes both persisted workspaces (from config) and workspaces from
 * metadata that haven't yet appeared in config (handles race condition
 * where metadata event arrives before config refresh completes).
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

  // Second pass: add workspaces from metadata not yet in projects config
  // (handles race condition where metadata event arrives before config refresh completes)
  for (const [id, metadata] of workspaceMetadata) {
    if (!includedIds.has(id)) {
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
interface AgePartitionResult {
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
 *
 * Parent/child hierarchy is preserved across tiers: if a workspace has a parent
 * present in the same list, it inherits the parent's tier. This keeps sub-agent
 * rows colocated with their parent instead of splitting them across recent/old
 * buckets based on each child row's individual recency.
 *
 * Workspaces older than the first threshold remain in old-age tiers, even when
 * that leaves the recent section empty.
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
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace] as const));

  // Tier index: -1 => recent, 0..N-1 => age buckets.
  const tierByWorkspaceId = new Map<string, number>();
  const visiting = new Set<string>();

  const classifyByOwnRecency = (workspace: FrontendWorkspaceMetadata): number => {
    const recencyTimestamp = workspaceRecency[workspace.id] ?? 0;
    const age = now - recencyTimestamp;

    if (age < thresholdMs[0]) {
      return -1;
    }

    for (let i = 0; i < thresholdMs.length - 1; i++) {
      if (age >= thresholdMs[i] && age < thresholdMs[i + 1]) {
        return i;
      }
    }

    return thresholdMs.length - 1;
  };

  const resolveTierIndex = (workspace: FrontendWorkspaceMetadata): number => {
    const cachedTier = tierByWorkspaceId.get(workspace.id);
    if (cachedTier !== undefined) {
      return cachedTier;
    }

    if (visiting.has(workspace.id)) {
      // Defensive cycle handling: fall back to direct age classification.
      const fallbackTier = classifyByOwnRecency(workspace);
      tierByWorkspaceId.set(workspace.id, fallbackTier);
      return fallbackTier;
    }

    visiting.add(workspace.id);

    const parentId = workspace.parentWorkspaceId;
    const parent = parentId ? byId.get(parentId) : undefined;
    const tierIndex = parent ? resolveTierIndex(parent) : classifyByOwnRecency(workspace);

    visiting.delete(workspace.id);
    tierByWorkspaceId.set(workspace.id, tierIndex);
    return tierIndex;
  };

  const recent: FrontendWorkspaceMetadata[] = [];
  const buckets: FrontendWorkspaceMetadata[][] = AGE_THRESHOLDS_DAYS.map(() => []);

  for (const workspace of workspaces) {
    const tierIndex = resolveTierIndex(workspace);
    if (tierIndex === -1) {
      recent.push(workspace);
      continue;
    }

    const safeBucketIndex =
      tierIndex >= 0 && tierIndex < buckets.length ? tierIndex : buckets.length - 1;
    buckets[safeBucketIndex].push(workspace);
  }

  return { recent, buckets };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section-based workspace grouping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of partitioning workspaces by section.
 * - unsectioned: workspaces not assigned to any section
 * - bySectionId: map of section ID to workspaces in that section
 */
interface SectionPartitionResult {
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
