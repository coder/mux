import React from "react";
import { cn } from "@/common/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { useDrag, useDragLayer, useDrop } from "react-dnd";
import { getEmptyImage } from "react-dnd-html5-backend";
import type { TabType } from "@/browser/types/rightSidebar";

/** Drag type for sidebar tabs */
export const SIDEBAR_TAB_DRAG_TYPE = "SIDEBAR_TAB";

export interface TabDragItem {
  type: typeof SIDEBAR_TAB_DRAG_TYPE;
  tab: TabType;
  sourceTabsetId: string;
  index: number;
}

export interface RightSidebarTabStripItem {
  id: string;
  panelId: string;
  selected: boolean;
  onSelect: () => void;
  label: React.ReactNode;
  tooltip: React.ReactNode;
  disabled?: boolean;
  /** The tab type (used for drag identification) */
  tab: TabType;
}

interface RightSidebarTabStripProps {
  items: RightSidebarTabStripItem[];
  ariaLabel?: string;
  /** Unique ID of this tabset (for drag/drop) */
  tabsetId: string;
  /** Called when a tab is dropped onto this tabset */
  onTabDrop?: (tab: TabType, sourceTabsetId: string) => void;
  /** Called when a tab is reordered within this tabset */
  onTabReorder?: (fromIndex: number, toIndex: number) => void;
}

function getTabName(tab: TabType): string {
  switch (tab) {
    case "costs":
      return "Costs";
    case "review":
      return "Review";
    case "terminal":
      return "Terminal";
    case "stats":
      return "Stats";
  }
}

/**
 * Global drag layer for sidebar tabs.
 * Renders the drag preview at cursor position during any sidebar tab drag.
 * Must be rendered inside a DndProvider.
 */
export const SidebarDragLayer: React.FC = () => {
  const { isDragging, itemType, item, currentOffset } = useDragLayer((monitor) => ({
    isDragging: monitor.isDragging(),
    itemType: monitor.getItemType(),
    item: monitor.getItem<TabDragItem | null>(),
    currentOffset: monitor.getSourceClientOffset(),
  }));

  if (!isDragging || itemType !== SIDEBAR_TAB_DRAG_TYPE || !item || !currentOffset) {
    return null;
  }

  return (
    <div
      className="pointer-events-none fixed top-0 left-0 z-50"
      style={{
        transform: `translate(${currentOffset.x}px, ${currentOffset.y}px)`,
      }}
      data-testid="sidebar-drag-preview"
    >
      <div className="bg-background/95 border-border rounded-md border px-3 py-1 text-xs font-medium shadow">
        {getTabName(item.tab)}
      </div>
    </div>
  );
};

