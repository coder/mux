import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { useWorkspaceRecency } from "@/browser/stores/WorkspaceStore";
import { useStableReference, compareMaps } from "@/browser/hooks/useStableReference";
import { sortWithNesting, type WorkspaceWithNesting } from "@/browser/utils/ui/workspaceFiltering";

// Re-export for backward compatibility
export type { WorkspaceWithNesting };

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
