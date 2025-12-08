import { useState, useEffect, useCallback } from "react";
import type { BackgroundProcessInfo } from "@/common/orpc/schemas/api";
import type { APIClient } from "@/browser/contexts/API";

/**
 * Hook to manage background processes for a workspace.
 * Polls the backend periodically to get current process state.
 */
export function useBackgroundProcesses(
  api: APIClient | null,
  workspaceId: string | null,
  pollingIntervalMs = 1000
): {
  processes: BackgroundProcessInfo[];
  terminate: (processId: string) => Promise<void>;
  refresh: () => Promise<void>;
} {
  const [processes, setProcesses] = useState<BackgroundProcessInfo[]>([]);

  const refresh = useCallback(async () => {
    if (!api || !workspaceId) {
      setProcesses([]);
      return;
    }

    try {
      const result = await api.workspace.backgroundBashes.list({ workspaceId });
      setProcesses(result);
    } catch (error) {
      console.error("Failed to fetch background processes:", error);
      // Keep existing state on error
    }
  }, [api, workspaceId]);

  const terminate = useCallback(
    async (processId: string) => {
      if (!api || !workspaceId) return;

      try {
        const result = await api.workspace.backgroundBashes.terminate({
          workspaceId,
          processId,
        });
        if (!result.success) {
          console.error("Failed to terminate process:", result.error);
        }
        // Refresh list after termination
        await refresh();
      } catch (error) {
        console.error("Failed to terminate process:", error);
      }
    },
    [api, workspaceId, refresh]
  );

  // Initial fetch and polling
  useEffect(() => {
    if (!api || !workspaceId) {
      setProcesses([]);
      return;
    }

    // Initial fetch
    void refresh();

    // Poll periodically
    const interval = setInterval(() => {
      void refresh();
    }, pollingIntervalMs);

    return () => clearInterval(interval);
  }, [api, workspaceId, pollingIntervalMs, refresh]);

  return { processes, terminate, refresh };
}
