import React from "react";
import { cn } from "@/common/lib/utils";
import type { DisplayedMessage } from "@/common/types/message";

interface CompactionBoundaryMessageProps {
  message: Extract<DisplayedMessage, { type: "compaction-boundary" }>;
  className?: string;
}

export const CompactionBoundaryMessage: React.FC<CompactionBoundaryMessageProps> = ({
  message,
  className,
}) => {
  const epochLabel =
    typeof message.compactionEpoch === "number" ? ` #${message.compactionEpoch}` : "";
  const label =
    message.position === "start"
      ? `Compaction boundary${epochLabel}`
      : `Resume after compaction${epochLabel}`;

  return (
    <div
      className={cn(
        "my-4 flex items-center gap-3 text-[11px] uppercase tracking-[0.08em]",
        className
      )}
      data-testid="compaction-boundary"
      aria-label={label}
    >
      <span className="bg-border h-px flex-1" />
      <span className="text-muted font-medium">{label}</span>
      <span className="bg-border h-px flex-1" />
    </div>
  );
};