/** Individual draggable tab button */
const DraggableTab: React.FC<{
  item: RightSidebarTabStripItem;
  index: number;
  tabsetId: string;
  onReorder?: (fromIndex: number, toIndex: number) => void;
}> = ({ item, index, tabsetId, onReorder }) => {
  const [dropIndicator, setDropIndicator] = React.useState<"before" | "after" | null>(null);
  const tabRef = React.useRef<HTMLButtonElement | null>(null);
  // Track if a drag occurred to suppress click-to-select after drag ends
  const didDragRef = React.useRef(false);

  const [{ isDragging }, drag, preview] = useDrag<TabDragItem, void, { isDragging: boolean }>(
    () => ({
      type: SIDEBAR_TAB_DRAG_TYPE,
      item: () => {
        didDragRef.current = true;
        return { type: SIDEBAR_TAB_DRAG_TYPE, tab: item.tab, sourceTabsetId: tabsetId, index };
      },
      collect: (monitor) => ({
        isDragging: monitor.isDragging(),
      }),
    })
  );

  React.useEffect(() => {
    preview(getEmptyImage(), { captureDraggingState: true });
  }, [preview]);

  const [{ isOver, canDrop }, drop] = useDrop<
    TabDragItem,
    void,
    { isOver: boolean; canDrop: boolean }
  >(() => ({
    accept: SIDEBAR_TAB_DRAG_TYPE,
    canDrop: (dragItem) => dragItem.sourceTabsetId === tabsetId,
    hover: (dragItem, monitor) => {
      if (!onReorder) return;
      if (!monitor.isOver({ shallow: true })) return;

      if (dragItem.sourceTabsetId !== tabsetId) return;

      const dragIndex = dragItem.index;
      const hoverIndex = index;
      if (dragIndex === hoverIndex) return;

      const el = tabRef.current;
      if (!el) return;

      const hoverBoundingRect = el.getBoundingClientRect();
      const hoverMiddleX = (hoverBoundingRect.right - hoverBoundingRect.left) / 2;
      const clientOffset = monitor.getClientOffset();
      if (!clientOffset) return;

      const hoverClientX = clientOffset.x - hoverBoundingRect.left;

      const nextDropIndicator = hoverClientX < hoverMiddleX ? "before" : "after";
      setDropIndicator((prev) => (prev === nextDropIndicator ? prev : nextDropIndicator));

      // Only move when the cursor crosses half of the hovered tab.
      if (dragIndex < hoverIndex && hoverClientX < hoverMiddleX) return;
      if (dragIndex > hoverIndex && hoverClientX > hoverMiddleX) return;

      onReorder(dragIndex, hoverIndex);
      dragItem.index = hoverIndex;
    },
    collect: (monitor) => ({
      isOver: monitor.isOver({ shallow: true }),
      canDrop: monitor.canDrop(),
    }),
  }));

  React.useEffect(() => {
    if (!isOver) {
      setDropIndicator(null);
    }
  }, [isOver]);

  drag(drop(tabRef));

  const dropIndicatorEl = isOver && canDrop && dropIndicator !== null && (
    <div
      className={cn(
        "pointer-events-none absolute top-0 z-10 h-full w-0.5 bg-accent",
        dropIndicator === "before" ? "-left-1" : "-right-1"
      )}
    />
  );

  const buttonEl = (
    <button
      ref={tabRef}
      className={cn(
        "rounded-md px-3 py-1 text-xs font-medium transition-all duration-150 flex items-baseline gap-1.5 cursor-grab active:cursor-grabbing",
        item.selected
          ? "bg-hover text-foreground"
          : "bg-transparent text-muted hover:bg-hover/50 hover:text-foreground",
        item.disabled && "opacity-50 pointer-events-none",
        isDragging && "opacity-50"
      )}
      onClick={() => {
        // Suppress selection if this click is the mouseup after a drag
        if (didDragRef.current) {
          didDragRef.current = false;
          return;
        }
        item.onSelect();
      }}
      id={item.id}
      role="tab"
      type="button"
      aria-selected={item.selected}
      aria-controls={item.panelId}
      disabled={item.disabled}
    >
      {item.label}
    </button>
  );

  // When dragging, skip the Tooltip wrapper to avoid interference with drag events
  if (isDragging) {
    return (
      <div className="relative">
        {dropIndicatorEl}
        {buttonEl}
      </div>
    );
  }

  // Wrap in Tooltip, but put the button directly under TooltipTrigger
  // so the drag ref on the button receives all pointer events
  return (
    <div className="relative">
      {dropIndicatorEl}
      <Tooltip>
        <TooltipTrigger asChild>{buttonEl}</TooltipTrigger>
        <TooltipContent side="bottom" align="center">
          {item.tooltip}
        </TooltipContent>
      </Tooltip>
    </div>
  );
};

export const RightSidebarTabStrip: React.FC<RightSidebarTabStripProps> = ({
  items,
  ariaLabel = "Sidebar views",
  tabsetId,
  onTabDrop,
  onTabReorder,
}) => {
  // Track if we're dragging from this tabset (for visual feedback on source)
  const isDraggingFromHere = useDragLayer(
    (monitor) =>
      monitor.isDragging() &&
      monitor.getItemType() === SIDEBAR_TAB_DRAG_TYPE &&
      (monitor.getItem<TabDragItem | null>()?.sourceTabsetId ?? "") === tabsetId
  );

  const [{ isOver, canDrop }, drop] = useDrop<
    TabDragItem,
    void,
    { isOver: boolean; canDrop: boolean }
  >(() => ({
    accept: SIDEBAR_TAB_DRAG_TYPE,
    drop: (dragItem) => {
      if (onTabDrop && dragItem.sourceTabsetId !== tabsetId) {
        onTabDrop(dragItem.tab, dragItem.sourceTabsetId);
      }
    },
    canDrop: (dragItem) => dragItem.sourceTabsetId !== tabsetId,
    collect: (monitor) => ({
      isOver: monitor.isOver(),
      canDrop: monitor.canDrop(),
    }),
  }));

  return (
    <div
      ref={drop}
      className={cn(
        "border-border-light flex gap-1 border-b px-2 py-1.5 transition-colors",
        isOver && canDrop && "bg-accent/30",
        isDraggingFromHere && "bg-accent/10"
      )}
      role="tablist"
      aria-label={ariaLabel}
    >
      {items.map((item, index) => (
        <DraggableTab
          key={item.id}
          item={item}
          index={index}
          tabsetId={tabsetId}
          onReorder={onTabReorder}
        />
      ))}
    </div>
  );
};
