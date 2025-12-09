import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useORPC } from "../orpc/react";
import type { FrontendWorkspaceMetadata, WorkspaceActivitySnapshot } from "../types";

const WORKSPACES_QUERY_KEY = ["workspaces"] as const;
const WORKSPACE_ACTIVITY_QUERY_KEY = ["workspace-activity"] as const;
const PROJECTS_QUERY_KEY = ["projects"] as const;

export function useProjectsData() {
  const client = useORPC();
  const queryClient = useQueryClient();

  const projectsQuery = useQuery({
    queryKey: PROJECTS_QUERY_KEY,
    queryFn: () => client.projects.list(),
    staleTime: 60_000,
  });

  const workspacesQuery = useQuery({
    queryKey: WORKSPACES_QUERY_KEY,
    queryFn: () => client.workspace.list(),
    staleTime: 15_000,
  });

  const activityQuery = useQuery({
    queryKey: WORKSPACE_ACTIVITY_QUERY_KEY,
    queryFn: () => client.workspace.activity.list(),
    staleTime: 15_000,
  });

  // Subscribe to workspace metadata changes via SSE
  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      try {
        const iterator = await client.workspace.onMetadata(undefined, {
          signal: controller.signal,
        });
        for await (const event of iterator) {
          if (controller.signal.aborted) break;

          const { workspaceId, metadata } = event;
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
                return [...existing, metadata as FrontendWorkspaceMetadata];
              }

              const next = existing.slice();
              next[index] = { ...next[index], ...metadata };
              return next;
            }
          );
        }
      } catch (error) {
        // Stream ended or aborted - this is expected on cleanup
        if (!controller.signal.aborted && process.env.NODE_ENV !== "production") {
          console.warn("[useProjectsData] Metadata stream error:", error);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [client, queryClient]);

  // Subscribe to workspace activity changes via SSE
  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      try {
        const iterator = await client.workspace.activity.subscribe(undefined, {
          signal: controller.signal,
        });
        for await (const event of iterator) {
          if (controller.signal.aborted) break;

          const { workspaceId, activity } = event;
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
        }
      } catch (error) {
        // Stream ended or aborted - this is expected on cleanup
        if (!controller.signal.aborted && process.env.NODE_ENV !== "production") {
          console.warn("[useProjectsData] Activity stream error:", error);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [client, queryClient]);

  return {
    client,
    projectsQuery,
    workspacesQuery,
    activityQuery,
  };
}
