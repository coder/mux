import React from "react";
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
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Reusable confirmation modal for destructive actions
 */
export const ConfirmationModal: React.FC<ConfirmationModalProps> = ({
  isOpen,
  title,
  description,
  warning,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}) => {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent maxWidth="450px" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        {warning && (
          <WarningBox>
            <WarningTitle>Warning</WarningTitle>
            <WarningText>{warning}</WarningText>
          </WarningBox>
        )}

        <DialogFooter className="justify-center">
          <Button variant="secondary" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
