import React from "react";
import { cn } from "@/common/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/ui/tooltip";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useDroppable, useDndContext } from "@dnd-kit/core";

/** Data attached to dragged dock tabs */
export interface DockTabDragData<PaneId extends string> {
  tab: PaneId;
  sourceTabsetId: string;
  index: number;
}

export interface DockLayoutTabStripItem<PaneId extends string> {
  id: string;
  panelId: string;
  selected: boolean;
  onSelect: () => void;
  label: React.ReactNode;
  tooltip?: React.ReactNode;
  disabled?: boolean;
  tab: PaneId;
  onClose?: () => void;
}

interface DockLayoutTabStripProps<PaneId extends string> {
  items: Array<DockLayoutTabStripItem<PaneId>>;
  ariaLabel?: string;
  tabsetId: string;
  trailing?: React.ReactNode;
}

function SortableTab<PaneId extends string>(props: {
  item: DockLayoutTabStripItem<PaneId>;
  index: number;
  tabsetId: string;
}) {
  const sortableId = `${props.tabsetId}:${props.item.tab}`;

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableId,
    disabled: props.item.disabled,
    data: {
      tab: props.item.tab,
      sourceTabsetId: props.tabsetId,
      index: props.index,
    } satisfies DockTabDragData<PaneId>,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div className="relative shrink-0" style={style}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            ref={setNodeRef}
            {...attributes}
            {...listeners}
            className={cn(
              "flex min-w-0 max-w-[320px] items-baseline gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium transition-all duration-150",
              "cursor-grab touch-none active:cursor-grabbing",
              props.item.selected
                ? "bg-hover text-foreground"
                : "bg-transparent text-muted hover:bg-hover/50 hover:text-foreground",
              props.item.disabled && "pointer-events-none opacity-50",
              isDragging && "cursor-grabbing opacity-50"
            )}
            onClick={props.item.onSelect}
            onAuxClick={(e) => {
              if (e.button === 1 && props.item.onClose) {
                e.preventDefault();
                props.item.onClose();
              }
            }}
            id={props.item.id}
            role="tab"
            type="button"
            aria-selected={props.item.selected}
            aria-controls={props.item.panelId}
            disabled={props.item.disabled}
          >
            {props.item.label}
          </button>
        </TooltipTrigger>
        {props.item.tooltip && (
          <TooltipContent side="bottom" align="center">
            {props.item.tooltip}
          </TooltipContent>
        )}
      </Tooltip>
    </div>
  );
}

export function DockLayoutTabStrip<PaneId extends string>(props: DockLayoutTabStripProps<PaneId>) {
  const { active } = useDndContext();
  const activeData = active?.data.current as DockTabDragData<PaneId> | undefined;

  const isDraggingFromHere = activeData?.sourceTabsetId === props.tabsetId;

  // Make the tabstrip a drop target for tabs from OTHER tabsets
  const { setNodeRef, isOver } = useDroppable({
    id: `tabstrip:${props.tabsetId}`,
    data: { tabsetId: props.tabsetId },
  });

  const canDrop = activeData !== undefined && activeData.sourceTabsetId !== props.tabsetId;
  const showDropHighlight = isOver && canDrop;

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "border-border-light flex min-w-0 items-center border-b px-2 py-1.5 transition-colors",
        showDropHighlight && "bg-accent/30",
        isDraggingFromHere && "bg-accent/10"
      )}
      role="tablist"
      aria-label={props.ariaLabel ?? "Tabs"}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {props.items.map((item, index) => (
          <SortableTab key={item.id} item={item} index={index} tabsetId={props.tabsetId} />
        ))}
        {props.trailing}
      </div>
    </div>
  );
}
