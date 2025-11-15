import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "./useApiClient";
import type { FrontendWorkspaceMetadata, WorkspaceActivitySnapshot } from "../types";

const WORKSPACES_QUERY_KEY = ["workspaces"] as const;
const WORKSPACE_ACTIVITY_QUERY_KEY = ["workspace-activity"] as const;
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
  const activityQuery = useQuery({
    queryKey: WORKSPACE_ACTIVITY_QUERY_KEY,
    queryFn: () => api.workspace.activity.list(),
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

          if (metadata === null) {
            return existing.filter((w) => w.id !== workspaceId);
          }

          const index = existing.findIndex((workspace) => workspace.id === workspaceId);
          if (index === -1) {
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

  useEffect(() => {
    const subscription = api.workspace.activity.subscribe(({ workspaceId, activity }) => {
      queryClient.setQueryData<Record<string, WorkspaceActivitySnapshot> | undefined>(
        WORKSPACE_ACTIVITY_QUERY_KEY,
        (existing) => {
          const current = existing ?? {};
          if (activity === null) {
            if (!current[workspaceId]) {
              return existing;
            }
            const next = { ...current };
            delete next[workspaceId];
            return next;
          }
          return { ...current, [workspaceId]: activity };
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
    activityQuery,
  };
}
