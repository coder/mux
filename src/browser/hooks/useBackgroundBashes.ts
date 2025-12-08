import { useState, useEffect, useCallback } from "react";
import type { BackgroundProcessInfo } from "@/common/orpc/schemas/api";
import type { APIClient } from "@/browser/contexts/API";

/**
 * Hook to manage background bash processes for a workspace.
 * Polls the backend periodically to get current process state.
 */
export function useBackgroundBashes(
  api: APIClient | null,
  workspaceId: string | null,
  pollingIntervalMs = 1000
): {
  processes: BackgroundProcessInfo[];
  terminate: (processId: string) => Promise<void>;
  refresh: () => Promise<void>;
  /** Whether there's a foreground bash process that can be sent to background */
  hasForeground: boolean;
  /** Send the current foreground bash process to background */
  sendToBackground: () => Promise<void>;
} {
  const [processes, setProcesses] = useState<BackgroundProcessInfo[]>([]);
  const [hasForeground, setHasForeground] = useState(false);

  const refresh = useCallback(async () => {
    if (!api || !workspaceId) {
      setProcesses([]);
      setHasForeground(false);
      return;
    }

    try {
      const [result, hasFg] = await Promise.all([
        api.workspace.backgroundBashes.list({ workspaceId }),
        api.workspace.backgroundBashes.hasForeground({ workspaceId }),
      ]);
      setProcesses(result);
      setHasForeground(hasFg);
    } catch {
      // Keep existing state on error - polling will retry
    }
  }, [api, workspaceId]);

  const terminate = useCallback(
    async (processId: string): Promise<void> => {
      if (!api || !workspaceId) {
        throw new Error("API or workspace not available");
      }

      const result = await api.workspace.backgroundBashes.terminate({
        workspaceId,
        processId,
      });
      if (!result.success) {
        throw new Error(result.error);
      }
      // Refresh list after termination
      await refresh();
    },
    [api, workspaceId, refresh]
  );

  const sendToBackground = useCallback(async (): Promise<void> => {
    if (!api || !workspaceId) {
      throw new Error("API or workspace not available");
    }

    const result = await api.workspace.backgroundBashes.sendToBackground({
      workspaceId,
    });
    if (!result.success) {
      throw new Error(result.error);
    }
    // Refresh to update hasForeground state
    await refresh();
  }, [api, workspaceId, refresh]);

  // Initial fetch and polling
  useEffect(() => {
    if (!api || !workspaceId) {
      setProcesses([]);
      setHasForeground(false);
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

  return { processes, terminate, refresh, hasForeground, sendToBackground };
}
