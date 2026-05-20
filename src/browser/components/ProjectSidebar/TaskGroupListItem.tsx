import { ChevronRight, EllipsisVertical, Layers3, Trash } from "lucide-react";

import { getSidebarItemPaddingLeft } from "@/browser/components/sidebarItemLayout";
import {
  PositionedMenu,
  PositionedMenuItem,
} from "@/browser/components/PositionedMenu/PositionedMenu";
import { useContextMenuPosition } from "@/browser/hooks/useContextMenuPosition";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { cn } from "@/common/lib/utils";
import {
  formatTaskGroupHeader,
  formatTaskGroupItemsLabel,
  type TaskGroupKind,
} from "@/common/utils/tools/taskGroups";

interface TaskGroupListItemProps {
  groupId: string;
  title: string;
  kind: TaskGroupKind;
  sectionId?: string;
  depth: number;
  totalCount: number;
  visibleCount: number;
  completedCount: number;
  runningCount: number;
  queuedCount: number;
  interruptedCount: number;
  isExpanded: boolean;
  isSelected: boolean;
  isDeleting?: boolean;
  onToggle: () => void;
  onDeleteAll?: (buttonElement: HTMLElement) => void | Promise<void>;
}

export function TaskGroupListItem(props: TaskGroupListItemProps) {
  const paddingLeft = getSidebarItemPaddingLeft(props.depth);
  const hasActionMenu = props.onDeleteAll != null;
  const actionMenu = useContextMenuPosition({
    longPress: hasActionMenu,
    canOpen: () => hasActionMenu && props.isDeleting !== true,
  });
  const itemLabel = formatTaskGroupItemsLabel(props.kind).toLowerCase();
  const deleteAllLabel = `Delete all ${itemLabel}`;
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
      aria-label={`${props.isExpanded ? "Collapse" : "Expand"} task group ${props.title}`}
      data-testid={`task-group-${props.groupId}`}
      className={cn(
        "bg-surface-primary group/task-group relative flex items-start gap-1.5 rounded-l-sm py-2 pr-2 pl-1 select-none transition-all duration-150 hover:bg-surface-secondary",
        props.sectionId != null ? "ml-2" : "ml-0",
        props.isSelected && "bg-surface-secondary"
      )}
      style={{ paddingLeft }}
      onClick={() => {
        if (actionMenu.suppressClickIfLongPress()) {
          return;
        }
        props.onToggle();
      }}
      onContextMenu={hasActionMenu ? actionMenu.onContextMenu : undefined}
      {...(hasActionMenu ? actionMenu.touchHandlers : {})}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onToggle();
        }
      }}
    >
      <span
        aria-hidden="true"
        className="text-muted mt-0.5 -ml-2.5 inline-flex h-4 w-4 shrink-0 items-center justify-center"
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
            {formatTaskGroupHeader(props.kind, props.totalCount, props.title)}
          </span>
          <span
            className={cn(
              "text-muted text-[11px] transition-opacity duration-200",
              hasActionMenu &&
                "group-focus-within/task-group:opacity-0 group-hover/task-group:opacity-0"
            )}
          >
            {props.completedCount}/{props.totalCount}
          </span>
        </div>
        <div className="text-muted flex min-w-0 flex-wrap items-center gap-1.5 text-xs leading-4">
          {statusParts.length > 0 ? (
            statusParts.map((part) => <span key={part}>{part}</span>)
          ) : (
            <span>
              {props.totalCount} {formatTaskGroupItemsLabel(props.kind).toLowerCase()}
            </span>
          )}
        </div>
      </div>
      {hasActionMenu && (
        <button
          type="button"
          aria-label={`Task group actions for ${props.title}`}
          aria-haspopup="menu"
          aria-expanded={actionMenu.isOpen}
          data-testid={`task-group-actions-${props.groupId}`}
          disabled={props.isDeleting === true}
          className={cn(
            "text-muted hover:text-foreground absolute top-2.5 right-2 inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center border-none bg-transparent p-0 opacity-0 transition-[color,opacity] duration-200 group-focus-within/task-group:pointer-events-auto group-focus-within/task-group:opacity-100 group-hover/task-group:pointer-events-auto group-hover/task-group:opacity-100",
            actionMenu.isOpen ? "pointer-events-auto opacity-100" : "pointer-events-none",
            props.isDeleting === true && "cursor-default opacity-50"
          )}
          onKeyDown={stopKeyboardPropagation}
          onClick={(event) => {
            event.stopPropagation();
            actionMenu.onContextMenu(event);
          }}
        >
          <EllipsisVertical className="h-4 w-4 shrink-0" strokeWidth={1.8} />
        </button>
      )}
      <PositionedMenu
        open={hasActionMenu && actionMenu.isOpen}
        onOpenChange={actionMenu.onOpenChange}
        position={actionMenu.position}
        className="w-[180px]"
      >
        <PositionedMenuItem
          icon={<Trash className="h-4 w-4 shrink-0" strokeWidth={1.8} />}
          label={deleteAllLabel}
          variant="destructive"
          disabled={props.isDeleting === true}
          onClick={(event) => {
            actionMenu.close();
            void props.onDeleteAll?.(event.currentTarget);
          }}
        />
      </PositionedMenu>
    </div>
  );
}
