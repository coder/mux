import React, { useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  WarningBox,
  WarningTitle,
  WarningText,
} from "@/browser/components/ui/dialog";
import { Button } from "@/browser/components/ui/button";

interface ConfirmationModalProps {
  isOpen: boolean;
  title: string;
  description?: string;
  /** Warning message shown in red warning box */
  warning?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Called when user confirms. Can be async - buttons will be disabled during execution. */
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

/**
 * Reusable confirmation modal for destructive actions
 */
export const ConfirmationModal: React.FC<ConfirmationModalProps> = (props) => {
  const [isConfirming, setIsConfirming] = useState(false);

  // Extract callbacks to satisfy exhaustive-deps rule
  const onConfirm = props.onConfirm;
  const onCancel = props.onCancel;

  const handleConfirm = useCallback(async () => {
    if (isConfirming) return;
    setIsConfirming(true);
    try {
      await onConfirm();
    } finally {
      setIsConfirming(false);
    }
  }, [isConfirming, onConfirm]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open && !isConfirming) {
        onCancel();
      }
    },
    [isConfirming, onCancel]
  );

  return (
    <Dialog open={props.isOpen} onOpenChange={handleOpenChange}>
      <DialogContent maxWidth="450px" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          {props.description && <DialogDescription>{props.description}</DialogDescription>}
        </DialogHeader>

        {props.warning && (
          <WarningBox>
            <WarningTitle>Warning</WarningTitle>
            <WarningText>{props.warning}</WarningText>
          </WarningBox>
        )}

        <DialogFooter className="justify-center">
          <Button variant="secondary" onClick={onCancel} disabled={isConfirming}>
            {props.cancelLabel ?? "Cancel"}
          </Button>
          <Button
            variant="destructive"
            onClick={() => void handleConfirm()}
            disabled={isConfirming}
          >
            {isConfirming ? "Processing..." : (props.confirmLabel ?? "Confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
