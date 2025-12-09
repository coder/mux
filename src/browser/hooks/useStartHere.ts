import { useState } from "react";
import React from "react";
import { COMPACTED_EMOJI } from "@/common/constants/ui";
import { StartHereModal } from "@/browser/components/StartHereModal";
import { createMuxMessage } from "@/common/types/message";
import { useAPI } from "@/browser/contexts/API";

/**
 * Hook for managing Start Here button state and modal.
 * Returns a button config and modal state management.
 *
 * @param workspaceId - Current workspace ID (required for operation)
 * @param content - Content to use as the new conversation starting point
 * @param isCompacted - Whether the message is already compacted (disables button if true)
 */
export function useStartHere(
  workspaceId: string | undefined,
  content: string,
  isCompacted = false
) {
  const { api } = useAPI();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isStartingHere, setIsStartingHere] = useState(false);

  // Opens the confirmation modal
  const openModal = () => {
    if (!workspaceId || isCompacted) return;
    setIsModalOpen(true);
  };

  // Closes the modal
  const closeModal = () => {
    setIsModalOpen(false);
  };

  // Executes the Start Here operation
  const executeStartHere = async () => {
    if (!workspaceId || isStartingHere || isCompacted || !api) return;

    setIsStartingHere(true);
    try {
      const summaryMessage = createMuxMessage(
        `start-here-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        "assistant",
        content,
        {
          timestamp: Date.now(),
          compacted: true,
        }
      );

      const result = await api.workspace.replaceChatHistory({
        workspaceId,
        summaryMessage,
      });

      if (!result.success) {
        console.error("Failed to start here:", result.error);
      }
    } catch (err) {
      console.error("Start here error:", err);
    } finally {
      setIsStartingHere(false);
    }
  };

  // Pre-configured modal component
  const modal = React.createElement(StartHereModal, {
    isOpen: isModalOpen,
    onClose: closeModal,
    onConfirm: executeStartHere,
  });

  return {
    openModal,
    isStartingHere,
    buttonLabel: `Start Here`,
    buttonEmoji: COMPACTED_EMOJI,
    disabled: !workspaceId || isStartingHere || isCompacted,
    modal, // Pre-configured modal to render
  };
}
