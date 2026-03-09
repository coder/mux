import { useEffect, useId, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  WarningBox,
  WarningText,
  WarningTitle,
} from "@/browser/components/Dialog/Dialog";
import { Button } from "@/browser/components/Button/Button";

export interface ProjectDeleteConfirmationModalProps {
  isOpen: boolean;
  projectName: string;
  activeCount: number;
  archivedCount: number;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

type ProjectDeleteConfirmationModalComponentProps = Omit<
  ProjectDeleteConfirmationModalProps,
  "activeCount"
> & {
  activeCount?: number;
};

export function ProjectDeleteConfirmationModal(
  props: ProjectDeleteConfirmationModalComponentProps
) {
  const [typedProjectName, setTypedProjectName] = useState("");
  const [isConfirming, setIsConfirming] = useState(false);
  const confirmationInputId = useId();

  useEffect(() => {
    if (props.isOpen) {
      // Type-to-confirm must always start from a blank input when this dialog opens.
      setTypedProjectName("");
      setIsConfirming(false);
    }
  }, [props.isOpen]);

  const confirmationMatches = typedProjectName === props.projectName;
  // Keep old call sites working while project deletion is rolled out to all workspaces.
  const activeCount = props.activeCount ?? 0;
  const totalCount = activeCount + props.archivedCount;
  const hasActive = activeCount > 0;
  const hasArchived = props.archivedCount > 0;

  const handleConfirm = async () => {
    if (!confirmationMatches || isConfirming) {
      return;
    }

    setIsConfirming(true);
    try {
      await props.onConfirm();
    } finally {
      setIsConfirming(false);
    }
  };

  return (
    <Dialog
      open={props.isOpen}
      onOpenChange={(open) => {
        if (!open) {
          props.onCancel();
        }
      }}
    >
      <DialogContent
        maxWidth="500px"
        showCloseButton={false}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          props.onCancel();
        }}
      >
        <DialogHeader>
          <DialogTitle>Delete &ldquo;{props.projectName}&rdquo;?</DialogTitle>
        </DialogHeader>

        <WarningBox>
          <WarningTitle>Warning</WarningTitle>
          <WarningText>
            This will permanently delete {totalCount} workspace{totalCount !== 1 ? "s" : ""}
            {hasActive &&
              hasArchived &&
              ` (${activeCount} active, ${props.archivedCount} archived)`}
            . All chat transcripts and worktrees will be lost.
          </WarningText>
        </WarningBox>

        <div className="space-y-2">
          <label htmlFor={confirmationInputId} className="text-muted block text-xs font-medium">
            Project name confirmation
          </label>
          <input
            autoFocus
            type="text"
            id={confirmationInputId}
            value={typedProjectName}
            onChange={(event) => {
              setTypedProjectName(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                if (!confirmationMatches || isConfirming) {
                  return;
                }

                event.preventDefault();
                void handleConfirm();
              }
            }}
            placeholder={`Type "${props.projectName}" to confirm`}
            className="border-border-medium bg-modal-bg text-foreground placeholder:text-muted focus:border-accent w-full rounded border px-3 py-2 text-sm focus:outline-none disabled:opacity-50"
            disabled={isConfirming}
          />
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={props.onCancel} disabled={isConfirming}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              void handleConfirm();
            }}
            disabled={!confirmationMatches || isConfirming}
          >
            {isConfirming ? "Deleting..." : "Delete Project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
