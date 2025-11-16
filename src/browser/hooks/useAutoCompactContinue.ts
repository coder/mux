import { useRef, useEffect } from "react";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { buildSendMessageOptions } from "@/browser/hooks/useSendMessageOptions";

/**
 * Hook to manage auto-continue after compaction using structured message metadata
 *
 * Approach:
 * - Watches all workspaces for single compacted message (compaction just completed)
 * - Reads continueMessage from the summary message's compaction-result metadata
 * - Sends continue message automatically
 *
 * Why summary metadata? When compaction completes, history is replaced with just the
 * summary message. The original compaction-request message is deleted. To preserve
 * the continueMessage across this replacement, we extract it before replacement and
 * store it in the summary's metadata.
 *
 * Self-contained: No callback needed. Hook detects condition and handles action.
 * No localStorage - metadata is the single source of truth.
 *
 * IMPORTANT: sendMessage options (model, thinking level, mode, etc.) are managed by the
 * frontend via buildSendMessageOptions. The backend does NOT fall back to workspace
 * metadata - frontend must pass complete options.
 */
export function useAutoCompactContinue() {
  // Get workspace states from store
  // NOTE: We use a ref-based approach instead of useSyncExternalStore to avoid
  // re-rendering AppInner on every workspace state change. This hook only needs
  // to react when messages change to a single compacted message state.
  const store = useWorkspaceStoreRaw();
  // Track which specific compaction summary messages we've already processed.
  // Key insight: Each compaction creates a unique message. Track by message ID,
  // not workspace ID, to prevent processing the same compaction result multiple times.
  // This is obviously correct because message IDs are immutable and unique.
  const processedMessageIds = useRef<Set<string>>(new Set());

  // Update ref and check for auto-continue condition
  const checkAutoCompact = () => {
    const newStates = store.getAllStates();

    // Check all workspaces for completed compaction
    for (const [workspaceId, state] of newStates) {
      // Detect if workspace is in "single compacted message" state
      // Skip workspace-init messages since they're UI-only metadata
      const cmuxMessages = state.messages.filter((m) => m.type !== "workspace-init");
      const isSingleCompacted =
        cmuxMessages.length === 1 &&
        cmuxMessages[0]?.type === "assistant" &&
        cmuxMessages[0].isCompacted === true;

      if (!isSingleCompacted) {
        // Workspace no longer in compacted state - no action needed
        // Processed message IDs will naturally accumulate but stay bounded
        // (one per compaction), and get cleared when user sends new messages
        continue;
      }

      // After compaction, history is replaced with a single summary message
      // The summary message has compaction-result metadata with the continueMessage
      const summaryMessage = state.cmuxMessages[0]; // Single compacted message
      const cmuxMeta = summaryMessage?.metadata?.cmuxMetadata;
      const continueMessage =
        cmuxMeta?.type === "compaction-result" ? cmuxMeta.continueMessage : undefined;

      if (!continueMessage) continue;

      // Prefer compaction-request ID for idempotency; fall back to summary message ID
      const idForGuard =
        cmuxMeta?.type === "compaction-result" && cmuxMeta.requestId
          ? `req:${cmuxMeta.requestId}`
          : `msg:${summaryMessage.id}`;

      // Have we already processed this specific compaction result?
      if (processedMessageIds.current.has(idForGuard)) continue;

      // Mark THIS RESULT as processed before sending to prevent duplicates
      processedMessageIds.current.add(idForGuard);

      // Build options and send message directly
      const options = buildSendMessageOptions(workspaceId);
      void (async () => {
        try {
          const result = await window.api.workspace.sendMessage(
            workspaceId,
            continueMessage,
            options
          );
          // Check if send failed (browser API returns error object, not throw)
          if (!result.success && "error" in result) {
            console.error("Failed to send continue message:", result.error);
            // If sending failed, remove from processed set to allow retry
            processedMessageIds.current.delete(idForGuard);
          }
        } catch (error) {
          // Handle network/parsing errors (HTTP errors, etc.)
          console.error("Failed to send continue message:", error);
          processedMessageIds.current.delete(idForGuard);
        }
      })();
    }
  };

  useEffect(() => {
    // Initial check
    checkAutoCompact();

    // Subscribe to store changes and check condition
    // This doesn't trigger React re-renders, just our internal check
    const unsubscribe = store.subscribe(() => {
      checkAutoCompact();
    });

    return unsubscribe;
  }, [store]); // eslint-disable-line react-hooks/exhaustive-deps
}
