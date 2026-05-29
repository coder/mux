import React from "react";
import { formatDuration } from "@/common/utils/formatDuration";
import { cn } from "@/common/lib/utils";
import { ExpandIcon } from "@/browser/features/Tools/Shared/ToolPrimitives";
import type { WorkBundleInfo } from "@/browser/utils/messages/transcriptRenderProjection";

interface WorkBundleMessageProps {
  item: WorkBundleInfo;
  expanded: boolean;
  onToggle: () => void;
}

export function WorkBundleMessage(props: WorkBundleMessageProps): React.ReactElement {
  const duration = props.item.durationMs;
  const label =
    props.item.state === "active"
      ? "Working..."
      : duration === undefined
        ? "Worked"
        : `Worked for ${formatDuration(duration, "precise")}`;

  return (
    <button
      type="button"
      data-testid="work-bundle"
      className={cn(
        "text-muted hover:text-foreground flex w-full cursor-pointer items-center gap-2 border-b border-border/60 py-3 text-left text-base transition-colors select-none",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      )}
      aria-expanded={props.expanded}
      onClick={props.onToggle}
    >
      <span className="min-w-0 truncate">{label}</span>
      <ExpandIcon expanded={props.expanded} className="text-muted shrink-0">
        ▶
      </ExpandIcon>
    </button>
  );
}
