import React, { useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/browser/components/ui/dialog";
import { Button } from "@/browser/components/ui/button";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { isEditableElement, KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";

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

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open && !isExecuting) {
        handleCancel();
      }
    },
    [isExecuting, handleCancel]
  );

  const handleDialogKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isEditableElement(e.target)) return;

      // Block all global shortcuts while dialog is active.
      // Radix handles Escape in capture phase (via onEscapeKeyDown) before this fires.
      stopKeyboardPropagation(e);

      if (isExecuting) return;

      if (matchesKeybind(e, KEYBINDS.CONFIRM_DIALOG_YES)) {
        e.preventDefault();
        void handleConfirm();
      } else if (matchesKeybind(e, KEYBINDS.CONFIRM_DIALOG_NO)) {
        e.preventDefault();
        handleCancel();
      }
    },
    [isExecuting, handleConfirm, handleCancel]
  );

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={false} onKeyDown={handleDialogKeyDown}>
        <DialogHeader>
          <DialogTitle>Start Here</DialogTitle>
          <DialogDescription>
            This will start a new context from this message and preserve earlier chat history.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="justify-center">
          <Button variant="secondary" onClick={handleCancel} disabled={isExecuting}>
            Cancel
            <span
              aria-hidden="true"
              className="border-border-medium text-muted ml-2 inline-flex items-center rounded border px-1 py-[1px] font-mono text-[10px] leading-none"
            >
              N
            </span>
          </Button>
          <Button onClick={() => void handleConfirm()} disabled={isExecuting}>
            {isExecuting ? "Starting..." : "OK"}
            <span
              aria-hidden="true"
              className="border-border-medium text-muted ml-2 inline-flex items-center rounded border px-1 py-[1px] font-mono text-[10px] leading-none"
            >
              Y
            </span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
