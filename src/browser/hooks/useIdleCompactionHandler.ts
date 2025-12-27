/**
 * Hook to handle idle compaction events from the backend.
 *
 * The backend's IdleCompactionService detects when workspaces have been idle
 * for a configured period and emits `idle-compaction-needed` events to the stream.
 *
 * This hook listens for these signals and triggers compaction via the control-plane
 * compactHistory endpoint, which ensures the compaction cannot be dropped or queued.
 */

import { useEffect, useRef } from "react";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import { buildSendMessageOptions } from "@/browser/hooks/useSendMessageOptions";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";

export interface IdleCompactionHandlerParams {
  api: RouterClient<AppRouter> | null;
}

/**
 * Hook to automatically trigger idle compaction when the backend signals it's needed.
 * Should be called at a high level (e.g., App or AIView) to handle all workspaces.
 */
export function useIdleCompactionHandler(params: IdleCompactionHandlerParams): void {
  const { api } = params;

  // Track which workspaces we've triggered compaction for (to prevent duplicates)
  const triggeredWorkspacesRef = useRef(new Set<string>());

  useEffect(() => {
    if (!api) return;

    const handleIdleCompactionNeeded = (workspaceId: string) => {
      // Skip if already triggered for this workspace
      if (triggeredWorkspacesRef.current.has(workspaceId)) {
        return;
      }

      triggeredWorkspacesRef.current.add(workspaceId);

      // Use buildSendMessageOptions to get correct model, gateway, thinking level, etc.
      const sendMessageOptions = buildSendMessageOptions(workspaceId);

      // Use control-plane compactHistory endpoint for reliability
      void api.workspace
        .compactHistory({
          workspaceId,
          source: "idle-compaction",
          sendMessageOptions: {
            model: sendMessageOptions.model,
            thinkingLevel: sendMessageOptions.thinkingLevel,
            providerOptions: sendMessageOptions.providerOptions,
            experiments: sendMessageOptions.experiments,
          },
        })
        .then((result) => {
          if (!result.success) {
            console.error("Idle compaction failed:", result.error);
          }
        })
        .catch((error) => {
          console.error("Idle compaction error:", error);
        })
        .finally(() => {
          // Always clear from triggered set after completion (success or failure).
          // This allows the workspace to be re-triggered on subsequent hourly checks
          // if it becomes idle again. Backend eligibility checks (already_compacted,
          // currently_streaming) provide authoritative deduplication.
          triggeredWorkspacesRef.current.delete(workspaceId);
        });
    };

    const unsubscribe = workspaceStore.onIdleCompactionNeeded(handleIdleCompactionNeeded);
    return unsubscribe;
  }, [api]);
}
