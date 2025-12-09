import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { BackgroundProcessInfo } from "@/common/orpc/schemas/api";
import type { APIClient } from "@/browser/contexts/API";
import { usePopoverError } from "@/browser/hooks/usePopoverError";
import { compareArrays } from "@/browser/hooks/useStableReference";

/** Compare sets by contents */
function compareSets<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

/** Compare process lists by id and status */
function compareProcesses(a: BackgroundProcessInfo, b: BackgroundProcessInfo): boolean {
  return a.id === b.id && a.status === b.status;
}

/** Shared empty arrays/sets to avoid creating new objects */
const EMPTY_SET = new Set<string>();
const EMPTY_PROCESSES: BackgroundProcessInfo[] = [];

/**
 * Hook to manage background bash processes and foreground-to-background transitions.
 *
 * Extracted from AIView to keep component size manageable. Encapsulates:
 * - Polling for background processes
 * - Terminating background processes
 * - Detecting foreground bashes (by toolCallId) - supports multiple parallel processes
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
  /** Set of tool call IDs of foreground bashes */
  foregroundToolCallIds: Set<string>;
  /** Send a specific foreground bash to background */
  handleSendToBackground: (toolCallId: string) => void;
  /** Handler to call when a message is sent (auto-backgrounds all foreground bashes) */
  handleMessageSentBackground: () => void;
  /** Error state for popover display */
  error: ReturnType<typeof usePopoverError>;
} {
  const [processes, setProcesses] = useState<BackgroundProcessInfo[]>(EMPTY_PROCESSES);
  const [foregroundToolCallIds, setForegroundToolCallIds] = useState<Set<string>>(EMPTY_SET);
  // Keep a ref for handleMessageSentBackground to avoid recreating on every change
  const foregroundIdsRef = useRef<Set<string>>(EMPTY_SET);
  const error = usePopoverError();

  // Update ref when state changes (in effect to avoid running during render)
  useEffect(() => {
    foregroundIdsRef.current = foregroundToolCallIds;
  }, [foregroundToolCallIds]);

  const refresh = useCallback(async () => {
    if (!api || !workspaceId) {
      setProcesses(EMPTY_PROCESSES);
      setForegroundToolCallIds(EMPTY_SET);
      return;
    }

    try {
      const [processList, fgToolCallIds] = await Promise.all([
        api.workspace.backgroundBashes.list({ workspaceId }),
        api.workspace.backgroundBashes.getForegroundToolCallIds({ workspaceId }),
      ]);
      // Only update if contents changed to avoid unnecessary re-renders
      setProcesses((prev) =>
        compareArrays(prev, processList, compareProcesses) ? prev : processList
      );
      const newSet = new Set(fgToolCallIds);
      setForegroundToolCallIds((prev) => (compareSets(prev, newSet) ? prev : newSet));
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

  const sendToBackground = useCallback(
    async (toolCallId: string): Promise<void> => {
      if (!api || !workspaceId) {
        throw new Error("API or workspace not available");
      }

      const result = await api.workspace.backgroundBashes.sendToBackground({
        workspaceId,
        toolCallId,
      });
      if (!result.success) {
        throw new Error(result.error);
      }
      // Refresh to update foreground state
      await refresh();
    },
    [api, workspaceId, refresh]
  );

  // Initial fetch and polling
  useEffect(() => {
    if (!api || !workspaceId) {
      setProcesses(EMPTY_PROCESSES);
      setForegroundToolCallIds(EMPTY_SET);
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
  // Use error.showError directly in deps to avoid recreating when error.error changes
  const { showError } = error;
  const handleTerminate = useCallback(
    (processId: string) => {
      terminate(processId).catch((err: Error) => {
        showError(processId, err.message);
      });
    },
    [terminate, showError]
  );

  const handleSendToBackground = useCallback(
    (toolCallId: string) => {
      sendToBackground(toolCallId).catch((err: Error) => {
        showError(`send-to-background-${toolCallId}`, err.message);
      });
    },
    [sendToBackground, showError]
  );

  // Handler for when a message is sent - auto-background all foreground bashes
  const handleMessageSentBackground = useCallback(() => {
    for (const toolCallId of foregroundIdsRef.current) {
      sendToBackground(toolCallId).catch(() => {
        // Ignore errors - the bash might have finished just before we tried to background it
      });
    }
  }, [sendToBackground]);

  return useMemo(
    () => ({
      processes,
      handleTerminate,
      foregroundToolCallIds,
      handleSendToBackground,
      handleMessageSentBackground,
      error,
    }),
    [
      processes,
      handleTerminate,
      foregroundToolCallIds,
      handleSendToBackground,
      handleMessageSentBackground,
      error,
    ]
  );
}
