/**
 * Hook to handle idle compaction events from the backend.
 *
 * The backend's IdleCompactionService detects when workspaces have been idle
 * for a configured period and emits `idle-compaction-needed` events to the stream.
 *
 * This hook listens for these signals and triggers compaction via the frontend's
 * executeCompaction(), which handles gateway, model preferences, etc.
 *
 * Status display is handled data-driven: the compaction request message includes
 * displayStatus metadata, which the aggregator reads to set sidebar status.
 * Status is cleared when the summary message with compacted: "idle" arrives.
 *
 * SERIALIZATION: Only one idle compaction runs at a time to avoid thundering herd
 * when the hourly check finds multiple eligible workspaces simultaneously.
 */

import { useEffect, useRef } from "react";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import {
  executeCompaction as executeCompactionDefault,
  type CompactionResult,
} from "@/browser/utils/chatCommands";
import { buildSendMessageOptions } from "@/browser/hooks/useSendMessageOptions";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";

// Type for executeCompaction function (for testing injection)
type ExecuteCompactionFn = (opts: {
  api: RouterClient<AppRouter>;
  workspaceId: string;
  sendMessageOptions: ReturnType<typeof buildSendMessageOptions>;
  source: string;
}) => Promise<CompactionResult>;

export interface IdleCompactionHandlerParams {
  api: RouterClient<AppRouter> | null;
  /** @internal For testing only - inject a mock executeCompaction */
  _executeCompaction?: ExecuteCompactionFn;
}

/**
 * Hook to automatically trigger idle compaction when the backend signals it's needed.
 * Should be called at a high level (e.g., App or AIView) to handle all workspaces.
 *
 * Compactions are serialized: only one runs at a time, with others queued.
 */
export function useIdleCompactionHandler(params: IdleCompactionHandlerParams): void {
  const { api, _executeCompaction = executeCompactionDefault } = params;

  // Track which workspaces we've triggered compaction for (to prevent duplicates)
  const triggeredWorkspacesRef = useRef(new Set<string>());
  // Queue of workspaces waiting for compaction (serialization)
  const queueRef = useRef<string[]>([]);
  // Whether a compaction is currently in progress
  const isRunningRef = useRef(false);

  useEffect(() => {
    if (!api) return;

    const processNextInQueue = () => {
      // If already running or queue is empty, nothing to do
      if (isRunningRef.current || queueRef.current.length === 0) {
        return;
      }

      const workspaceId = queueRef.current.shift()!;
      isRunningRef.current = true;

      // Use buildSendMessageOptions to get correct model, gateway, thinking level, etc.
      const sendMessageOptions = buildSendMessageOptions(workspaceId);

      const cleanup = () => {
        // Always clear from triggered set after completion (success, failure, or rejection).
        // This allows the workspace to be re-triggered on subsequent hourly checks
        // if it becomes idle again. Backend eligibility checks (already_compacted,
        // currently_streaming) provide authoritative deduplication.
        triggeredWorkspacesRef.current.delete(workspaceId);
        isRunningRef.current = false;
        // Process next queued workspace
        processNextInQueue();
      };

      // Status is handled data-driven via displayStatus in the message metadata
      _executeCompaction({
        api,
        workspaceId,
        sendMessageOptions,
        source: "idle-compaction",
      })
        .then((result) => {
          if (!result.success) {
            console.error("Idle compaction failed:", result.error);
          }
        })
        .catch((error) => {
          console.error("Idle compaction threw:", error);
        })
        .finally(cleanup);
    };

    const handleIdleCompactionNeeded = (workspaceId: string) => {
      // Skip if already triggered for this workspace
      if (triggeredWorkspacesRef.current.has(workspaceId)) {
        return;
      }

      triggeredWorkspacesRef.current.add(workspaceId);
      queueRef.current.push(workspaceId);

      // Try to process (will only run if nothing is in progress)
      processNextInQueue();
    };

    const unsubscribe = workspaceStore.onIdleCompactionNeeded(handleIdleCompactionNeeded);
    return unsubscribe;
  }, [api, _executeCompaction]);
}
