import React, { useState, useCallback } from "react";
import { Modal, ModalActions, CancelButton, PrimaryButton } from "./Modal";

interface StartHereModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}

export const StartHereModal: React.FC<StartHereModalProps> = ({ isOpen, onClose, onConfirm }) => {
  const [isExecuting, setIsExecuting] = useState(false);

  const handleCancel = useCallback(() => {
    if (!isExecuting) {
      onClose();
    }
  }, [isExecuting, onClose]);

  const handleConfirm = useCallback(async () => {
    if (isExecuting) return;
    setIsExecuting(true);
    try {
      await onConfirm();
      onClose();
    } catch (error) {
      console.error("Start Here error:", error);
      setIsExecuting(false);
    }
  }, [isExecuting, onConfirm, onClose]);

  return (
    <Modal
      isOpen={isOpen}
      title="Start Here"
      subtitle="This will replace all chat history with this message"
      onClose={handleCancel}
      isLoading={isExecuting}
    >
      <ModalActions className="justify-center">
        <CancelButton onClick={handleCancel} disabled={isExecuting}>
          Cancel
        </CancelButton>
        <PrimaryButton onClick={() => void handleConfirm()} disabled={isExecuting}>
          {isExecuting ? "Starting..." : "OK"}
        </PrimaryButton>
      </ModalActions>
    </Modal>
  );
};
