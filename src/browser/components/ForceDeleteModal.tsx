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
} from "@/browser/components/ui/dialog";
import { Button } from "@/browser/components/ui/button";

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

  const handleForceDelete = () => {
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
  };

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open && !isDeleting) {
        onClose();
      }
    },
    [isDeleting, onClose]
  );

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent maxWidth="600px" maxHeight="90vh" showCloseButton={false}>
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
          </Button>
          <Button variant="destructive" onClick={handleForceDelete} disabled={isDeleting}>
            {isDeleting ? "Deleting..." : "Force Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
