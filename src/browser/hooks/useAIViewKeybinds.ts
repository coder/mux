import { useEffect } from "react";
import type { ChatInputAPI } from "@/browser/components/ChatInput";
import { matchesKeybind, KEYBINDS, isEditableElement } from "@/browser/utils/ui/keybinds";
import { getLastThinkingByModelKey, getModelKey } from "@/common/constants/storage";
import { updatePersistedState, readPersistedState } from "@/browser/hooks/usePersistedState";
import type { ThinkingLevel, ThinkingLevelOn } from "@/common/types/thinking";
import { DEFAULT_THINKING_LEVEL } from "@/common/types/thinking";
import { getThinkingPolicyForModel } from "@/browser/utils/thinking/policy";
import { getDefaultModel } from "@/browser/hooks/useModelLRU";
import type { StreamingMessageAggregator } from "@/browser/utils/messages/StreamingMessageAggregator";
import { isCompactingStream, cancelCompaction } from "@/browser/utils/compaction/handler";
import { useAPI } from "@/browser/contexts/API";

interface UseAIViewKeybindsParams {
  workspaceId: string;
  currentModel: string | null;
  canInterrupt: boolean;
  showRetryBarrier: boolean;
  currentWorkspaceThinking: ThinkingLevel;
  setThinkingLevel: (level: ThinkingLevel) => void;
  setAutoRetry: (value: boolean) => void;
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
 * - Ctrl+Shift+T: Toggle thinking level
 * - Ctrl+G: Jump to bottom
 * - Ctrl+T: Open terminal
 * - Ctrl+Shift+E: Open in editor
 * - Ctrl+C (during compaction in vim mode): Cancel compaction, restore command
 *
 * Note: In vim mode, Ctrl+C always interrupts streams. Use vim yank (y) commands for copying.
 */
export function useAIViewKeybinds({
  workspaceId,
  currentModel,
  canInterrupt,
  showRetryBarrier,
  currentWorkspaceThinking,
  setThinkingLevel,
  setAutoRetry,
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
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check vim-aware interrupt keybind
      const interruptKeybind = vimEnabled
        ? KEYBINDS.INTERRUPT_STREAM_VIM
        : KEYBINDS.INTERRUPT_STREAM_NORMAL;

      // Interrupt stream: Ctrl+C in vim mode, Esc in normal mode
      // Only intercept if actively compacting (otherwise allow browser default for copy in vim mode)
      if (matchesKeybind(e, interruptKeybind)) {
        if (canInterrupt && aggregator && isCompactingStream(aggregator)) {
          // Ctrl+C during compaction: restore original state and enter edit mode
          // Stores cancellation marker in localStorage (persists across reloads)
          e.preventDefault();
          if (api) {
            void cancelCompaction(api, workspaceId, aggregator, (messageId, command) => {
              setEditingMessage({ id: messageId, content: command });
            });
          }
          setAutoRetry(false);
          return;
        }

        // Normal stream interrupt (non-compaction)
        // Vim mode: Ctrl+C always interrupts (vim uses yank for copy, not Ctrl+C)
        // Non-vim mode: Esc always interrupts
        if (canInterrupt || showRetryBarrier) {
          e.preventDefault();
          setAutoRetry(false); // User explicitly stopped - don't auto-retry
          void api?.workspace.interruptStream({ workspaceId });
          return;
        }
      }

      // Focus chat input works anywhere (even in input fields)
      if (matchesKeybind(e, KEYBINDS.FOCUS_CHAT)) {
        e.preventDefault();
        chatInputAPI.current?.focus();
        return;
      }

      // Toggle thinking works even when focused in input fields
      if (matchesKeybind(e, KEYBINDS.TOGGLE_THINKING)) {
        e.preventDefault();

        // Get selected model from localStorage (what user sees in UI)
        // Fall back to message history model, then to most recent model from LRU
        // This matches the same logic as useSendMessageOptions
        const selectedModel = readPersistedState<string | null>(getModelKey(workspaceId), null);
        const modelToUse = selectedModel ?? currentModel ?? getDefaultModel();

        // Storage key for remembering this model's last-used active thinking level
        const lastThinkingKey = getLastThinkingByModelKey(modelToUse);

        // Special-case: if model has single-option policy (e.g., gpt-5-pro only supports HIGH),
        // the toggle is a no-op to avoid confusing state transitions.
        const allowed = getThinkingPolicyForModel(modelToUse);
        if (allowed.length === 1) {
          return; // No toggle for single-option policies
        }

        if (currentWorkspaceThinking !== "off") {
          // Thinking is currently ON - save the level for this model and turn it off
          // Type system ensures we can only store active levels (not "off")
          const activeLevel: ThinkingLevelOn = currentWorkspaceThinking;
          updatePersistedState(lastThinkingKey, activeLevel);
          setThinkingLevel("off");
        } else {
          // Thinking is currently OFF - restore the last level used for this model
          const lastUsedThinkingForModel = readPersistedState<ThinkingLevelOn>(
            lastThinkingKey,
            DEFAULT_THINKING_LEVEL
          );
          setThinkingLevel(lastUsedThinkingForModel);
        }
        return;
      }

      // Open in editor / terminal - work even in input fields (global feel, like TOGGLE_MODE)
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

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    jumpToBottom,
    handleOpenTerminal,
    handleOpenInEditor,
    workspaceId,
    canInterrupt,
    showRetryBarrier,
    setAutoRetry,
    currentModel,
    currentWorkspaceThinking,
    setThinkingLevel,
    chatInputAPI,
    aggregator,
    setEditingMessage,
    vimEnabled,
    api,
  ]);
}
