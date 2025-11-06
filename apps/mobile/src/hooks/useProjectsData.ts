import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "./useApiClient";
import type { FrontendWorkspaceMetadata } from "../types";

const WORKSPACES_QUERY_KEY = ["workspaces"] as const;
const PROJECTS_QUERY_KEY = ["projects"] as const;

export function useProjectsData() {
  const api = useApiClient();
  const queryClient = useQueryClient();

  const projectsQuery = useQuery({
    queryKey: PROJECTS_QUERY_KEY,
    queryFn: () => api.projects.list(),
    staleTime: 60_000,
  });

  const workspacesQuery = useQuery({
    queryKey: WORKSPACES_QUERY_KEY,
    queryFn: () => api.workspace.list(),
    staleTime: 15_000,
  });

  useEffect(() => {
    const subscription = api.workspace.subscribeMetadata(({ workspaceId, metadata }) => {
      queryClient.setQueryData<FrontendWorkspaceMetadata[] | undefined>(
        WORKSPACES_QUERY_KEY,
        (existing) => {
          if (!existing || existing.length === 0) {
            return existing;
          }

          // Handle deletion (null metadata)
          if (metadata === null) {
            return existing.filter((w) => w.id !== workspaceId);
          }

          // Handle update/rename
          const index = existing.findIndex((workspace) => workspace.id === workspaceId);
          if (index === -1) {
            // New workspace - add it
            return [...existing, metadata];
          }

          const next = existing.slice();
          next[index] = { ...next[index], ...metadata };
          return next;
        }
      );
    });

    return () => {
      subscription.close();
    };
  }, [api, queryClient]);

  return {
    api,
    projectsQuery,
    workspacesQuery,
  };
}
