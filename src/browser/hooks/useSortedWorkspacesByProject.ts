import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { useWorkspaceRecency } from "@/browser/stores/WorkspaceStore";
import { useStableReference, compareMaps } from "@/browser/hooks/useStableReference";

/** Workspace metadata extended with computed nesting depth */
export interface WorkspaceWithNesting extends FrontendWorkspaceMetadata {
  /** Nesting depth (0 = top-level, 1 = direct child, etc.) */
  nestingDepth: number;
}

/**
 * Sort workspaces so children appear immediately after their parent.
 * Maintains recency order within each level.
 */
function sortWithNesting(
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

export function useSortedWorkspacesByProject() {
  const { projects } = useProjectContext();
  const { workspaceMetadata } = useWorkspaceContext();
  const workspaceRecency = useWorkspaceRecency();

  return useStableReference(
    () => {
      const result = new Map<string, WorkspaceWithNesting[]>();
      for (const [projectPath, config] of projects) {
        const metadataList = config.workspaces
          .map((ws) => (ws.id ? workspaceMetadata.get(ws.id) : undefined))
          .filter((meta): meta is FrontendWorkspaceMetadata => Boolean(meta));

        // Sort with nesting: parents first, children indented below
        const sorted = sortWithNesting(metadataList, workspaceRecency);

        result.set(projectPath, sorted);
      }
      return result;
    },
    (prev, next) =>
      compareMaps(prev, next, (a, b) => {
        if (a.length !== b.length) {
          return false;
        }
        return a.every((metadata, index) => {
          const other = b[index];
          if (!other) {
            return false;
          }
          return (
            metadata.id === other.id &&
            metadata.name === other.name &&
            metadata.nestingDepth === other.nestingDepth
          );
        });
      }),
    [projects, workspaceMetadata, workspaceRecency]
  );
}
