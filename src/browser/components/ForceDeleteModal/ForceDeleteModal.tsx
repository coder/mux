import React, { useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  ErrorSection,
  ErrorLabel,
  ErrorCodeBlock,
  WarningBox,
  WarningTitle,
  WarningText,
} from "@/browser/components/Dialog/Dialog";
import { Button } from "@/browser/components/Button/Button";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { isEditableElement, KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";

interface ForceDeleteModalProps {
  isOpen: boolean;
  workspaceId: string;
  error: string;
  onClose: () => void;
  onForceDelete: (workspaceId: string) => Promise<void>;
}

export const ForceDeleteModal: React.FC<ForceDeleteModalProps> = ({
  isOpen,
  workspaceId,
  error,
  onClose,
  onForceDelete,
}) => {
  const [isDeleting, setIsDeleting] = useState(false);

  const handleForceDelete = useCallback(() => {
    setIsDeleting(true);
    void (async () => {
      try {
        await onForceDelete(workspaceId);
        onClose();
      } catch (err) {
        console.error("Force delete failed:", err);
      } finally {
        setIsDeleting(false);
      }
    })();
  }, [onForceDelete, workspaceId, onClose]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open && !isDeleting) {
        onClose();
      }
    },
    [isDeleting, onClose]
  );

  const handleDialogKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isEditableElement(e.target)) return;

      // Block all global shortcuts while dialog is active.
      // Radix handles Escape in capture phase (via onEscapeKeyDown) before this fires.
      stopKeyboardPropagation(e);

      if (isDeleting) return;

      if (matchesKeybind(e, KEYBINDS.CONFIRM_DIALOG_YES)) {
        e.preventDefault();
        handleForceDelete();
      } else if (matchesKeybind(e, KEYBINDS.CONFIRM_DIALOG_NO)) {
        e.preventDefault();
        onClose();
      }
    },
    [isDeleting, handleForceDelete, onClose]
  );

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        maxWidth="600px"
        maxHeight="90vh"
        showCloseButton={false}
        onKeyDown={handleDialogKeyDown}
      >
        <DialogHeader>
          <DialogTitle>Force Delete Workspace?</DialogTitle>
          <DialogDescription>The workspace could not be removed normally</DialogDescription>
        </DialogHeader>
        <ErrorSection>
          <ErrorLabel>Git Error</ErrorLabel>
          <ErrorCodeBlock>{error}</ErrorCodeBlock>
        </ErrorSection>

        <WarningBox>
          <WarningTitle>This action cannot be undone</WarningTitle>
          <WarningText>
            Force deleting will permanently remove the workspace and its local branch, and{" "}
            {error.includes("unpushed commits:")
              ? "discard the unpushed commits shown above"
              : "may discard uncommitted work or lose data"}
            . This action cannot be undone.
          </WarningText>
        </WarningBox>

        <DialogFooter className="justify-center">
          <Button variant="secondary" onClick={onClose} disabled={isDeleting}>
            Cancel
            <span
              aria-hidden="true"
              className="ml-2 inline-flex items-center rounded border border-current/25 px-1.5 py-0.5 font-mono text-[10px] leading-none opacity-60"
            >
              N
            </span>
          </Button>
          <Button variant="destructive" onClick={handleForceDelete} disabled={isDeleting}>
            {isDeleting ? "Deleting..." : "Force Delete"}
            <span
              aria-hidden="true"
              className="ml-2 inline-flex items-center rounded border border-current/25 px-1.5 py-0.5 font-mono text-[10px] leading-none opacity-60"
            >
              Y
            </span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
