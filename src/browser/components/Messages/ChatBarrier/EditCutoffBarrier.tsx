import React from "react";
import { cn } from "@/common/lib/utils";

interface EditCutoffBarrierProps {
  className?: string;
}

/**
 * Barrier shown when editing a message to indicate where the cutoff point is.
 * Messages below this barrier will be removed when the edit is submitted.
 */
export const EditCutoffBarrier: React.FC<EditCutoffBarrierProps> = ({ className }) => {
  return (
    <div className={cn("flex items-center gap-3 py-3 my-4", className)}>
      <div
        className="h-px flex-1"
        style={{
          background: `linear-gradient(to right, transparent, var(--color-edit-mode) 20%, var(--color-edit-mode) 80%, transparent)`,
        }}
      />
      <div className="border-edit-mode/30 bg-edit-mode/10 text-edit-mode flex items-center gap-2 rounded-md border px-3 py-1.5 text-[11px] font-medium">
        <span className="text-sm">⚠️</span>
        <span>Messages below will be removed when you submit</span>
      </div>
      <div
        className="h-px flex-1"
        style={{
          background: `linear-gradient(to right, transparent, var(--color-edit-mode) 20%, var(--color-edit-mode) 80%, transparent)`,
        }}
      />
    </div>
  );
};
