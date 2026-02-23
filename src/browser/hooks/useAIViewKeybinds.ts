import { useEffect } from "react";
import type { ChatInputAPI } from "@/browser/components/ChatInput";
import {
  allowsEscapeToInterruptStream,
  matchesKeybind,
  KEYBINDS,
  isEditableElement,
  isTerminalFocused,
  isDialogOpen,
} from "@/browser/utils/ui/keybinds";
import type { StreamingMessageAggregator } from "@/browser/utils/messages/StreamingMessageAggregator";
import { isCompactingStream, cancelCompaction } from "@/browser/utils/compaction/handler";
import { useAPI } from "@/browser/contexts/API";
import type { EditingMessageState } from "@/browser/utils/chatEditing";

interface UseAIViewKeybindsParams {
  workspaceId: string;
  canInterrupt: boolean;
  showRetryBarrier: boolean;
  chatInputAPI: React.RefObject<ChatInputAPI | null>;
  jumpToBottom: () => void;
  loadOlderHistory: (() => void) | null;
  handleOpenTerminal: () => void;
  handleOpenInEditor: () => void;
  aggregator: StreamingMessageAggregator | undefined; // For compaction detection
  setEditingMessage: (editing: EditingMessageState | undefined) => void;
  vimEnabled: boolean; // For vim-aware interrupt keybind
}

/**
 * Manages keyboard shortcuts for AIView:
 * - Esc (non-vim) or Ctrl+C (vim): Interrupt stream (Escape skips text inputs by default)
 * - Ctrl+I: Focus chat input
 * - Shift+H: Load older transcript messages (when available)
 * - Shift+G: Jump to bottom
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
  loadOlderHistory,
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
        // If something else already claimed this key event, skip.
        if (e.defaultPrevented) {
          return;
        }

        // Normal mode uses Escape; skip when typing in inputs unless explicitly opted in.
        if (
          interruptKeybind === KEYBINDS.INTERRUPT_STREAM_NORMAL &&
          isEditableElement(e.target) &&
          !allowsEscapeToInterruptStream(e.target)
        ) {
          return;
        }

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
            void cancelCompaction(api, workspaceId, aggregator, setEditingMessage);
          }
          void api?.workspace.setAutoRetryEnabled?.({ workspaceId, enabled: false });
          return;
        }

        // Normal stream interrupt (non-compaction)
        // Vim mode: Ctrl+C always interrupts (vim uses yank for copy, not Ctrl+C)
        // Non-vim mode: Esc interrupts (except when typing in inputs, unless explicitly opted in)
        if (canInterrupt || showRetryBarrier) {
          e.preventDefault();
          void api?.workspace.setAutoRetryEnabled?.({ workspaceId, enabled: false });
          void api?.workspace.interruptStream({ workspaceId });
          return;
        }
      }
    };

    const handleKeyDownCapture = (e: KeyboardEvent) => {
      const dialogOpen = isDialogOpen();

      // Focus chat input works anywhere (even in input fields)
      if (matchesKeybind(e, KEYBINDS.FOCUS_CHAT)) {
        e.preventDefault();
        if (!dialogOpen) chatInputAPI.current?.focus();
        return;
      }

      // Open in editor / terminal - work even in input fields (global feel, like TOGGLE_AGENT)
      if (matchesKeybind(e, KEYBINDS.OPEN_IN_EDITOR)) {
        e.preventDefault();
        if (!dialogOpen) handleOpenInEditor();
        return;
      }
      if (matchesKeybind(e, KEYBINDS.OPEN_TERMINAL)) {
        e.preventDefault();
        if (!dialogOpen) handleOpenTerminal();
        return;
      }

      // Don't handle other shortcuts if user is typing in an input field
      if (dialogOpen || isEditableElement(e.target)) {
        return;
      }

      if (matchesKeybind(e, KEYBINDS.LOAD_OLDER_MESSAGES) && loadOlderHistory) {
        e.preventDefault();
        loadOlderHistory();
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
    loadOlderHistory,
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
