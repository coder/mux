import { useEffect } from "react";
import type { ChatInputAPI } from "@/browser/components/ChatInput";
import {
  matchesKeybind,
  KEYBINDS,
  isEditableElement,
  isTerminalFocused,
} from "@/browser/utils/ui/keybinds";
import type { StreamingMessageAggregator } from "@/browser/utils/messages/StreamingMessageAggregator";
import { isCompactingStream, cancelCompaction } from "@/browser/utils/compaction/handler";
import { useAPI } from "@/browser/contexts/API";
import { disableAutoRetryPreference } from "@/browser/utils/messages/autoRetryPreference";

interface UseAIViewKeybindsParams {
  workspaceId: string;
  canInterrupt: boolean;
  showRetryBarrier: boolean;
  chatInputAPI: React.RefObject<ChatInputAPI | null>;
  jumpToBottom: () => void;
  handleOpenTerminal: () => void;
  handleOpenInEditor: () => void;
  aggregator: StreamingMessageAggregator | undefined; // For compaction detection
  setEditingMessage: (editing: { id: string; content: string } | undefined) => void;
  vimEnabled: boolean; // For vim-aware interrupt keybind
}

/**
 * Manages keyboard shortcuts for AIView:
 * - Esc (non-vim) or Ctrl+C (vim): Interrupt stream (always, regardless of selection)
 * - Ctrl+I: Focus chat input
 * - Ctrl+G: Jump to bottom
 * - Ctrl+T: Open terminal
 * - Ctrl+Shift+E: Open in editor
 * - Ctrl+C (during compaction in vim mode): Cancel compaction, restore command
 *
 * Note: In vim mode, Ctrl+C always interrupts streams. Use vim yank (y) commands for copying.
 */
export function useAIViewKeybinds({
  workspaceId,
  canInterrupt,
  showRetryBarrier,
  chatInputAPI,
  jumpToBottom,
  handleOpenTerminal,
  handleOpenInEditor,
  aggregator,
  setEditingMessage,
  vimEnabled,
}: UseAIViewKeybindsParams): void {
  const { api } = useAPI();

  useEffect(() => {
    const handleInterruptKeyDown = (e: KeyboardEvent) => {
      // Check vim-aware interrupt keybind
      const interruptKeybind = vimEnabled
        ? KEYBINDS.INTERRUPT_STREAM_VIM
        : KEYBINDS.INTERRUPT_STREAM_NORMAL;

      // Interrupt stream: Ctrl+C in vim mode, Esc in normal mode
      // Skip if terminal is focused - let terminal handle Ctrl+C (sends SIGINT to process)
      //
      // IMPORTANT: This handler runs in **bubble phase** so dialogs/popovers can stopPropagation()
      // on Escape without accidentally interrupting a stream.
      if (matchesKeybind(e, interruptKeybind) && !isTerminalFocused(e.target)) {
        // ask_user_question is a special waiting state: don't interrupt it with Esc/Ctrl+C.
        // Users can still respond via the questions UI, or type in chat to cancel.
        if (aggregator?.hasAwaitingUserQuestion()) {
          return;
        }

        if (canInterrupt && aggregator && isCompactingStream(aggregator)) {
          // Ctrl+C during compaction: restore original state and enter edit mode
          // Stores cancellation marker in localStorage (persists across reloads)
          e.preventDefault();
          if (api) {
            void cancelCompaction(api, workspaceId, aggregator, (messageId, command) => {
              setEditingMessage({ id: messageId, content: command });
            });
          }
          disableAutoRetryPreference(workspaceId);
          return;
        }

        // Normal stream interrupt (non-compaction)
        // Vim mode: Ctrl+C always interrupts (vim uses yank for copy, not Ctrl+C)
        // Non-vim mode: Esc always interrupts
        if (canInterrupt || showRetryBarrier) {
          e.preventDefault();
          disableAutoRetryPreference(workspaceId); // User explicitly stopped - don't auto-retry
          void api?.workspace.interruptStream({ workspaceId });
          return;
        }
      }
    };

    const handleKeyDownCapture = (e: KeyboardEvent) => {
      // Focus chat input works anywhere (even in input fields)
      if (matchesKeybind(e, KEYBINDS.FOCUS_CHAT)) {
        e.preventDefault();
        chatInputAPI.current?.focus();
        return;
      }

      // Open in editor / terminal - work even in input fields (global feel, like TOGGLE_AGENT)
      if (matchesKeybind(e, KEYBINDS.OPEN_IN_EDITOR)) {
        e.preventDefault();
        handleOpenInEditor();
        return;
      }
      if (matchesKeybind(e, KEYBINDS.OPEN_TERMINAL)) {
        e.preventDefault();
        handleOpenTerminal();
        return;
      }

      // Don't handle other shortcuts if user is typing in an input field
      if (isEditableElement(e.target)) {
        return;
      }

      if (matchesKeybind(e, KEYBINDS.JUMP_TO_BOTTOM)) {
        e.preventDefault();
        jumpToBottom();
      }
    };

    // Use capture phase for non-destructive keybinds so they work even when terminal is focused
    // (terminal components may consume events in bubble phase).
    window.addEventListener("keydown", handleKeyDownCapture, { capture: true });

    // Interrupt keybind is handled separately in bubble phase (see comment above).
    window.addEventListener("keydown", handleInterruptKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDownCapture, { capture: true });
      window.removeEventListener("keydown", handleInterruptKeyDown);
    };
  }, [
    jumpToBottom,
    handleOpenTerminal,
    handleOpenInEditor,
    workspaceId,
    canInterrupt,
    showRetryBarrier,
    chatInputAPI,
    aggregator,
    setEditingMessage,
    vimEnabled,
    api,
  ]);
}
