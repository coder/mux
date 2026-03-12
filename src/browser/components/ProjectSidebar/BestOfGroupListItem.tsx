import { ChevronRight, Layers3 } from "lucide-react";

import { cn } from "@/common/lib/utils";

interface BestOfGroupListItemProps {
  groupId: string;
  title: string;
  depth: number;
  totalCount: number;
  visibleCount: number;
  completedCount: number;
  runningCount: number;
  queuedCount: number;
  interruptedCount: number;
  isExpanded: boolean;
  isSelected: boolean;
  onToggle: () => void;
}

function getItemPaddingLeft(depth: number): number {
  return 12 + Math.min(32, Math.max(0, depth)) * 12;
}

export function BestOfGroupListItem(props: BestOfGroupListItemProps) {
  const paddingLeft = getItemPaddingLeft(props.depth);
  const statusParts: string[] = [];
  if (props.runningCount > 0) {
    statusParts.push(`${props.runningCount} running`);
  }
  if (props.queuedCount > 0) {
    statusParts.push(`${props.queuedCount} queued`);
  }
  if (props.completedCount > 0) {
    statusParts.push(`${props.completedCount} completed`);
  }
  if (props.interruptedCount > 0) {
    statusParts.push(`${props.interruptedCount} interrupted`);
  }
  if (props.visibleCount !== props.totalCount) {
    statusParts.push(`${props.visibleCount}/${props.totalCount} visible`);
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={props.isExpanded}
      aria-label={`${props.isExpanded ? "Collapse" : "Expand"} best-of group ${props.title}`}
      data-testid={`best-of-group-${props.groupId}`}
      className={cn(
        "bg-surface-primary relative flex items-start gap-1.5 rounded-l-sm py-2 pr-2 pl-1 select-none transition-all duration-150 hover:bg-surface-secondary",
        props.isSelected && "bg-surface-secondary"
      )}
      style={{ paddingLeft }}
      onClick={() => {
        props.onToggle();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onToggle();
        }
      }}
    >
      <span
        aria-hidden="true"
        className="text-muted mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center"
      >
        <ChevronRight
          className="h-3 w-3 transition-transform duration-150"
          style={{ transform: props.isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
        />
      </span>
      <div className="text-muted mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center">
        <Layers3 className="h-3 w-3" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5">
          <span className="text-foreground min-w-0 truncate text-left text-[14px] leading-6">
            Best of {props.totalCount} · {props.title}
          </span>
          <span className="text-muted text-[11px]">
            {props.completedCount}/{props.totalCount}
          </span>
        </div>
        <div className="text-muted flex min-w-0 flex-wrap items-center gap-1.5 text-xs leading-4">
          {statusParts.length > 0 ? (
            statusParts.map((part) => <span key={part}>{part}</span>)
          ) : (
            <span>{props.totalCount} candidates</span>
          )}
        </div>
      </div>
    </div>
  );
}
