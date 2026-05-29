import { useCallback } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/browser/components/Dialog/Dialog";
import { GoalDefaultsSection } from "@/browser/features/RightSidebar/GoalDefaultsSection";

/**
 * Modal wrapper around `GoalDefaultsSection`. Lets users edit both their
 * per-workspace goal-defaults override AND the global defaults from the
 * same place, without burdening the Goal tab with a permanently-mounted
 * config block. Opened from a small "Change defaults" link next to the
 * pre-filled Budget / Turn cap fields in the create form (and from the
 * active-goal view for editing while a goal is already running).
 *
 * Closing the modal returns focus to whatever opened it via Radix's
 * default behavior; mounting it conditionally (rather than always-mounted
 * with `open` toggling) keeps the underlying API reads from running until
 * the user opens it, so the Goal tab stays cheap.
 */
interface GoalDefaultsModalProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Called whenever the user persists a change to either the workspace
   * override or the global defaults. Lets parent forms re-read effective
   * defaults so their pre-filled Budget / Turn cap inputs stay in sync.
   */
  onPersist?: () => void;
}

export function GoalDefaultsModal(props: GoalDefaultsModalProps) {
  const handleOpenChange = useCallback(
    (open: boolean) => {
      props.onOpenChange(open);
    },
    [props]
  );

  return (
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      <DialogContent maxWidth="32rem">
        <DialogHeader>
          <DialogTitle>Goal defaults</DialogTitle>
          <DialogDescription>
            Defaults apply when you create a goal without an explicit budget or turn cap. Workspace
            values override the global defaults below.
          </DialogDescription>
        </DialogHeader>
        <GoalDefaultsSection workspaceId={props.workspaceId} onPersist={props.onPersist} embedded />
      </DialogContent>
    </Dialog>
  );
}
