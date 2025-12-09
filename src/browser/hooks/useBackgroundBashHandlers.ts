import { useState, useEffect, useCallback, useMemo } from "react";
import type { BackgroundProcessInfo } from "@/common/orpc/schemas/api";
import type { APIClient } from "@/browser/contexts/API";
import { usePopoverError } from "@/browser/hooks/usePopoverError";

/**
 * Hook to manage background bash processes and foreground-to-background transitions.
 *
 * Extracted from AIView to keep component size manageable. Encapsulates:
 * - Polling for background processes
 * - Terminating background processes
 * - Detecting foreground bash (by toolCallId)
 * - Sending foreground bash to background
 * - Auto-backgrounding when new messages are sent
 */
export function useBackgroundBashHandlers(
  api: APIClient | null,
  workspaceId: string | null,
  pollingIntervalMs = 1000
): {
  /** List of background processes */
  processes: BackgroundProcessInfo[];
  /** Terminate a background process */
  handleTerminate: (processId: string) => void;
  /** Tool call ID of the foreground bash (null if none) */
  foregroundToolCallId: string | null;
  /** Send the foreground bash to background */
  handleSendToBackground: () => void;
  /** Handler to call when a message is sent (auto-backgrounds any foreground bash) */
  handleMessageSentBackground: () => void;
  /** Error state for popover display */
  error: ReturnType<typeof usePopoverError>;
} {
  const [processes, setProcesses] = useState<BackgroundProcessInfo[]>([]);
  const [foregroundToolCallId, setForegroundToolCallId] = useState<string | null>(null);
  const error = usePopoverError();

  const refresh = useCallback(async () => {
    if (!api || !workspaceId) {
      setProcesses([]);
      setForegroundToolCallId(null);
      return;
    }

    try {
      const [processList, fgToolCallId] = await Promise.all([
        api.workspace.backgroundBashes.list({ workspaceId }),
        api.workspace.backgroundBashes.getForegroundToolCallId({ workspaceId }),
      ]);
      setProcesses(processList);
      setForegroundToolCallId(fgToolCallId);
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
    // Refresh to update foreground state
    await refresh();
  }, [api, workspaceId, refresh]);

  // Initial fetch and polling
  useEffect(() => {
    if (!api || !workspaceId) {
      setProcesses([]);
      setForegroundToolCallId(null);
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

  // Wrapped handlers with error handling
  const handleTerminate = useCallback(
    (processId: string) => {
      terminate(processId).catch((err: Error) => {
        error.showError(processId, err.message);
      });
    },
    [terminate, error]
  );

  const handleSendToBackground = useCallback(() => {
    sendToBackground().catch((err: Error) => {
      error.showError("send-to-background", err.message);
    });
  }, [sendToBackground, error]);

  // Handler for when a message is sent - auto-background any foreground bash
  const handleMessageSentBackground = useCallback(() => {
    if (foregroundToolCallId) {
      sendToBackground().catch(() => {
        // Ignore errors - the bash might have finished just before we tried to background it
      });
    }
  }, [foregroundToolCallId, sendToBackground]);

  return useMemo(
    () => ({
      processes,
      handleTerminate,
      foregroundToolCallId,
      handleSendToBackground,
      handleMessageSentBackground,
      error,
    }),
    [
      processes,
      handleTerminate,
      foregroundToolCallId,
      handleSendToBackground,
      handleMessageSentBackground,
      error,
    ]
  );
}
