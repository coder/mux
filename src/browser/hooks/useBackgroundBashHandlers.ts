import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { BackgroundProcessInfo } from "@/common/orpc/schemas/api";
import type { APIClient } from "@/browser/contexts/API";
import { usePopoverError } from "@/browser/hooks/usePopoverError";

/** Shared empty arrays/sets to avoid creating new objects */
const EMPTY_SET = new Set<string>();
const EMPTY_PROCESSES: BackgroundProcessInfo[] = [];

/**
 * Hook to manage background bash processes and foreground-to-background transitions.
 *
 * Extracted from AIView to keep component size manageable. Encapsulates:
 * - Subscribing to background process state changes (event-driven, no polling)
 * - Terminating background processes
 * - Detecting foreground bashes (by toolCallId) - supports multiple parallel processes
 * - Sending foreground bash to background
 * - Auto-backgrounding when new messages are sent
 */
export function useBackgroundBashHandlers(
  api: APIClient | null,
  workspaceId: string | null
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
      // State will update via subscription
    },
    [api, workspaceId]
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
      // State will update via subscription
    },
    [api, workspaceId]
  );

  // Subscribe to background bash state changes
  useEffect(() => {
    if (!api || !workspaceId) {
      setProcesses(EMPTY_PROCESSES);
      setForegroundToolCallIds(EMPTY_SET);
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;

    (async () => {
      try {
        const iterator = await api.workspace.backgroundBashes.subscribe(
          { workspaceId },
          { signal }
        );

        for await (const state of iterator) {
          if (signal.aborted) break;

          setProcesses(state.processes);
          setForegroundToolCallIds(new Set(state.foregroundToolCallIds));
        }
      } catch (err) {
        if (!signal.aborted) {
          console.error("Failed to subscribe to background bash state:", err);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [api, workspaceId]);

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
