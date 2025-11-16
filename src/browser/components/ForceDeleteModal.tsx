import React, { useState } from "react";
import {
  Modal,
  ModalActions,
  CancelButton,
  DangerButton,
  ErrorSection,
  ErrorLabel,
  ErrorCodeBlock,
  WarningBox,
  WarningTitle,
  WarningText,
} from "./Modal";

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

  return (
    <Modal
      isOpen={isOpen}
      title="Force Delete Workspace?"
      subtitle="The workspace could not be removed normally"
      onClose={onClose}
      maxWidth="600px"
      maxHeight="90vh"
      isLoading={isDeleting}
    >
      <ErrorSection>
        <ErrorLabel>Git Error</ErrorLabel>
        <ErrorCodeBlock>{error}</ErrorCodeBlock>
      </ErrorSection>

      <WarningBox>
        <WarningTitle>This action cannot be undone</WarningTitle>
        <WarningText>
          Force deleting will permanently remove the workspace and{" "}
          {error.includes("unpushed commits:")
            ? "discard the unpushed commits shown above"
            : "may discard uncommitted work or lose data"}
          . This action cannot be undone.
        </WarningText>
      </WarningBox>

      <ModalActions className="justify-center">
        <CancelButton onClick={onClose} disabled={isDeleting}>
          Cancel
        </CancelButton>
        <DangerButton onClick={handleForceDelete} disabled={isDeleting}>
          {isDeleting ? "Deleting..." : "Force Delete"}
        </DangerButton>
      </ModalActions>
    </Modal>
  );
};
